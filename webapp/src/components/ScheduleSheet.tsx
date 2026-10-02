import { useAtomValue } from 'jotai'
import { Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { log } from '@/state/log'
import { TEMP_MAX, TEMP_MIN, TEMP_STEP, tempText } from '@/device/commands'
import { request } from '@/device/link'
import {
  DAY_NAMES,
  DISPLAY_ORDER,
  EVERY_DAY,
  MAX_CHANGES,
  WEEKDAYS,
  WEEKEND,
  GROUP_ALL,
  GROUP_WEEKDAYS,
  GROUP_WEEKEND,
  addSlot,
  canAdd,
  copyDay,
  decodeDay,
  defaultWeek,
  fromWire,
  hhmm,
  isDayReply,
  isProgramAck,
  plan,
  readDay,
  removeSlot,
  setTemp,
  setUntil,
  toWire,
  untilRange,
  writeDay,
  type Day,
  type Week,
} from '@/device/schedule'
import { registryPresetsAtom } from '@/state/atoms'
import { registry, type Preset } from '@/state/registry'

import { Sheet } from './Sheet'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Slider } from './ui/slider'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'

/**
 * The weekly programme: read the seven days, edit them here, send them on a button.
 *
 * ================================================================================================
 * EDITING SENDS NOTHING `[owner]`
 * ================================================================================================
 * Everything on this screen is a local model until **Send** is pressed, including every copy
 * operation. That is not a limitation of the commands — it is the point: a person rearranging a
 * week should not be writing a half-finished one to a radiator on every tap.
 *
 * **LOADING IS SEVEN READS, and that is not a missed optimisation.** `cmd 0x20`'s day byte accepts
 * the group values, and a group read is NOT a group: it answers with one day and echoes the group
 * byte back, so an editor that reads `20 09` once shows one day's programme as all seven.
 *
 * **SENDING IS AS FEW AS ONE.** `plan()` works out whether the week is one command, two, or up to
 * seven, and it is the only thing in the app that knows day groups exist. The person sees "sent".
 */
const READING = 'Reading the seven days…'

export function ScheduleSheet({ onClose }: { onClose: () => void }) {
  const presets = useAtomValue(registryPresetsAtom)
  const [week, setWeek] = useState<Week | null>(null)
  const [day, setDay] = useState(DISPLAY_ORDER[0]!)
  // It starts busy because the read starts on mount: setting that flag from inside the effect
  // instead would be a state change during the first render for no reason.
  const [busy, setBusy] = useState<string | null>(READING)
  const [sent, setSent] = useState(false)
  /** Which days the open copy panel is aimed at. `null` is the panel shut. */
  const [targets, setTargets] = useState<number[] | null>(null)

  /**
   * Seven reads, in the device's own day order, because a group read answers for one day.
   *
   * It does not raise the busy flag itself — every caller has already said what it is doing, and
   * doing it here would be a state change made synchronously from the mount effect.
   */
  const load = useCallback(async () => {
    const days: Week = []
    for (let d = 0; d < 7; d++) {
      const r = await request(readDay(d), isDayReply)
      const parsed = r && decodeDay(r)
      if (!parsed) {
        setBusy(null)
        log(`could not read ${DAY_NAMES[d]}`)
        return
      }
      days.push(parsed)
    }
    setWeek(days)
    setBusy(null)
    // `log` is a module function, not a hook's setter, so it is not a dependency.
  }, [])

  // Reading a device over a radio when the editor opens is exactly what an effect is for — the
  // linter cannot see that `load` touches no state until after its first await, so it assumes the
  // worst about any async call from an effect.
  useEffect(() => {
    // oxlint-disable-next-line set-state-in-effect
    void load()
  }, [load])

  const send = async () => {
    if (!week) return
    const commands = plan(week)
    setBusy(`Sending ${commands.length} command${commands.length === 1 ? '' : 's'}…`)
    for (const c of commands) {
      const r = await request(writeDay(c.day, c.program), isProgramAck)
      if (!r) {
        setBusy(null)
        log('the thermostat did not acknowledge the programme — nothing else was sent')
        return
      }
    }
    log(`programme sent as ${commands.length} command${commands.length === 1 ? '' : 's'}`)
    setSent(true)
    setBusy(READING) // read it back: the device is the authority on what it stored
    void load()
  }

  const edit = (next: Day) => {
    setSent(false)
    setWeek((w) => (w ? w.map((d, i) => (i === day ? next : d)) : w))
  }

  const copyTo = (targets: number[]) => setWeek((w) => (w ? copyDay(w, day, targets) : w))

  return (
    <Sheet title="Weekly programme" onClose={onClose}>
      {busy && <p className="mb-3 text-sm text-muted-foreground">{busy}</p>}

      {!week ? (
        !busy && (
          <Button
            variant="outline"
            onClick={() => {
              setBusy(READING)
              void load()
            }}
          >
            Try reading it again
          </Button>
        )
      ) : (
        <div className="space-y-5">
          {/* SEVEN DAYS, ONE SELECTED — a single-select group, not seven independent buttons.
              An empty value is refused for the same reason as the mode picker: some day is always
              being edited, and Radix would otherwise clear the selection when the current day is
              pressed a second time. */}
          <ToggleGroup
            type="single"
            variant="outline"
            value={String(day)}
            // Changing the day shuts the copy panel: its ticks were aimed from the day you left,
            // and a Copy pressed after that would carry the wrong programme.
            onValueChange={(d) => {
              if (!d) return
              setDay(Number(d))
              setTargets(null)
            }}
            className="w-full overflow-x-auto"
          >
            {DISPLAY_ORDER.map((d) => (
              <ToggleGroupItem key={d} value={String(d)} aria-label={DAY_NAMES[d]} className="flex-1">
                {DAY_NAMES[d]!.slice(0, 3)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          <DayEditor day={week[day]!} onChange={edit} />

          <CopyPanel
            source={day}
            targets={targets}
            onTargets={setTargets}
            onCopy={() => {
              copyTo(targets!)
              setTargets(null)
            }}
          />

          <Presets week={week} presets={presets} onLoad={setWeek} />

          <div className="sticky bottom-0 -mx-4 border-t bg-background px-4 pt-3">
            <Button
              size="lg"
              className="w-full"
              disabled={!!busy}
              onClick={() => void send()}
            >
              Send to the thermostat
            </Button>
            {/* MEASURED, and it is the difference between "sent" and "nothing happened": a
                programme written while the thermostat is in auto does NOT move the target now —
                a flat 23 °C week landed on the device and the setpoint stayed at 17.0 until the
                programme's next change. Saying so is the whole reason this line exists. */}
            <p className="mt-2 text-center text-xs text-muted-foreground">
              {sent
                ? 'Stored. The thermostat follows it from its next change of the day — the temperature now stays as it is.'
                : sendSummary(week)}
            </p>
          </div>
        </div>
      )}
    </Sheet>
  )
}

/** Say what will happen, in commands, because "one" and "seven" feel different over a radio. */
function sendSummary(week: Week): string {
  const p = plan(week)
  if (p.length === 1 && p[0]!.day === GROUP_ALL) return 'all seven days are the same — one command'
  if (p.length === 2 && p[0]!.day === GROUP_WEEKEND && p[1]!.day === GROUP_WEEKDAYS)
    return 'weekend and weekdays — two commands'
  return `${p.length} commands`
}

/**
 * One day's switch points.
 *
 * A ROW READS "<temp> UNTIL <time>" `[owner]`, which is what the device stores — not "from…to",
 * which would need two numbers per row and let a person leave a gap the format cannot express. The
 * last row always runs to midnight and its time is therefore fixed rather than editable.
 */
function DayEditor({ day, onChange }: { day: Day; onChange: (d: Day) => void }) {
  // The switch points, then the period that runs to midnight, which has no time of its own.
  const rows = [...day.slots, { until: null, temp: day.last }]

  return (
    <div className="space-y-2">
      {rows.map((s, i) => (
        <div key={i} className="flex items-center gap-2">
          <Slider
            min={TEMP_MIN}
            max={TEMP_MAX}
            step={TEMP_STEP}
            value={[s.temp]}
            onValueChange={([v]) => onChange(setTemp(day, i, v!))}
            aria-label="Temperature"
            className="min-w-0 flex-1 py-4"
          />
          <span className="w-9 shrink-0 text-right text-sm tabular-nums">{tempText(s.temp)}</span>
          <span className="shrink-0 text-xs text-muted-foreground">until</span>
          {s.until === null ? (
            // The input's border and padding, invisible, so "24:00" lines up with the times above.
            <span className="w-[6.5rem] shrink-0 border border-transparent px-3 py-2 text-sm tabular-nums text-muted-foreground">
              24:00
            </span>
          ) : (
            <Input
              type="time"
              step={600}
              // A time is held between its neighbours `[owner]`: the picker offers only that range,
              // and `setUntil` pulls anything typed outside it back in.
              min={hhmm(untilRange(day, i)[0])}
              max={hhmm(untilRange(day, i)[1])}
              value={hhmm(s.until)}
              onChange={(e) => {
                // A cleared field is a person mid-edit, not midnight.
                if (!e.target.value) return
                const [h, m] = e.target.value.split(':').map(Number)
                onChange(setUntil(day, i, (h ?? 0) * 60 + (m ?? 0)))
              }}
              // Wide enough for "20:00" beside the picker icon Android Chrome draws inside the field.
              className="w-[6.5rem] shrink-0 tabular-nums"
            />
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Remove this change"
            disabled={s.until === null}
            onClick={() => onChange(removeSlot(day, i))}
            // The negative margin cancels the padding around the icon, so the ICON sits one gap
            // from the time and flush with the row's edge while the tap target stays 36 px.
            className="-mx-2.5 shrink-0 text-muted-foreground disabled:opacity-30"
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <div className="flex justify-end">
        <Button
          variant="ghost"
          onClick={() => onChange(addSlot(day))}
          disabled={!canAdd(day)}
          className="px-0 font-normal text-muted-foreground disabled:opacity-40"
        >
          <Plus /> Add a change
          {day.slots.length >= MAX_CHANGES && ' — seven is the most a day can hold'}
        </Button>
      </div>
    </div>
  )
}

/** Presets live in the registry, so one programme can go on several thermostats. */
function Presets({
  week,
  presets,
  onLoad,
}: {
  week: Week
  presets: Preset[]
  onLoad: (w: Week) => void
}) {
  const [name, setName] = useState('')
  return (
    <div className="space-y-2 rounded-xl border p-3">
      <p className="text-sm font-medium">Saved programmes</p>
      {presets.length > 0 && (
        <ul className="space-y-1">
          {presets.map((p) => (
            <li key={p.name} className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={() => onLoad(p.week.map(fromWire))}
                className="flex-1 justify-start font-normal"
              >
                {p.name}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Delete ${p.name}`}
                onClick={() => registry.deletePreset(p.name)}
                // Destructive because it deletes `[owner]`. It stays a ghost icon rather than a
                // filled button: there is one of these per saved programme, and a column of solid
                // red would be the loudest thing in a dialog whose subject is the week.
                className="text-destructive"
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name this programme"
          className="min-w-0 flex-1"
        />
        <Button
          variant="outline"
          disabled={!name.trim()}
          onClick={() => {
            registry.savePreset(name.trim(), week.map(toWire))
            setName('')
          }}
        >
          Save
        </Button>
      </div>
      <Button
        variant="link"
        onClick={() => onLoad(defaultWeek())}
        className="h-auto px-0 text-xs text-muted-foreground"
      >
        Start from the thermostat&rsquo;s factory programme
      </Button>
    </div>
  )
}

/**
 * Copy one day's programme onto any set of the others.
 *
 * **THE TARGETS ARE PICKED ON A ROW OF DAYS, the same shape as the strip that chooses what to
 * edit** `[owner]` — three group buttons alone cannot say "Saturday onto Sunday", and a fourth,
 * fifth and sixth button per day would be a wall. The groups stay, as shortcuts that FILL the row
 * rather than copy on the spot, so every reachable set is reached the same way.
 *
 * The source day sits in the row, disabled: it keeps the columns under the strip above, and a day
 * cannot be copied onto itself.
 */
function CopyPanel({
  source,
  targets,
  onTargets,
  onCopy,
}: {
  source: number
  /** `null` while the panel is shut. */
  targets: number[] | null
  onTargets: (t: number[] | null) => void
  onCopy: () => void
}) {
  if (targets === null)
    return (
      <Button variant="outline" className="w-full" onClick={() => onTargets([])}>
        Copy {DAY_NAMES[source]} to…
      </Button>
    )

  const group = (days: number[]) => onTargets(days.filter((d) => d !== source))
  const n = targets.length

  return (
    <div className="space-y-3 rounded-xl border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">Copy {DAY_NAMES[source]} to…</p>
        <Button variant="ghost" size="sm" onClick={() => onTargets(null)}>
          Cancel
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => group(EVERY_DAY)}>
          every day
        </Button>
        <Button variant="outline" size="sm" onClick={() => group(WEEKDAYS)}>
          Mon–Fri
        </Button>
        <Button variant="outline" size="sm" onClick={() => group(WEEKEND)}>
          Sat &amp; Sun
        </Button>
      </div>

      <ToggleGroup
        type="multiple"
        variant="outline"
        value={targets.map(String)}
        onValueChange={(v) => onTargets(v.map(Number))}
        className="w-full overflow-x-auto"
      >
        {DISPLAY_ORDER.map((d) => (
          <ToggleGroupItem
            key={d}
            value={String(d)}
            aria-label={DAY_NAMES[d]}
            disabled={d === source}
            className="flex-1"
          >
            {DAY_NAMES[d]!.slice(0, 3)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <Button className="w-full" disabled={n === 0} onClick={onCopy}>
        {n === 0 ? 'Pick the days to copy onto' : `Copy onto ${n} day${n === 1 ? '' : 's'}`}
      </Button>
      <p className="text-xs text-muted-foreground">
        Copying changes nothing on the thermostat until you send.
      </p>
    </div>
  )
}
