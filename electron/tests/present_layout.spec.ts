/**
 * present_layout.spec.ts — Present-mode slide LAYOUT, against the real app.
 *
 * Four things that a green typecheck and a passing selector cannot see, so each
 * one is screenshotted and the pixels are looked at:
 *
 *  1. STACKED SPLITS. `split_layout` has four values, but Present mode used to
 *     test it with a bare `!== 'text-right'` — so `text-top` / `text-bottom`
 *     round-tripped through the document perfectly and then rendered SIDE BY
 *     SIDE. The editor offered a layout the deck could not show.
 *  2. TEXT SLIDES FILL THE STAGE. A heading plus a few bullets used to render at
 *     prose size, vertically centred in a 60rem column: a small block adrift in
 *     a large dark rectangle. Sparse slides now scale up; dense ones must NOT
 *     (that is what keeps them from overflowing into the pager).
 *  3. A DROPPED PNG FILLS THE SLOT. `report_set_cell_image` puts a photo into an
 *     EXISTING split cell rather than appending a new cell below it.
 *  4. THE SLIDE SIZES TO THE DISPLAY. A slide is laid out on a 1920×1080 logical
 *     stage fitted to the Present window, so a projector, a maximise or a
 *     resolution change scales text, split panes and figures by ONE ratio — and
 *     a live figure re-renders at the bigger size rather than being stretched.
 *
 * The deck is built through the real backend verbs rather than a fixture file,
 * so the wiring under test is the wiring a user drives.
 *
 * Run:
 *   npx playwright test tests/present_layout.spec.ts --project=electron \
 *     --reporter=line --retries=0
 */
import { test, expect } from '@playwright/test'
import { join } from 'path'
import { mkdirSync, readFileSync } from 'fs'
const {
  launchApp, backendAction, backendErrorLines, waitForSubwindowCount,
} = require('./_harness.cjs')

const SHOTS = join(__dirname, '..', 'present_layout_shots')
// Overridable so the same walk can shoot an older build for comparison.
const SCALE_SHOTS = process.env.PRESENT_SCALE_SHOTS
  ?? join(__dirname, '..', 'present_scale_shots')
const FIG_MIME = 'application/x-spyde-figure'

// A 480×300 PNG — a blue disc in a bordered navy panel. Deliberately NOT a 1×1
// pixel: the screenshot is the actual verification here, and a 1-pixel image
// satisfies every assertion while showing nothing, so it would prove the slot
// was filled without proving anything was DRAWN in it.
const PHOTO = join(__dirname, 'fixtures', 'split-photo.png')
const PHOTO_URL =
  'data:image/png;base64,' + readFileSync(PHOTO).toString('base64')

// Slide 1: sparse — a heading and four short bullets. THE case from the report.
const SPARSE = '## Motivation\n\n- Code base solutions are good, but…\n' +
  '- Sometimes all you want is a black box\n' +
  '- Black boxes are fine — if you can open them\n' +
  '- Data analysis software has to be tested\n'
// Slide 2: dense — long enough that scaling it up would overflow the stage.
const DENSE = '## A dense slide\n\n' + Array.from({ length: 7 }, (_, i) =>
  `- Bullet ${i + 1}: a deliberately long line of body copy that exists purely ` +
  'to push this slide past the density threshold so it keeps prose sizing.\n').join('')

let ctx: Awaited<ReturnType<typeof launchApp>>

test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true })
  mkdirSync(SCALE_SHOTS, { recursive: true })
  // Real Dask: the scaling test puts a LIVE figure on a slide.
  ctx = await launchApp({ dask: true, env: { SPYDE_LOG_LEVEL: 'WARNING' } })
  await ctx.page.waitForTimeout(1500)
})

test.afterAll(async () => {
  try { ctx?.assertNoJsErrors() } finally { await ctx?.app?.close() }
})

test('stacked splits render, sparse text fills, a dropped PNG fills the slot', async () => {
  const { page } = ctx

  await page.getByTestId('toggle-report').click()
  await expect(page.getByTestId('report-sidebar')).toBeVisible()
  await backendAction(page, 'report_new', { type: 'presentation' })

  await backendAction(page, 'report_add_cell', { source: SPARSE })
  await backendAction(page, 'report_add_cell', { source: DENSE, slide_break: true })
  await backendAction(page, 'report_add_split_cell', {
    source: '## Stacked\n\nText above, picture below.\n',
    layout: 'text-top', slide_break: true,
  })

  await expect
    .poll(async () => page.getByTestId(/^report-slide-\d+$/).count(),
          { timeout: 60_000, message: 'the seeded deck produced no slides' })
    .toBe(3)

  // ── 3. the dropped-PNG path: fill the split's slot, don't append ───────────
  // The split cell carries its id in its testid; the empty figure side shows a
  // dropzone until something fills it.
  const splitTestId = await page.locator('[data-testid^="report-splitcell-"]')
    .first().getAttribute('data-testid')
  const splitId = (splitTestId || '').replace('report-splitcell-', '')
  expect(splitId, 'could not resolve the split cell id').not.toBe('')
  await expect(page.getByTestId(`report-split-dropzone-${splitId}`)).toBeVisible()

  const cellsBefore = await page.locator('[data-report-cell="1"]').count()
  await backendAction(page, 'report_set_cell_image', {
    cell_id: splitId, image_b64: PHOTO_URL, image_ext: 'png',
  })
  // The dropzone gives way to the picture, IN the same cell.
  await expect(page.getByTestId(`report-split-dropzone-${splitId}`))
    .toBeHidden({ timeout: 15_000 })
  expect(await page.locator('[data-report-cell="1"]').count(),
         'filling a slot must not append a new cell').toBe(cellsBefore)

  // ── Present ────────────────────────────────────────────────────────────────
  await page.getByTestId('report-present').click()
  const stage = page.locator('[data-testid="present-slide"][data-active="1"]')
  await expect(stage).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(1200)

  // ── 2. sparse fills, dense does not ───────────────────────────────────────
  await page.screenshot({ path: join(SHOTS, '01-sparse-fill.png') })
  expect(await stage.getAttribute('data-fill'),
         'a sparse text slide should take the large fill tier').toBe('lg')
  const sparsePx = await stage.locator('.present-md').first()
    .evaluate(el => parseFloat(getComputedStyle(el).fontSize))

  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(700)
  await page.screenshot({ path: join(SHOTS, '02-dense-base.png') })
  expect(await stage.getAttribute('data-fill'),
         'a dense text slide must keep prose sizing').toBe('base')
  const densePx = await stage.locator('.present-md').first()
    .evaluate(el => parseFloat(getComputedStyle(el).fontSize))

  // The whole point: the sparse slide is VISIBLY bigger, not marginally.
  expect(sparsePx, `sparse ${sparsePx}px vs dense ${densePx}px`)
    .toBeGreaterThan(densePx * 1.25)

  // A scaled-up slide that overflows is a regression, not a feature.
  const denseOverflow = await stage.evaluate((el: HTMLElement) =>
    el.scrollHeight - el.clientHeight)
  expect(denseOverflow, 'the dense slide overflows its stage').toBeLessThanOrEqual(2)

  // ── 1. the stacked split ──────────────────────────────────────────────────
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(700)
  await page.screenshot({ path: join(SHOTS, '03-split-text-top.png') })

  const split = stage.locator('[data-testid^="present-split-"]')
  await expect(split).toBeVisible()
  expect(await split.getAttribute('data-layout'),
         'the split lost its layout on the way to the slide').toBe('text-top')

  // The photo really renders on the slide, at a size worth looking at — not a
  // collapsed 0-height box that every geometry assertion below would still pass.
  const img = split.locator('img')
  await expect(img).toBeVisible()
  const box = await img.boundingBox()
  expect(box!.height, 'the dropped photo rendered too small to see')
    .toBeGreaterThan(120)

  // ONE grid column is what "stacked" means. Two columns here is exactly the
  // old bug: the document said text-top and the slide drew text-left.
  const cols = await split.evaluate(
    (el: HTMLElement) => getComputedStyle(el).gridTemplateColumns)
  expect(cols.trim().split(/\s+/).length,
         `stacked split rendered ${cols} — expected a single column`).toBe(1)

  // The text really is ABOVE the picture, not merely in a one-column grid.
  const order = await split.evaluate((el: HTMLElement) => {
    const kids = Array.from(el.children) as HTMLElement[]
    const text = kids.find(k => k.querySelector('h2'))
    const fig = kids.find(k => k.querySelector('img') || k !== text)
    return { textTop: text?.getBoundingClientRect().top ?? 0,
             figTop: fig?.getBoundingClientRect().top ?? 0 }
  })
  expect(order.figTop, 'text-top must put the text above the figure')
    .toBeGreaterThan(order.textTop)

  await page.keyboard.press('Escape')
  await expect(stage).toBeHidden({ timeout: 15_000 })

  const errs = backendErrorLines(ctx.backend)
  expect(errs, `backend errors:\n${errs.join('\n')}`).toEqual([])
})

// ── 4. the slide sizes to the display ─────────────────────────────────────────

/** The id a drag of this window pill would carry — the window id the backend
 *  verbs take. */
async function windowIdFromPill(page: any, pillSelector: string): Promise<number> {
  return await page.evaluate(({ selector, mime }: any) => {
    const pill = document.querySelector(selector) as HTMLElement
    if (!pill) return NaN
    const transfer = new DataTransfer()
    const event = new DragEvent('dragstart', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: transfer, configurable: true })
    pill.dispatchEvent(event)
    try { return Number(JSON.parse(transfer.getData(mime)).windowId) } catch { return NaN }
  }, { selector: pillSelector, mime: FIG_MIME })
}

async function reportCells(page: any): Promise<any[]> {
  return await page.evaluate(
    () => (window as any)._spyde_test_report?.()?.cells ?? [])
}

/** Resize the Present window's CONTENT to exactly width × height — what moving
 *  it onto a display of that size does. */
async function setWindowContentSize(width: number, height: number) {
  await ctx.app.evaluate(({ BrowserWindow }: any, size: number[]) => {
    const appWindow = BrowserWindow.getAllWindows()[0]
    if (appWindow.isMaximized()) appWindow.unmaximize()
    appWindow.setContentSize(size[0], size[1])
  }, [width, height])
  await expect.poll(
    () => ctx.page.evaluate(() => [window.innerWidth, window.innerHeight]),
    { timeout: 10_000, message: `the window never reached ${width}×${height}` },
  ).toEqual([width, height])
}

async function goToSlide(page: any, index: number) {
  await page.keyboard.press('Home')
  for (let i = 0; i < index; i++) await page.keyboard.press('ArrowRight')
}

/** The widest canvas backing store inside the active slide's figure. The
 *  figure frame is a separate document (possibly out of process), so this goes
 *  through Playwright's frame rather than `contentDocument`, and into shadow
 *  roots, where the figure's widgets keep their canvases. */
async function figureCanvasWidth(page: any): Promise<number> {
  const frameElement = await page
    .locator('[data-testid="present-slide"][data-active="1"] iframe').first()
    .elementHandle()
  const frame = await frameElement?.contentFrame()
  if (!frame) return 0
  return await frame.evaluate(() => {
    let widest = 0
    const visit = (root: Document | ShadowRoot) => {
      for (const element of Array.from(root.querySelectorAll('*'))) {
        if (element instanceof HTMLCanvasElement) widest = Math.max(widest, element.width)
        if (element.shadowRoot) visit(element.shadowRoot)
      }
    }
    visit(document)
    return widest
  })
}

/** Everything on the active slide that has to scale, plus whether it fits. */
async function measureActiveSlide(page: any) {
  return await page.evaluate(() => {
    const stage = document.querySelector('[data-testid="present-stage"]') as HTMLElement | null
    const slide = document.querySelector(
      '[data-testid="present-slide"][data-active="1"]') as HTMLElement
    const fontSize = (selector: string) => {
      const element = slide.querySelector(selector)
      return element ? parseFloat(getComputedStyle(element).fontSize) : 0
    }
    const split = slide.querySelector('[data-testid^="present-split-"]') as HTMLElement | null
    const picturePane = split
      ? (Array.from(split.children) as HTMLElement[]).find(child => !child.querySelector('h2'))
      : null
    const frame = slide.querySelector('iframe')
    // The width the picture is DRAWN at: an object-fit box can be wider than
    // the pixels inside it, so this is the box fitted to the image aspect.
    const picture = picturePane?.querySelector('img') as HTMLImageElement | null
    const pictureBox = picture?.getBoundingClientRect()
    const pictureWidth = picture && pictureBox && picture.naturalHeight
      ? Math.min(pictureBox.width,
                 pictureBox.height * picture.naturalWidth / picture.naturalHeight)
      : 0
    const stageBox = (stage ?? slide).getBoundingClientRect()
    return {
      scale: stage ? parseFloat(stage.dataset.scale ?? '0') : 0,
      stageWidth: stageBox.width,
      stageHeight: stageBox.height,
      stageInsideWindow: stageBox.left >= -1 && stageBox.top >= -1
        && stageBox.right <= window.innerWidth + 1 && stageBox.bottom <= window.innerHeight + 1,
      overflow: slide.scrollHeight - slide.clientHeight,
      heading: fontSize('.present-md h2'),
      body: fontSize('.present-md li'),
      picturePaneWidth: picturePane?.getBoundingClientRect().width ?? 0,
      pictureWidth,
      frameWidth: frame?.getBoundingClientRect().width ?? 0,
    }
  })
}

test('a slide sizes to the display: text, split panes and figures scale together', async () => {
  const { page } = ctx

  // A side-by-side split, to measure a pane, and a live figure slide.
  await backendAction(page, 'report_add_split_cell', {
    source: '## Beside the picture\n\n- The pane keeps its share\n- At any size\n',
    layout: 'text-left', slide_break: true,
  })
  let splitId = ''
  await expect.poll(async () => {
    const splits = (await reportCells(page)).filter(cell => cell.cell_type === 'split')
    splitId = splits.length === 2 ? splits[1].id : ''
    return splitId
  }, { timeout: 15_000 }).not.toBe('')
  await backendAction(page, 'report_set_cell_image', {
    cell_id: splitId, image_b64: PHOTO_URL, image_ext: 'png',
  })

  await backendAction(page, 'load_test_data_si_grains')
  await waitForSubwindowCount(page, 2, 120_000)
  await page.waitForTimeout(1500)
  const signalPill = page.getByTestId('subwindow')
    .filter({ has: page.getByTestId('window-breadcrumb').filter({ hasText: /^S-/ }) })
    .first().getByTestId('window-breadcrumb')
  await signalPill.evaluate((element: HTMLElement) =>
    element.setAttribute('data-scale-source', '1'))
  const signalWindowId = await windowIdFromPill(page, '[data-scale-source="1"]')
  expect(Number.isFinite(signalWindowId), 'no signal window id').toBe(true)
  await backendAction(page, 'report_add_figure', {
    source_window_id: signalWindowId, slide_break: true,
  })
  await expect.poll(async () => page.getByTestId(/^report-slide-\d+$/).count(),
                    { timeout: 60_000 }).toBe(5)

  await page.getByTestId('report-present').click()
  await expect(page.locator('[data-testid="present-slide"][data-active="1"]'))
    .toBeVisible({ timeout: 30_000 })

  const TEXT_SLIDE = 0, DENSE_SLIDE = 1, SPLIT_SLIDE = 3, FIGURE_SLIDE = 4
  const sizes: [string, number, number][] = [['720p', 1280, 720], ['1440p', 2560, 1440]]
  const measured: Record<string, any> = {}
  for (const [name, width, height] of sizes) {
    await setWindowContentSize(width, height)
    await page.waitForTimeout(600)

    await goToSlide(page, TEXT_SLIDE)
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(SCALE_SHOTS, `${name}-text.png`) })
    const text = await measureActiveSlide(page)

    // The dense slide is only checked for fit: it is the one that would
    // overflow if the scale ran ahead of the stage.
    await goToSlide(page, DENSE_SLIDE)
    await page.waitForTimeout(300)
    const dense = await measureActiveSlide(page)

    await goToSlide(page, SPLIT_SLIDE)
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(SCALE_SHOTS, `${name}-split.png`) })
    const split = await measureActiveSlide(page)

    await goToSlide(page, FIGURE_SLIDE)
    // The figure re-renders at its new size once the resize settles; wait for
    // its canvas to stop changing before reading or shooting it.
    let previous = -1, canvasWidth = 0
    await expect.poll(async () => {
      previous = canvasWidth
      canvasWidth = await figureCanvasWidth(page)
      return canvasWidth > 0 && canvasWidth === previous
    }, { timeout: 30_000, intervals: [700] }).toBe(true)
    await page.screenshot({ path: join(SCALE_SHOTS, `${name}-figure.png`) })
    const figure = { ...(await measureActiveSlide(page)), canvasWidth }

    measured[name] = { text, dense, split, figure }
  }
  console.log('[present-scale]', JSON.stringify(measured))
  await page.keyboard.press('Escape')

  const small = measured['720p'], large = measured['1440p']
  const ratio = large.text.scale / small.text.scale
  expect(ratio, 'the stage did not scale with the window').toBeGreaterThan(1.9)
  const scalesWithStage = (label: string, smallValue: number, largeValue: number) => {
    expect(smallValue, `${label} missing at 720p`).toBeGreaterThan(0)
    const observed = largeValue / smallValue
    expect(Math.abs(observed / ratio - 1),
           `${label} scaled ×${observed.toFixed(3)}, the stage ×${ratio.toFixed(3)}`)
      .toBeLessThan(0.03)
  }
  scalesWithStage('heading font', small.text.heading, large.text.heading)
  scalesWithStage('body font', small.text.body, large.text.body)
  scalesWithStage('split picture pane', small.split.picturePaneWidth, large.split.picturePaneWidth)
  scalesWithStage('split picture', small.split.pictureWidth, large.split.pictureWidth)
  scalesWithStage('split heading font', small.split.heading, large.split.heading)
  scalesWithStage('figure box', small.figure.frameWidth, large.figure.frameWidth)

  // Crisp, not stretched: the live figure re-rendered with a backing store that
  // grew with its box rather than keeping its old pixels.
  expect(large.figure.canvasWidth / small.figure.canvasWidth,
         'the figure canvas did not re-render at the larger size')
    .toBeGreaterThan(ratio * 0.9)

  for (const [name] of sizes) {
    for (const [kind, slide] of Object.entries(measured[name]) as [string, any][]) {
      expect(slide.overflow, `${kind} slide overflows at ${name}`).toBeLessThanOrEqual(2)
      expect(slide.stageInsideWindow, `${kind} stage leaves the window at ${name}`).toBe(true)
    }
  }

  const errors = backendErrorLines(ctx.backend)
  expect(errors, `backend errors:\n${errors.join('\n')}`).toEqual([])
})
