/**
 * What `bun test` needs in order to load the app: a DOM, and Vite's virtual modules.
 *
 * Bun's test runner is not Vite and knows nothing about them, so a test that renders the app would
 * fail to resolve the import and take the whole run with it.
 */
import { plugin } from 'bun'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

/**
 * BUN 1.4 OR NEWER, BECAUSE THE TEST SCRIPT'S `--isolate` NEEDS IT.
 *
 * Three test files replace `@/device/link` with a stand-in. Without `--isolate`, an app module that
 * one of them loads (`state/atoms.ts`, say) stays wired to THAT file's stand-in for the rest of the
 * run, so the next mocking file renders against the wrong atoms: `advname.test.tsx` failed 15 tests
 * whenever `flashfail.test.tsx` ran first, which on Linux it does and on a Mac it does not
 * `[manually verified]`. `--isolate` gives each file a fresh module registry, so every file loads
 * the app against its own stand-in. It does NOT end a registration: a `mock.module` still lasts the
 * whole run `[manually verified]`, which is why each mocking file also restores the real module in an
 * `afterAll` (`src/device/mock-isolation.test.ts`). An older bun accepts the flag and ignores it.
 */
const [major, minor] = Bun.version.split('.').map(Number)
if (major < 1 || (major === 1 && minor < 4)) {
  throw new Error(`bun ${Bun.version} cannot isolate test files; run \`bun upgrade\` (1.4 or newer)`)
}

/**
 * THE DOM IS REGISTERED HERE BECAUSE IT CAN ONLY BE REGISTERED ONCE PER RUN.
 *
 * `GlobalRegistrator.register()` THROWS on a second call, and it throws as an unhandled error
 * between tests rather than as a failure inside one — so the second component test file anybody
 * adds takes the whole run down with a message about happy-dom and nothing about the test. Each
 * file doing it for itself works exactly until there are two of them, which is the worst moment to
 * find out. Doing it in the preload also means a test file gets the DOM before its first import,
 * so it can use ordinary static imports rather than awaiting them after a register call.
 */
GlobalRegistrator.register()

plugin({
  name: 'eq3-test-virtuals',
  setup(build) {
    /**
     * The service worker's registration hook, which `vite-plugin-pwa` provides in a build.
     *
     * A STUB IS THE RIGHT ANSWER HERE: there is no service worker in a test runner and nothing
     * should try to register one. It returns a function that does nothing, so a render reaches the
     * update prompt's ordinary "no update pending" state.
     */
    build.module('virtual:pwa-register', () => ({
      loader: 'object',
      exports: { registerSW: () => async () => {} },
    }))
  },
})
