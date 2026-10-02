/**
 * The weekly programme — reading it, editing it, and working out the fewest commands to send it.
 *
 * ================================================================================================
 * THE WIRE'S TWO SURPRISES, both the opposite of what an editor would assume
 * ================================================================================================
 * 1. **A WRITE takes a day GROUP; a READ does not.** `cmd 0x10`'s day byte 7, 8 and 9 mean the
 *    weekend pair, the five weekdays and all seven — so a whole week can go out in ONE command.
 *    `cmd 0x20` always answers with exactly one day, and a group byte merely selects which day
 *    answers, echoing the group byte back rather than the day it came from. **So loading a week is
 *    seven reads.** An editor that reads `20 09` once and calls it "the week" silently shows one
 *    day's programme as all seven.
 * 2. **THERE ARE ALWAYS SEVEN SLOTS.** There is no count field: a day with four real switch points
 *    is expressed by repeating the last temperature at 24:00 for the remaining three. Sending six
 *    pairs where the frame carries seven leaves the seventh filled from whatever was in the
 *    device's buffer — that is a live defect in another client (`homeassistant/PLAN.md` `HA1`), and
 *    it is the same mistake waiting to be made twice.
 *
 * **THE GROUPS ARE AN IMPLEMENTATION DETAIL OF THE SEND, NOT A UI FEATURE** `[owner]`. Copying a
 * day onto other days is an operation on the local model and is free; it is good UI because it
 * saves typing, not because a command exists behind it. `plan()` below is where the wire shape
 * lives, and it is the only place that knows about groups at all.
 *
 * ================================================================================================
 * AN INVALID DAY CANNOT BE HELD `[owner]`
 * ================================================================================================
 * **THE FIRMWARE VALIDATES NOTHING** `[binary]` — `ble_cmd_10_set_program` masks the temperatures
 * and copies the time bytes through untouched — so the model carries the constraints itself rather
 * than checking for them afterwards:
 * - **The last period has no time.** It always runs to 24:00, so a `Day` stores only its
 *   temperature. A seven-slot frame stores a time there anyway, and an editor that kept it held a
 *   value it showed as a fixed "24:00" and could not reach — a user's day read `20:00` then `24:00`
 *   and still failed ordering (eq3-custom-fw issue #4) `[manually verified]`, after they deleted
 *   the rows the Home Assistant integration's padding had shown (see `fromWire`).
 * - **The times only go forward.** Every edit goes through `setUntil`, `addSlot` or `removeSlot`,
 *   which keep them strictly increasing and on the ten-minute grid; the editor holds a time between
 *   its neighbours rather than reporting a backwards one `[owner]`.
 * - **Anything arriving from outside is settled into that shape** (`fromWire`), which is where the
 *   rules meet data the editor did not make: a device day, a saved programme.
 *
 * ================================================================================================
 * DAY 0 IS SATURDAY
 * ================================================================================================
 * `[manually verified]` — the device reported weekday 2 on a Monday. The EEPROM tables are indexed
 * `base + weekday * 7` in that numbering, and it is why the "weekend" group is days 0–1. A person
 * is shown Monday first; only this file knows the device's order.
 */

import { TEMP_MAX, TEMP_MIN, tempByte } from './commands'

/** One switch point on the wire: everything up to `until` is heated to `temp`. */
export type Slot = {
  /** Minutes from midnight, a multiple of 10. 1440 is the end of the day. */
  until: number
  /** Degrees C, on the half-degree grid. */
  temp: number
}

/**
 * One day as the editor holds it: the switch points before midnight, then the temperature that
 * runs from the last of them to 24:00. `slots` times are strictly increasing, on the ten-minute
 * grid, between 00:10 and 23:50 — see the header for who keeps them that way.
 */
export type Day = { slots: Slot[]; last: number }
/** Seven days, indexed the DEVICE's way: 0 = Saturday. */
export type Week = Day[]

export const SLOTS = 7
/** The frame's seventh slot is always the period that ends at midnight. */
export const MAX_CHANGES = SLOTS - 1
export const END_OF_DAY = 1440
const STEP = 10

/** Device weekday → what a person calls it. Index is the device's, order is not. */
export const DAY_NAMES = ['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
/** The order a week is shown in: Monday first, which is device indices 2…6, 0, 1. */
export const DISPLAY_ORDER = [2, 3, 4, 5, 6, 0, 1]

/** Day bytes 7, 8 and 9 — the write-only groups. */
export const GROUP_WEEKEND = 7
export const GROUP_WEEKDAYS = 8
export const GROUP_ALL = 9
/** Which days each group command covers. The editor's copy shortcuts offer the same three sets. */
export const WEEKEND = [0, 1]
export const WEEKDAYS = [2, 3, 4, 5, 6]
export const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6]

/* ---- the wire ------------------------------------------------------------------------------- */

/** `cmd 0x20 <day>` — read ONE day. A group byte here does not read a group; see the header. */
export const readDay = (day: number) => [0x20, day]

/** The reply is `21 <day echoed> <temp,time> × 7`. */
export const isDayReply = (b: Uint8Array) => b.length >= 16 && b[0] === 0x21

export function decodeDay(b: Uint8Array): Day | null {
  if (!isDayReply(b)) return null
  const slots: Slot[] = []
  for (let i = 0; i < SLOTS; i++) {
    slots.push({ temp: b[2 + i * 2]! / 2, until: b[3 + i * 2]! * 10 })
  }
  return fromWire(slots)
}

/**
 * Seven slots from outside the editor → a `Day`.
 *
 * The day ends at the first 24:00, because `state_refresh` stops scanning there `[binary]`: what
 * follows is never run. The Home Assistant integration fills that space with junk — its
 * `set_schedule` writes every unused time as `00:00` and turns only the FIRST into 24:00, so the
 * slots after the end read `00:00` at 0 °C, and the seventh is whatever `HA1` leaves there
 * `[external]`.
 *
 * A slot that does not move forward also ends the day, and its temperature becomes `last`. That
 * shape comes from saved programmes: an older editor stored the rows it showed, and the last row's
 * time was hidden behind its fixed "24:00" label, so it could hold anything — issue #4's day was
 * `20:00`, then `11.5 °C` behind the label with a time at or before 20:00 `[manually verified]`.
 * Temperatures are clamped into the device's range, since a stray byte can hold anything.
 */
export function fromWire(wire: Slot[]): Day {
  const temp = (t: number) => tempByte(t) / 2
  const slots: Slot[] = []
  for (const s of wire.slice(0, SLOTS)) {
    const prev = slots[slots.length - 1]?.until ?? 0
    if (s.until >= END_OF_DAY || s.until <= prev || s.until % STEP !== 0 || slots.length === MAX_CHANGES)
      return { slots, last: temp(s.temp) }
    slots.push({ until: s.until, temp: temp(s.temp) })
  }
  // Fewer than seven and no end: a saved programme holds the rows a person saw, so its final row
  // is the period that runs to midnight.
  const end = slots.pop()
  return { slots, last: end?.temp ?? temp(TEMP_MIN) }
}

/** The seven slots the frame carries: the changes, then the last period repeated at 24:00. */
export function toWire(day: Day): Slot[] {
  const out = day.slots.map((s) => ({ ...s }))
  while (out.length < SLOTS) out.push({ until: END_OF_DAY, temp: day.last })
  return out
}

/** `cmd 0x10 <day or group> <temp,time> × 7`. */
export function writeDay(dayOrGroup: number, day: Day): number[] {
  const out = [0x10, dayOrGroup]
  for (const s of toWire(day)) out.push(tempByte(s.temp), Math.round(s.until / 10))
  return out
}

/** The device acks a programme write with its own frame, `02 02 …`. */
export const isProgramAck = (b: Uint8Array) => b.length >= 2 && b[0] === 0x02 && b[1] === 0x02

/* ---- the model: every edit keeps the day valid ----------------------------------------------- */

/** The range switch point `i` may take: after the one before it, before the one after it. */
export function untilRange(day: Day, i: number): [number, number] {
  const lo = (day.slots[i - 1]?.until ?? 0) + STEP
  const hi = (day.slots[i + 1]?.until ?? END_OF_DAY) - STEP
  return [lo, hi]
}

/** Move switch point `i`, held between its neighbours and snapped to the ten-minute grid. */
export function setUntil(day: Day, i: number, until: number): Day {
  const [lo, hi] = untilRange(day, i)
  const t = Math.min(hi, Math.max(lo, Math.round(until / STEP) * STEP))
  return { ...day, slots: day.slots.map((s, j) => (j === i ? { ...s, until: t } : s)) }
}

/** Set the temperature of period `i`; `i === slots.length` is the one that runs to midnight. */
export function setTemp(day: Day, i: number, temp: number): Day {
  const t = Math.min(TEMP_MAX, Math.max(TEMP_MIN, temp))
  if (i === day.slots.length) return { ...day, last: t }
  return { ...day, slots: day.slots.map((s, j) => (j === i ? { ...s, temp: t } : s)) }
}

/** The room a new switch point needs: a free ten-minute step between the last one and midnight. */
export const canAdd = (day: Day) =>
  day.slots.length < MAX_CHANGES && (day.slots[day.slots.length - 1]?.until ?? 0) + STEP < END_OF_DAY

/** A new switch point halfway through the last period, at that period's temperature. */
export function addSlot(day: Day): Day {
  if (!canAdd(day)) return day
  const prev = day.slots[day.slots.length - 1]?.until ?? 0
  const until = Math.min(END_OF_DAY - STEP, prev + Math.max(STEP, Math.round((END_OF_DAY - prev) / 2 / STEP) * STEP))
  return { ...day, slots: [...day.slots, { until, temp: day.last }] }
}

/** Remove switch point `i`: its period is absorbed by the one after it. */
export const removeSlot = (day: Day, i: number): Day => ({ ...day, slots: day.slots.filter((_, j) => j !== i) })

const sameDay = (a: Day, b: Day) =>
  a.last === b.last &&
  a.slots.length === b.slots.length &&
  a.slots.every((s, i) => s.temp === b.slots[i]!.temp && s.until === b.slots[i]!.until)

const allSame = (week: Week, days: number[]) =>
  days.every((d) => sameDay(week[days[0]!]!, week[d]!))

/**
 * The fewest commands that express this week. All seven equal is one write; weekend-equal and
 * weekdays-equal is two; anything else falls back to one per day. The person sees "sent", not a
 * strategy.
 */
export function plan(week: Week): { day: number; program: Day }[] {
  if (allSame(week, EVERY_DAY)) return [{ day: GROUP_ALL, program: week[0]! }]
  const out: { day: number; program: Day }[] = []
  if (allSame(week, WEEKEND)) out.push({ day: GROUP_WEEKEND, program: week[0]! })
  else for (const d of WEEKEND) out.push({ day: d, program: week[d]! })
  if (allSame(week, WEEKDAYS)) out.push({ day: GROUP_WEEKDAYS, program: week[2]! })
  else for (const d of WEEKDAYS) out.push({ day: d, program: week[d]! })
  return out
}

/* ---- helpers the editor uses ----------------------------------------------------------------- */

export const hhmm = (mins: number) =>
  mins >= END_OF_DAY ? '24:00' : `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`

/** Copy one day onto others. A local operation with no command behind it — see the header. */
export function copyDay(week: Week, from: number, to: number[]): Week {
  return week.map((d, i) => (to.includes(i) ? { ...week[from]!, slots: week[from]!.slots.map((s) => ({ ...s })) } : d))
}

/** A week where every day is the thermostat's own first-run programme, for a preset to start from. */
export function defaultWeek(): Week {
  const day = (): Day => ({
    slots: [
      { until: 360, temp: 17 },
      { until: 540, temp: 21 },
      { until: 1020, temp: 17 },
      { until: 1380, temp: 21 },
    ],
    last: 17,
  })
  return Array.from({ length: 7 }, day)
}
