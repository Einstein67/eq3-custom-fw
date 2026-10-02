// Read the device's BThome broadcast in the browser: decrypt it, decode it.
//
// WHY THIS FILE IS PLAIN JS IN A TYPESCRIPT APP. It is proven — `bthome.test.mjs` holds it to the
// Python decoder (`ble_chip/mod/bthome_crypto.py` + `ble_chip/tools/scan_bthome.py`) on real adverts
// captured off the air, so the two implementations are held to each other rather than each being
// plausible on its own. Rewriting a passing decoder to gain types inside a module nothing reaches
// into would be risk for nothing; `bthome.d.ts` gives every caller full types without touching it.
//
// WHY IT IS SEPARATE FROM ANY COMPONENT. Pure functions over bytes, no DOM and no Web Bluetooth,
// which is the only reason it can be tested at all. The browser half — permissions,
// `watchAdvertisements()`, the re-arm — cannot be tested headlessly and lives in `advert.ts`.
//
// THERE IS NO AES-CCM IN WEBCRYPTO, and that is the whole reason this is 60 lines instead of 3.
// SubtleCrypto ships CTR, CBC, GCM and KW; CCM is not in the spec, and node's `aes-128-ccm` would
// pass a test here and fail in the browser. So CCM is built from the two primitives that ARE
// available -- CTR for the keystream, CBC for the MAC -- which is what CCM is defined as anyway.
// Parameters are fixed by BThome v2 and are not runtime choices: M = 4 (a 4-byte tag), L = 2.
//
// THE NONCE NEEDS THE DEVICE'S MAC, WHICH THE BROWSER WILL NOT GIVE US. `device.id` is an opaque,
// origin-scoped identifier by design, and no Web Bluetooth API returns a BD_ADDR. So an ENCRYPTED
// device cannot be read by a page that has not been told its address -- the page must take the MAC
// and the bind key from the owner and remember them. A device with no bind key airs plain BThome and
// needs neither. This is a platform limit, not something to work around.

import { BTHOME_OBJECTS } from "./bthome_objects.js";

const CCM_M = 4;                         // tag length, bytes -- BThome v2
const CCM_L = 2;                         // length field, bytes -- so the nonce is 15 - L = 13

const u8 = (a) => new Uint8Array(a);
export const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
export const unhex = (s) => u8(s.match(/../g).map((x) => parseInt(x, 16)));

/** MAC in PRINTED order (00:1a:22:...), i.e. the reverse of the air bytes. Getting this backwards
 *  produces a tag mismatch, which is indistinguishable from a wrong key -- see decryptAdvert. */
export const macBytes = (s) => unhex(s.replace(/[^0-9a-fA-F]/g, ""));

async function importKey(raw, alg) {
  return crypto.subtle.importKey("raw", raw, { name: alg }, false, ["encrypt"]);
}

/** AES-CTR keystream applied to `data`, counter starting at block `ctr0` (16 B). */
async function ctr(keyRaw, ctr0, data) {
  const k = await importKey(keyRaw, "AES-CTR");
  const out = await crypto.subtle.encrypt(
    { name: "AES-CTR", counter: ctr0, length: CCM_L * 8 }, k, data);
  return u8(out);
}

/** CBC-MAC over `data` (already a multiple of 16), IV zero.
 *  WebCrypto's AES-CBC always appends a PKCS#7 block on encrypt, so the MAC is the SECOND-TO-LAST
 *  block of the output, not the last. Taking the last one yields a plausible wrong tag. */
async function cbcMac(keyRaw, data) {
  const k = await importKey(keyRaw, "AES-CBC");
  const out = u8(await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: new Uint8Array(16) }, k, data));
  return out.slice(out.length - 32, out.length - 16);
}

/** The CCM counter block for index `i`, and the B0 block for a message of `n` plaintext bytes. */
const ccmA = (nonce, i) => { const b = new Uint8Array(16); b[0] = CCM_L - 1; b.set(nonce, 1);
                             b[15] = i & 0xff; b[14] = (i >> 8) & 0xff; return b; };
const ccmB0 = (nonce, n) => { const b = new Uint8Array(16);
                              b[0] = 8 * ((CCM_M - 2) / 2) + (CCM_L - 1); // Adata=0 | M' | L'
                              b.set(nonce, 1);
                              b[14] = (n >> 8) & 0xff; b[15] = n & 0xff; return b; };

/** The tag over `plain`: CBC-MAC of B0 || plaintext, zero-padded to whole blocks, XOR the S0
 *  keystream. Adata = 0 throughout here, so there is no length-prefixed AAD block. */
async function ccmTag(keyRaw, nonce, plain) {
  const padded = new Uint8Array(16 + Math.ceil(plain.length / 16) * 16);
  padded.set(ccmB0(nonce, plain.length)); padded.set(plain, 16);
  const t = (await cbcMac(keyRaw, padded)).slice(0, CCM_M);
  const s0 = (await ctr(keyRaw, ccmA(nonce, 0), new Uint8Array(16))).slice(0, CCM_M);
  return u8(t.map((x, i) => x ^ s0[i]));
}

/**
 * THE ONE AES-CCM IN THIS APP. Both things this device encrypts use it — the BThome broadcast below,
 * and the sealed command envelope in `sealed.ts` — differing only in how the nonce is built and what
 * the bytes mean, exactly as `ble_chip/mod/bthome_crypto.py` keeps them. One primitive, so a host
 * cannot end up with two implementations of it that agree on the easy cases.
 */
export async function ccmSeal(keyRaw, nonce, plain) {
  return { ct: await ctr(keyRaw, ccmA(nonce, 1), plain), mic: await ccmTag(keyRaw, nonce, plain) };
}

/** The inverse. THROWS on a bad tag, which is the normal way any of this fails. */
export async function ccmOpen(keyRaw, nonce, ct, mic, what) {
  const plain = await ctr(keyRaw, ccmA(nonce, 1), ct);
  const want = await ccmTag(keyRaw, nonce, plain);
  for (let i = 0; i < CCM_M; i++) if (want[i] !== mic[i]) throw new Error(what);
  return plain;
}

/** Decrypt one BThome v2 service-data payload.
 *  `payload` is what the browser hands over as serviceData: [device_info][ciphertext][counter 4 LE][mic 4].
 *  Returns {objects, counter}. THROWS on a bad tag -- and a bad tag is the normal way this fails:
 *  a wrong key, a wrong MAC and a corrupted advert are indistinguishable here, so a caller must never
 *  report "not advertising" on it. That conflation is the most expensive wrong conclusion this
 *  project has drawn. */
export async function decryptAdvert(keyRaw, mac, payload) {
  const ct = payload.slice(1, -8);
  const ctrBytes = payload.slice(-8, -4);
  const mic = payload.slice(-4);
  const nonce = u8([...mac, 0xd2, 0xfc, payload[0], ...ctrBytes]);   // 6 + 2 + 1 + 4 = 13
  const plain = await ccmOpen(keyRaw, nonce, ct, mic,
    "BThome tag mismatch -- wrong key, wrong MAC, or a corrupted advert. "
    + "It does NOT mean the device stopped advertising.");
  return { objects: plain, counter: new DataView(ctrBytes.buffer, ctrBytes.byteOffset).getUint32(0, true) };
}

// ---- objects -------------------------------------------------------------------------------
// THE TABLE IS HOME ASSISTANT'S, generated into `bthome_objects.js` from the `bthome-ble` library
// (webapp/tools/gen_bthome_objects.py), so every id is walked, named and scaled the way Home Assistant
// does it. The Python decoder (ble_chip/tools/scan_bthome.py) reads the same file. The names are the
// sensor's device class -- `count`, `generic`, `moisture`, `lock` -- and what THIS device puts in an
// object (0x09 is the mode, 0x2F the valve) is a label above the decoder, in readings.ts.
// `lock` is BTHome's binary sensor: true = UNLOCKED, as in Home Assistant.
const T = BTHOME_OBJECTS;
const leInt = (b, i, n, signed) => {
  let v = 0;
  for (let k = n - 1; k >= 0; k--) v = v * 256 + b[i + k];
  return signed && n > 0 && b[i + n - 1] & 0x80 ? v - 2 ** (8 * n) : v;
};
const hexOf = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** One object's value from its data bytes `d`, per its table entry `o`. */
function valueOf(o, d) {
  switch (o.kind) {
    case "binary": return d[0] !== 0;
    case "text": return new TextDecoder().decode(d);
    case "raw": return hexOf(d);
    case "timestamp": return leInt(d, 0, d.length, false);
    case "info":
      return o.name === "firmware_version" ? [...d].reverse().join(".") : leInt(d, 0, d.length, false);
    case "event":
      if (o.name === "button") return T.events.button[d[0]] ?? "none";
      if (o.name === "dimmer") return `${T.events.dimmer[d[0]] ?? "none"} x${d[1]}`;
      return hexOf(d);                                   // command: opcode + args, as HA shows them
    default: {
      const v = leInt(d, 0, d.length, o.signed) * o.factor;
      return Math.round(v * 1e6) / 1e6;                  // 2071 * 0.01 is 20.71, not 20.710000000000001
    }
  }
}

/** Decode a plaintext object run. Returns the objects in WIRE ORDER as well as by name.
 *
 *  ORDER IS LOAD-BEARING, NOT DECORATION. One set carries the room temperature and the TARGET
 *  temperature under the same id `0x02`, told apart only by which comes first -- so a caller that
 *  indexes by id alone gets one of them at random. `list` preserves the wire order; `values` gives
 *  the first occurrence its plain name and any repeat a `#2` suffix, so neither is silently lost.
 *
 *  An UNKNOWN id stops the walk rather than being skipped, as Home Assistant's parser does: the
 *  table is what gives each object its length, so guessing past one would reinterpret every
 *  following byte. Text, raw and command objects carry their own length byte after the id. */
export function decodeObjects(plain) {
  const values = {}; const list = []; const unknown = [];
  let i = 0;
  while (i < plain.length) {
    const id = plain[i];
    const o = T.objects["0x" + id.toString(16).padStart(2, "0")];
    if (!o) { unknown.push(id); break; }
    let start = i + 1, len = o.len;
    if (len === null) {                                  // a length byte follows the id
      if (start >= plain.length) { unknown.push(id); break; }
      len = o.name === "command" ? 1 + (plain[start] & 0x1f) : plain[start];
      start += 1;
    }
    if (start + len > plain.length) { unknown.push(id); break; }
    const v = valueOf(o, plain.slice(start, start + len));
    list.push({ id, name: o.name, value: v });
    values[o.name in values ? o.name + " #2" : o.name] = v;
    i = start + len;
  }
  return { values, list, unknown };
}

/** device_info bit 0 = the objects are encrypted. */
export const isEncrypted = (payload) => !!(payload[0] & 0x01);
