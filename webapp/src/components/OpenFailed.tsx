import { useAtomValue, useSetAtom } from 'jotai'

import { Sheet } from '@/components/Sheet'
import { Button } from '@/components/ui/button'
import { SUPPORTED as ADVERTS_SUPPORTED } from '@/device/advert'
import { grantedAtom, grantedSettledAtom } from '@/device/link'
import { useChooseFor } from '@/device/useChooseFor'
import { openFailedAtom, useRetryOpen } from '@/device/useRouteLink'
import { advertAtom, openDeviceAtom } from '@/state/atoms'
import { leaveAtom } from '@/state/route'

/**
 * "This thermostat would not open" — said WHERE THE PERSON ALREADY IS `[owner]`.
 *
 * Walking into a thermostat opens it (a page load does not — `useRouteLink` says why), and what that
 * usually waits on is the browser settling rather than anything being wrong — so the failure is
 * common, and moving somebody
 * off the screen they were on costs them the tab they had open and the address they followed, which
 * is a bigger interruption than a link that is not up yet.
 *
 * So it is a dialog on the screen you are on. The tabs behind it are greyed with their own reason
 * ("connect to the thermostat to use this"), and the thermostat is still the one in the address bar
 * — so Try again is a button rather than a navigation.
 *
 * **IT IS DISMISSABLE**, and going to the list is offered rather than done. Escape and the backdrop
 * both close it, leaving the greyed screen and the Connect button in the bar, which is a perfectly
 * reasonable place to stand: this is a link that is not up, not an error that has to be cleared.
 */
export function OpenFailed() {
  const name = useAtomValue(openFailedAtom)
  const clear = useSetAtom(openFailedAtom)
  const leave = useSetAtom(leaveAtom)
  const retry = useRetryOpen()
  const granted = useAtomValue(grantedAtom)
  const settled = useAtomValue(grantedSettledAtom)
  const chooseFor = useChooseFor()
  /**
   * The row the chooser is aimed at — READ from the address bar, not carried in with the name.
   *
   * `openFailedAtom` holds a name because a name is what the title needs; the row is a different
   * fact and it already has a home. The thermostat that failed to open is the one the address bar
   * is on, which is exactly what `openDeviceAtom` derives, so carrying a second copy through the
   * failure atom would be two answers to one question.
   */
  const row = useAtomValue(openDeviceAtom)
  const adv = useAtomValue(advertAtom)
  if (!name) return null
  // **ONE OF THESE FAILURES CANNOT BE RETRIED, and offering Try again for it is a loop.** A browser
  // that hands the page no saved thermostat will hand it none on the next press either — the only
  // door is the chooser, which needs a tap on the list. So that case says so and leads with the
  // button that works. The two atoms are read here rather than carried in with the name because
  // they are live: what makes this case true can stop being true while the dialog is open.
  const dry = settled && granted === 0
  // HEARD BUT NOT OPENED IS USUALLY SOMEBODY ELSE'S LINK `[owner]`: the thermostat takes one
  // connection at a time and keeps broadcasting while it is held — most often by Home Assistant's
  // own integration `[manually verified]`. Where this browser cannot watch broadcasts, "heard" is
  // unknowable, so that case names both causes rather than guessing one.
  const heardIt = adv.lastAt != null
  return (
    <Sheet title={`Could not open ${name}`} onClose={() => clear(null)}>
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {dry ? (
            <>
              This browser is not handing the page any saved thermostat, so {name} can only be opened
              by picking it from the browser&rsquo;s own device list. That list can come up right
              here — <strong>every thermostat in it is called CC-RT-BLE</strong> unless you have
              renamed it, and this app says afterwards which one you actually picked. The banner on
              the thermostat list says which setting stops this happening every time.
            </>
          ) : heardIt ? (
            <>
              {name} is broadcasting, so it is in range — but it would not take a connection. It
              takes one connection at a time, so <strong>something else is probably connected to
              it</strong>. If Home Assistant manages this thermostat, disable it there (or close any
              other app using it), then try again.
            </>
          ) : ADVERTS_SUPPORTED ? (
            <>
              It has not been heard from — out of range, or it has stopped broadcasting — or this
              browser would not hand it back.
            </>
          ) : (
            <>
              It may be out of range, or something else may be connected to it — it takes one
              connection at a time, so if Home Assistant manages this thermostat, disable it there.
              Or this browser would not hand it back.
            </>
          )}
        </p>
        <div className="flex gap-2">
          {dry ? (
            <>
              {/* THE CHOOSER OPENS FROM HERE, not on another screen `[owner]`. This button press is
                  the user gesture `requestDevice()` needs, so the one thing that can fix this case
                  is reachable without going anywhere. Dismissing the dialog first: the chooser is a
                  browser dialog and stacking it behind ours hides the outcome. */}
              <Button
                onClick={() => {
                  clear(null)
                  if (row) void chooseFor(row)
                }}
                disabled={!row}
              >
                Pick it from the browser&rsquo;s list
              </Button>
              <Button variant="outline" onClick={() => leave()}>
                Go to the list
              </Button>
            </>
          ) : (
            <>
              <Button
                onClick={() => {
                  clear(null)
                  retry()
                }}
              >
                Try again
              </Button>
              <Button variant="outline" onClick={() => leave()}>
                Go to the list
              </Button>
            </>
          )}
        </div>
      </div>
    </Sheet>
  )
}
