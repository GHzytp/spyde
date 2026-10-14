/**
 * open_with.spec.ts — a file handed to SpyDE by the OS opens as a dataset.
 *
 * Double-click and "Open with" both arrive as a path on the command line,
 * either of this launch or of a second one that forwards it to the running
 * app. The installed association is a hand test; what this pins is everything
 * after the path reaches the process: it waits for the backend, goes through
 * the File → Open route, and a second launch opens its file in the FIRST app
 * instead of starting another.
 */
import { test, expect } from '@playwright/test'
import { execFileSync, spawn } from 'child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const { launchApp, waitForSubwindowCount, countColorPixels } = require('./_harness.cjs')

const ROOT = join(__dirname, '..', '..')
const MAIN = join(__dirname, '..', 'out', 'main', 'index.js')
const SHOTS = join(__dirname, '..', 'open_with_shots')
const FIXTURES = join(tmpdir(), 'spyde-open-with-fixture')
// Copied out of the source tree: opening a file writes a navigator cache beside it.
const DM4 = join(FIXTURES, 'stack_2x2x2.dm4')

test.beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true })
  const py = [join(ROOT, '.venv', 'Scripts', 'python.exe'),
              join(ROOT, '.venv', 'bin', 'python')].find((p) => existsSync(p))
    ?? (process.platform === 'win32' ? 'python' : 'python3')
  execFileSync(py, ['-m', 'spyde.tests.gen_tiff_fixture', FIXTURES], { cwd: ROOT })
  writeFileSync(join(FIXTURES, 'notes.txt'), 'not a dataset\n')
  copyFileSync(join(ROOT, 'spyde', 'tests', 'migrated', 'data', 'lazy_formats', 'stack_2x2x2.dm4'), DM4)
})

test('a file on the command line opens once the backend is ready', async () => {
  test.setTimeout(180_000)
  // dask: the same display path a user's File -> Open takes (tiff_load.spec.ts).
  const ctx = await launchApp({
    dask: true,
    args: [join(FIXTURES, 'single.tif'), join(FIXTURES, 'notes.txt')],
  })
  const { page, backend } = ctx
  try {
    await waitForSubwindowCount(page, 1, 90_000)
    // An unsupported file gets the backend's ordinary error, not a crash.
    await backend.waitForLog('Unsupported file type: .txt', 30_000)
    await page.waitForTimeout(6_000)
    await page.screenshot({ path: join(SHOTS, '01-launched-with-file.png') })

    expect(await page.locator('[data-testid="subwindow"]').count()).toBe(1)
    // The 256 x 256 frame fills ~65k canvas pixels; the axes and title alone
    // are a few thousand, which is all a window left black would show.
    const bright = await countColorPixels(page, 'bright')
    console.log(`[open_with] bright=${bright}`)
    expect(bright, 'the opened file never painted').toBeGreaterThan(20_000)
    ctx.assertNoJsErrors()
  } finally {
    await ctx.app.close()
  }
})

test('a second launch opens its file in the running app and exits', async () => {
  test.setTimeout(180_000)
  // Both processes must share a profile — the lock is per profile — and opt in
  // to the lock, which unpackaged runs skip by default.
  const profile = mkdtempSync(join(tmpdir(), 'spyde-e2e-single-instance-'))
  const env = { SPYDE_SINGLE_INSTANCE: '1' }
  const ctx = await launchApp({ env, userDataDir: profile })
  const { app, page } = ctx
  try {
    expect(await page.locator('[data-testid="subwindow"]').count()).toBe(0)

    const electronBinary = require(require.resolve('electron/index.js', { paths: [__dirname] }))
    const second = spawn(electronBinary, [MAIN, `--user-data-dir=${profile}`, DM4], {
      env: { ...process.env, ...env, SPYDE_NO_DASK: '1' },
      stdio: 'ignore',
    })
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        second.kill()
        reject(new Error('the second launch kept running instead of handing over'))
      }, 30_000)
      second.on('exit', (code) => { clearTimeout(timer); resolve(code) })
    })
    expect(exitCode).toBe(0)

    // The 2 x 2 scan opens as navigator + signal, in the FIRST app.
    await waitForSubwindowCount(page, 2, 90_000)
    await page.waitForTimeout(3_000)
    await page.screenshot({ path: join(SHOTS, '02-second-launch-opened-here.png') })
    expect(app.windows().length, 'the second launch opened a window of its own').toBe(1)
    ctx.assertNoJsErrors()
  } finally {
    await ctx.app.close()
  }
})
