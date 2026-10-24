/**
 * binning_axis_order.spec.ts — the Rebin caret and the crosshair after a scan bin.
 *
 *  1  the Rebin caret lists its factors scan x, scan y, diffraction x,
 *     diffraction y — the order the dataset's axes are written in;
 *  2  after binning the scan along x only, the crosshair still picks the
 *     pattern under it. The navigator keeps showing the unbinned scan, so a
 *     crosshair at scan (18, 6) must show binned position (9, 6), which holds
 *     scan columns 18 and 19.
 *
 * `load_test_data_lazy_chunked` puts one bright pixel per scan position at
 * detector (row, column) = (scan y, scan x), so the pattern names the position
 * it came from. Screenshots land in electron/binning_shots/ (read them).
 */
import { test, expect, Page } from '@playwright/test'
import { join } from 'path'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { launchApp, raiseWindow, backendAction, waitForSubwindowCount, sigWindow } = require('./_harness.cjs')

const SHOTS = join(__dirname, '..', process.env.BINNING_SHOTS || 'binning_shots')
let ctx: Awaited<ReturnType<typeof launchApp>>
let page: Page

test.beforeAll(async () => {
  ctx = await launchApp({ dask: false, env: { SPYDE_LOG_LEVEL: 'INFO' } })
  page = ctx.page
  await page.waitForTimeout(1500)
  await backendAction(page, 'load_test_data_lazy_chunked')
  await waitForSubwindowCount(page, 2, 60_000)
  await page.waitForTimeout(2000)
})

test.afterAll(async () => { await ctx?.app?.close() })

const shot = (name: string) => page.screenshot({ path: join(SHOTS, name) })

/** Move the navigator crosshair to scan (x, y) and return the flat argmax of
 *  the pattern that painted, from the backend's report of the move. */
async function moveCrosshair(x: number, y: number): Promise<number | null> {
  const reports = () => ctx.backend.logBuffer
    .filter((l: string) => l.includes('test_nav_drag frames:'))
  const before = reports().length
  await backendAction(page, 'test_nav_drag', { targets: [[x, y]] })
  let line: string | undefined
  for (let i = 0; i < 120 && !line; i++) {
    const lines = reports()
    if (lines.length > before) line = lines[lines.length - 1]
    else await page.waitForTimeout(250)
  }
  expect(line, 'the backend never reported the crosshair move').toBeTruthy()
  await page.waitForTimeout(800)
  const match = line!.match(/frames: \[\[\d+, \d+, (\d+|None)\]\]/)
  return match && match[1] !== 'None' ? Number(match[1]) : null
}

const rowColumn = (flat: number | null) =>
  flat === null ? null : [Math.floor(flat / 32), flat % 32]

test('1: the Rebin caret lists scan x, scan y, diffraction x, diffraction y', async () => {
  const win = sigWindow(page)
  await win.getByTestId('subwindow-titlebar').hover()
  await raiseWindow(win)
  await win.getByTestId('action-btn-Rebin').click()
  const flyout = page.getByTestId('action-flyout')
  await expect(flyout).toBeVisible()
  await shot('01-rebin-caret.png')
  const rows = await flyout.locator('[data-testid^="param-row-"]').evaluateAll(
    (elements) => elements.map((element) => element.getAttribute('data-testid')))
  expect(rows).toEqual([
    'param-row-scan_x', 'param-row-scan_y', 'param-row-scale_x', 'param-row-scale_y'])
})

test('2: after binning the scan, the crosshair shows the pattern under it', async () => {
  // Before binning the crosshair reads its own position: the reference.
  expect(rowColumn(await moveCrosshair(18, 6))).toEqual([6, 18])

  const win = sigWindow(page)
  await win.getByTestId('subwindow-titlebar').hover()
  await raiseWindow(win)
  const flyout = page.getByTestId('action-flyout')
  if (!(await flyout.isVisible())) await win.getByTestId('action-btn-Rebin').click()
  await flyout.getByTestId('param-scan_x').fill('2')
  await flyout.getByTestId('param-scan_y').fill('1')
  await flyout.getByTestId('param-scale_x').fill('1')
  await flyout.getByTestId('param-scale_y').fill('1')
  await shot('02-rebin-filled.png')
  await page.getByTestId('action-run').click()
  await expect(page.getByTestId('tree-node-Binned')).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(1000)

  // Move away and back so the read is of the binned node.
  await moveCrosshair(4, 4)
  const argmax = await moveCrosshair(18, 6)
  await shot('03-crosshair-18-6-after-scan-bin.png')

  // Binned (9, 6) sums scan columns 18 and 19, so the first lit detector
  // pixel is still row 6, column 18.
  expect(rowColumn(argmax),
    'the pattern shown is not the one under the crosshair').toEqual([6, 18])
})
