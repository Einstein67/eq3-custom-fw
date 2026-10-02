/**
 * The object walk, on bytes whose meaning is known — this device's two sets as each radio version
 * airs them, and the BTHome objects it does not send, decoded the way Home Assistant does
 * (`bthome_objects.js` is generated from its `bthome-ble` library).
 *
 * The crypto half is held to the Python decoder by `bthome.test.mjs`; this is the decode half.
 */
import { expect, test } from 'bun:test'

import { decodeObjects } from './bthome.js'

const bytes = (s: string) => new Uint8Array(s.replace(/ /g, '').match(/../g)!.map((h) => parseInt(h, 16)))

test("2.01's flag set: connectivity sits in id order and everything after it still decodes", () => {
  const d = decodeObjects(bytes('09 00 0f 00 15 00 19 01 1f 01 2d 01'))
  expect(d.unknown).toEqual([])
  expect(d.values).toEqual({
    count: 0,
    generic: false,
    battery_low: false,
    connectivity: true,
    lock: true, // UNLOCKED, as Home Assistant reads BTHome's lock
    window: true,
  })
})

test("2.00's flag set, which has no connectivity object, still decodes whole", () => {
  const d = decodeObjects(bytes('09 00 0f 00 15 00 1f 01 2d 00'))
  expect(d.unknown).toEqual([])
  expect(Object.keys(d.values)).toEqual(['count', 'generic', 'battery_low', 'lock', 'window'])
})

test('the measurement set keeps its two 0x02 temperatures apart by position', () => {
  const d = decodeObjects(bytes('02 9a0b 02 7805 0c de0c 2f 00'))
  expect(d.values).toEqual({ temperature: 29.7, 'temperature #2': 14, voltage: 3.294, moisture: 0 })
})

test('objects this device does not send are decoded the way Home Assistant does', () => {
  const d = decodeObjects(
    bytes(
      '45 ffff' + //            temperature, 0.1 signed: -0.1
        '53 03 616263' + //     text, its own length byte
        '54 02 dead' + //       raw, its own length byte
        '3a 01' + //            button: press
        '3c 01 03' + //         dimmer: rotate_left x3
        '3b 01 02 05' + //      command: length byte's low 5 bits are the args -> opcode 02, arg 05
        'f1 01020304', //       firmware version, most significant byte last
    ),
  )
  expect(d.unknown).toEqual([])
  expect(d.values).toEqual({
    temperature: -0.1,
    text: 'abc',
    raw: 'dead',
    button: 'press',
    dimmer: 'rotate_left x3',
    command: '0205',
    firmware_version: '4.3.2.1',
  })
})

test('an unknown id stops the walk, as Home Assistant does, rather than guessing a length', () => {
  const d = decodeObjects(bytes('2d 01 ee 01 02 15 01'))
  expect(d.values).toEqual({ window: true })
  expect(d.unknown).toEqual([0xee])
})

test('a truncated object is reported, not read past the end', () => {
  expect(decodeObjects(bytes('02 9a')).unknown).toEqual([0x02])
  expect(decodeObjects(bytes('53 05 6162')).unknown).toEqual([0x53])
})
