/**
 * The weekly programme's encoding, its model, and its send plan.
 *
 * THE FIXTURE IS A MEASUREMENT: `210322242a3622662a8a229022902290` is what a bench unit answered
 * `20 03` with, and `../../../PROTOCOL.md` reads it as 17.0 until 06:00, 21.0 until 09:00, 17.0 until 17:00,
 * 21.0 until 23:00. If this decoder disagrees with that sentence, one of them is wrong.
 *
 * The model is tested because it is what makes an invalid day impossible to hold: every edit
 * function must hand back a day whose times still go forward.
 *
 * The plan is tested because it is the only place that knows day GROUPS exist, and getting it wrong
 * is silent: a week sent as seven writes is merely slow, but a week sent as one group write when
 * the days differ puts the wrong programme on five days.
 */
import { expect, test } from 'bun:test'

import {
  END_OF_DAY,
  GROUP_ALL,
  GROUP_WEEKDAYS,
  GROUP_WEEKEND,
  MAX_CHANGES,
  addSlot,
  canAdd,
  decodeDay,
  defaultWeek,
  fromWire,
  plan,
  removeSlot,
  setTemp,
  setUntil,
  toWire,
  writeDay,
  type Day,
} from './schedule'

const hex = (s: string) => new Uint8Array(s.match(/../g)!.map((h) => parseInt(h, 16)))
const REAL = hex('210322242a3622662a8a229022902290')

/** Strictly increasing, on the grid, inside the day — what every `Day` must be. */
const valid = (d: Day) =>
  d.slots.every((s, i) => s.until % 10 === 0 && s.until > (d.slots[i - 1]?.until ?? 0) && s.until < END_OF_DAY)

test('the day measured on the device decodes to what the protocol spec says it means', () => {
  expect(decodeDay(REAL)).toEqual({
    slots: [
      { temp: 17, until: 360 }, // 17.0 until 06:00
      { temp: 21, until: 540 }, // 21.0 until 09:00
      { temp: 17, until: 1020 }, // 17.0 until 17:00
      { temp: 21, until: 1380 }, // 21.0 until 23:00
    ],
    last: 17, // ...then 17.0 to midnight
  })
})

test('a decoded day re-encodes to the SAME BYTES it arrived as', () => {
  // Everything after the id: the write is `10 <day> …` and the reply `21 <day> …`, so the ids
  // differ by construction and the payload must not.
  expect(writeDay(3, decodeDay(REAL)!).slice(1)).toEqual([...REAL].slice(1))
})

test('slots after the first 24:00 are dropped, because the thermostat never reads them', () => {
  // 17.0 until 06:00, 21.0 until 24:00 -- then two slots of junk the firmware stops before.
  expect(decodeDay(hex('21032224' + '2a90' + '4200' + '2200' + '2290'.repeat(3)))).toEqual({
    slots: [{ temp: 17, until: 360 }],
    last: 21,
  })
})

test('the day the Home Assistant integration writes decodes to its real switch points (issue #4)', () => {
  // Its `set_schedule`: 8.0 until 20:00, 11.5 until 24:00, then every other time 00:00 at 0 °C,
  // and a seventh pair it never sends, left over in the BLE chip's buffer.
  expect(decodeDay(hex('21021078' + '1790' + '0000'.repeat(4) + '2a36'))).toEqual({
    slots: [{ temp: 8, until: 1200 }],
    last: 11.5,
  })
})

test('a slot that goes backwards ends the day', () => {
  // 8.0 until 20:00, then 11.5 padded out with 00:00 times instead of 24:00.
  expect(decodeDay(hex('21021078' + '1700'.repeat(6)))).toEqual({
    slots: [{ temp: 8, until: 1200 }],
    last: 11.5,
  })
})

test('a temperature byte out of the device range is clamped into it', () => {
  expect(decodeDay(hex('21020124' + 'ff90'.repeat(6)))!.slots[0]!.temp).toBe(4.5)
  expect(decodeDay(hex('21020124' + 'ff90'.repeat(6)))!.last).toBe(30)
})

test('a saved programme from an older app, kept as the rows a person saw, loads', () => {
  expect(fromWire([{ until: 1200, temp: 8 }, { until: 0, temp: 11.5 }])).toEqual({
    slots: [{ temp: 8, until: 1200 }],
    last: 11.5,
  })
  expect(fromWire([{ until: 480, temp: 18 }, { until: 900, temp: 21 }])).toEqual({
    slots: [{ temp: 18, until: 480 }],
    last: 21,
  })
})

test('a day always goes out as seven slots, the last period repeated at 24:00', () => {
  const short: Day = { slots: [{ until: 480, temp: 18 }], last: 21 }
  expect(writeDay(9, short)).toHaveLength(2 + 7 * 2) // the frame carries seven whatever the day holds
  expect(toWire(short).slice(1).every((s) => s.temp === 21 && s.until === END_OF_DAY)).toBe(true)
})

test('a time is held between its neighbours, never passing them', () => {
  const day = decodeDay(REAL)! // 06:00, 09:00, 17:00, 23:00
  expect(setUntil(day, 1, 300).slots[1]!.until).toBe(370) // 05:00 → just after 06:00
  expect(setUntil(day, 1, 1200).slots[1]!.until).toBe(1010) // 20:00 → just before 17:00
  expect(setUntil(day, 3, END_OF_DAY).slots[3]!.until).toBe(1430) // the last change stays before midnight
  expect(setUntil(day, 0, 0).slots[0]!.until).toBe(10) // and the first after it
  expect(setUntil(day, 1, 605).slots[1]!.until).toBe(610) // on the ten-minute grid
  for (const t of [0, 5, 365, 600, 1439, 5000]) for (const i of [0, 1, 2, 3]) expect(valid(setUntil(day, i, t))).toBe(true)
})

test('adding and removing keep the day valid, and seven periods is the most', () => {
  let day: Day = { slots: [], last: 17 }
  while (canAdd(day)) {
    day = addSlot(day)
    expect(valid(day)).toBe(true)
  }
  expect(day.slots).toHaveLength(MAX_CHANGES)
  expect(addSlot(day)).toBe(day)
  expect(valid(removeSlot(day, 2))).toBe(true)
  // A change at 23:50 leaves no room for another before midnight.
  expect(canAdd({ slots: [{ until: 1430, temp: 20 }], last: 17 })).toBe(false)
})

test('the last period is set through the row after the changes', () => {
  const day = decodeDay(REAL)!
  expect(setTemp(day, 4, 19).last).toBe(19)
  expect(setTemp(day, 0, 40).slots[0]!.temp).toBe(30)
})

test('the whole week goes out as ONE command when every day is the same', () => {
  const p = plan(defaultWeek())
  expect(p).toHaveLength(1)
  expect(p[0]!.day).toBe(GROUP_ALL)
})

test('weekend and weekdays are two commands, in that shape', () => {
  const week = defaultWeek()
  for (const d of [0, 1]) week[d] = { slots: [], last: 19 }
  const p = plan(week)
  expect(p.map((x) => x.day)).toEqual([GROUP_WEEKEND, GROUP_WEEKDAYS])
})

test('an irregular week falls back to one command per day, and never a wrong group', () => {
  const week = defaultWeek()
  week[4] = { slots: [], last: 23 } // one weekday differs
  const p = plan(week)
  expect(p.map((x) => x.day)).toEqual([GROUP_WEEKEND, 2, 3, 4, 5, 6])
  // The days that were the same are still each sent their OWN programme, not day 2's.
  expect(p.find((x) => x.day === 4)!.program.last).toBe(23)
})

test('a plan always covers all seven days exactly once', () => {
  const week = defaultWeek()
  week[0] = { slots: [{ until: 600, temp: 20 }], last: 16 }
  const covered = plan(week).flatMap((p) =>
    p.day === GROUP_ALL ? [0, 1, 2, 3, 4, 5, 6] : p.day === GROUP_WEEKEND ? [0, 1] : p.day === GROUP_WEEKDAYS ? [2, 3, 4, 5, 6] : [p.day],
  )
  expect([...covered].sort()).toEqual([0, 1, 2, 3, 4, 5, 6])
})
