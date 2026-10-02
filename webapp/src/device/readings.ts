/**
 * Every value the broadcast carries, in words — the one place that names them for a person.
 *
 * THE DECODER'S NAMES ARE HOME ASSISTANT'S AND NOT LABELS. `moisture`, `generic` and `count` are
 * the BTHome device classes a reading arrived under (`bthome_objects.js`), which is what a bug report
 * and a Home Assistant entity share; `valve`, `boost` and `mode` are what this thermostat puts in
 * them and what somebody reading their radiator wants. Booleans are the same problem twice over —
 * `true` under `window` is not an answer, `open` is, and `true` under `lock` means UNLOCKED.
 *
 * **IT IS SHARED BECAUSE TWO VIEWS SHOW THE SAME FIELDS**: the saved list, where every row is a
 * thermostat nothing is connected to, and the Status tab. Two renderings of one payload let a field
 * read `generic true` in one and `Boost on` in the other.
 *
 * **AN UNKNOWN OBJECT IS SHOWN, NEVER DROPPED.** A reading this table has no row for still appears,
 * under its wire name — because the alternative is a value the device is airing and the app hides,
 * which is indistinguishable from the device not sending it.
 */
import type { BthomeValue } from './bthome.js'
import { MODES } from './status'

/**
 * What a view knows that the broadcast cannot say: whether THIS app holds the thermostat's link.
 * The broadcast's connectivity says only that something does.
 */
export type ReadingContext = { self: boolean }
const NOT_SELF: ReadingContext = { self: false }

type Spec = {
  /** What a person calls it. */
  label: string
  /** How the value reads. Booleans get both states, never "true"/"false". */
  fmt: (v: BthomeValue, ctx: ReadingContext) => string
  /**
   * True when this value is not worth a line in a COMPACT view — and it is only ever a WARNING
   * that is not warning. A battery that is fine and a problem that is not happening are the
   * absence of news, and printing "battery none" on every saved row buries the readings that are
   * news. "window closed" and "boost off" are never quiet: they are facts about the thermostat
   * rather than the lack of a fault.
   *
   * The FULL table shows them anyway, because there the point is that every field has a line.
   */
  quiet?: (v: BthomeValue) => boolean
}

/**
 * Keyed on the decoder's own names (`bthome.js`'s `OBJECTS`), and the ORDER here is the order they
 * are shown in — readings first, then the flags, then the housekeeping counters.
 */
const SPECS: Record<string, Spec> = {
  // CURRENT, NOT ROOM `[owner]` — the thermostat's own word for it. Its menu page calls this screen
  // `cUr` and the idle panel marks the reading with a lowercase `c`, so the app and the glass name
  // the same number the same way instead of a person having to work out that they match.
  temperature: { label: 'current', fmt: (v) => `${(v as number).toFixed(1)}°` },
  'temperature #2': { label: 'target', fmt: (v) => `${(v as number).toFixed(1)}°` },
  moisture: { label: 'valve', fmt: (v) => `${v as number}%` },
  voltage: { label: 'battery', fmt: (v) => `${(v as number).toFixed(2)} V` },
  battery: { label: 'battery level', fmt: (v) => `${v as number}%` },
  battery_low: { label: 'battery', fmt: (v) => (v ? 'LOW' : 'ok'), quiet: (v) => !v },
  // THE THERMOSTAT TAKES ONE CONNECTION, and this says who has it `[owner]`. Our own link is
  // known here rather than read from the broadcast, which lags a connect by up to a flag-set
  // round; the broadcast is what tells "nobody" from "something else", usually Home Assistant.
  connectivity: {
    label: 'connected',
    fmt: (v, ctx) => (ctx.self ? 'yes (you)' : v ? 'yes (not you)' : 'no'),
  },
  window: { label: 'window', fmt: (v) => (v ? 'open' : 'closed') },
  // BTHome's lock, as Home Assistant reads it: true = UNLOCKED.
  lock: { label: 'buttons', fmt: (v) => (v ? 'unlocked' : 'locked') },
  generic: { label: 'boost', fmt: (v) => (v ? 'on' : 'off') },
  power_detected: { label: 'power', fmt: (v) => (v ? 'on' : 'off') },
  running: { label: 'running', fmt: (v) => (v ? 'yes' : 'no') },
  problem: { label: 'problem', fmt: (v) => (v ? 'yes' : 'none'), quiet: (v) => !v },
  garage_door: { label: 'garage door', fmt: (v) => (v ? 'open' : 'closed') },
  // The device class is `count` because that is the BTHome object the radio borrows; the value is
  // the thermostat's mode, and it is the same two bits the status reply carries.
  count: { label: 'mode', fmt: (v) => MODES[v as number] ?? String(v) },
  button: { label: 'button', fmt: (v) => String(v) },
  dimmer: { label: 'dimmer', fmt: (v) => String(v) },
  packet_id: { label: 'packet', fmt: (v) => String(v) },
}

const ORDER = Object.keys(SPECS)

export type Reading = { key: string; label: string; text: string }

/**
 * Every value present, described. Known fields come in `SPECS` order; anything this table does not
 * know follows.
 */
export function describeValues(
  values: Record<string, BthomeValue>,
  ctx: ReadingContext = NOT_SELF,
): Reading[] {
  const known = ORDER.filter((k) => k in values && !SPECS[k]!.quiet?.(values[k]!)).map((k) => ({
    key: k,
    label: SPECS[k]!.label,
    text: SPECS[k]!.fmt(values[k]!, ctx),
  }))
  return [...known, ...unknownOf(values)]
}

/** Anything the table has no row for, under its wire name. Never dropped — see the header. */
const unknownOf = (values: Record<string, BthomeValue>): Reading[] =>
  Object.keys(values)
    .filter((k) => !(k in SPECS))
    .map((k) => ({ key: k, label: k, text: String(values[k]) }))

/**
 * WHAT THIS THERMOSTAT AIRS — the two alternating object sets `[binary]` (`ble_chip/mod/bthome.S`,
 * the set table at the top of the file). Which set a value rides in is the wire's; the row order
 * inside a set is this view's, since set 1 airs in ascending object-id order.
 *
 * **THE GROUPING IS THE WIRE'S, NOT A LAYOUT CHOICE.** One advert carries set 0 and the next
 * carries set 1, about a second apart, and they never appear together — so a view that shows them
 * side by side is showing what actually arrives, and a whole column standing empty says which of
 * the two has not been heard rather than leaving nine rows half filled with no explanation.
 *
 * The lists are FIXED so a view can have a fixed number of rows: built from what has arrived, a
 * table grows from four rows to nine while somebody is looking at it.
 */
export const BROADCAST_SETS: string[][] = [
  ['temperature', 'temperature #2', 'moisture', 'voltage'],
  ['window', 'lock', 'generic', 'battery_low', 'count', 'connectivity'],
]

/** Both sets, flat — for a view that does not care which advert a reading came in. */
export const BROADCAST_FIELDS = BROADCAST_SETS.flat()

/**
 * One row per field this thermostat airs, whether or not it has arrived yet — `null` text where it
 * has not, for the caller to draw as a placeholder.
 *
 * **THE POINT IS THE SHAPE, NOT THE VALUES.** A panel that adds and removes rows as readings land,
 * and again when a connection opens, reads as data being lost `[owner]`; one that starts complete
 * and fills in reads as a device being waited for, which is what is happening.
 */
export type MaybeReading = { key: string; label: string; text: string | null }

export function describeAll(
  values: Record<string, BthomeValue>,
  ctx: ReadingContext = NOT_SELF,
): MaybeReading[] {
  return describeSets(values, ctx).flat()
}

/**
 * The same rows, GROUPED BY THE ADVERT THEY ARRIVE IN — one array per object set.
 *
 * Anything this table has no row for is appended to the last group rather than given one of its
 * own: which advert an unknown object came in is not something we know, and inventing a third
 * column for it would say that we do.
 */
export function describeSets(
  values: Record<string, BthomeValue>,
  ctx: ReadingContext = NOT_SELF,
): MaybeReading[][] {
  const groups = BROADCAST_SETS.map((keys) =>
    keys.map((k) => ({
      key: k,
      label: SPECS[k]!.label,
      text: k in values ? SPECS[k]!.fmt(values[k]!, ctx) : null,
    })),
  )
  groups[groups.length - 1]!.push(...unknownOf(values))
  return groups
}
