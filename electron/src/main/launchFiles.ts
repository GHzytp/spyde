/**
 * launchFiles.ts — the files the operating system asks SpyDE to open.
 *
 * A double-click, "Open with", or `SpyDE <file>` on a command line hands the
 * path over in one of two ways: on Windows and Linux it is a command-line
 * argument (of this process, or of a second launch that forwards it here), and
 * on macOS it arrives as an `open-file` event, often before the app is ready.
 * Either way the backend cannot load anything until it has started, so every
 * path waits in a queue that is released when the backend reports ready.
 *
 * Pure on purpose (no Electron import), so `node --test` can exercise it.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The file paths on a command line, made absolute against `cwd`.
 *
 * `argv[0]` is the executable. Run unpackaged (`electron .`, electron-vite's
 * dev launch, Playwright's `electron out/main/index.js`) the first positional
 * argument is the app itself, so `defaultApp` skips it. Anything starting with
 * `-` is a switch — Chromium's, Electron's, or macOS's `-psn_…` — and arguments
 * that do not name something on disk are dropped, so a stray positional never
 * reaches the user as a "File not found" error.
 */
export function filePathsFromArgv(
  argv: readonly string[],
  opts: { defaultApp: boolean; cwd: string; exists?: (path: string) => boolean },
): string[] {
  const exists = opts.exists ?? existsSync
  const positional = argv.slice(1).filter((arg) => arg !== '' && !arg.startsWith('-'))
  const candidates = opts.defaultApp ? positional.slice(1) : positional
  return candidates.map((arg) => resolve(opts.cwd, arg)).filter((path) => exists(path))
}

/**
 * Holds paths until `release` is given the function that opens one; from then
 * on a path is opened as soon as it is added.
 */
export class LaunchFileQueue {
  private pending: string[] = []
  private openPath: ((path: string) => void) | null = null

  add(paths: readonly string[]): void {
    if (this.openPath) paths.forEach(this.openPath)
    else this.pending.push(...paths)
  }

  release(openPath: (path: string) => void): void {
    this.openPath = openPath
    this.pending.splice(0).forEach(openPath)
  }
}
