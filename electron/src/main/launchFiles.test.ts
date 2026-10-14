/**
 * launchFiles.test.ts — which command-line arguments are files to open, and
 * that none is opened before the backend can load it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'

import { LaunchFileQueue, filePathsFromArgv } from './launchFiles.ts'

const CWD = resolve('/data')
const everythingExists = () => true

test('a packaged launch takes every positional argument after the executable', () => {
  const argv = ['C:\\Program Files\\SpyDE\\SpyDE.exe', 'C:\\scans\\a.hspy', 'b.mrc']
  assert.deepEqual(
    filePathsFromArgv(argv, { defaultApp: false, cwd: CWD, exists: everythingExists }),
    [resolve('C:\\scans\\a.hspy'), resolve(CWD, 'b.mrc')],
  )
})

test('an unpackaged launch skips the app path that follows the executable', () => {
  // `electron . scan.hspy` and electron-vite dev.
  assert.deepEqual(
    filePathsFromArgv(['electron', '.', 'scan.hspy'],
                      { defaultApp: true, cwd: CWD, exists: everythingExists }),
    [resolve(CWD, 'scan.hspy')],
  )
})

test('switches are skipped wherever they sit, including before the app path', () => {
  // Playwright launches `electron --inspect=0 --remote-debugging-port=0 <main> …`,
  // and a second instance's command line gains Chromium switches.
  const argv = ['electron', '--inspect=0', '--remote-debugging-port=0',
                'out/main/index.js', '--user-data-dir=/tmp/profile', 'scan.hspy',
                '--allow-file-access-from-files', '-psn_0_12345']
  assert.deepEqual(
    filePathsFromArgv(argv, { defaultApp: true, cwd: CWD, exists: everythingExists }),
    [resolve(CWD, 'scan.hspy')],
  )
})

test('a bare launch has no files', () => {
  assert.deepEqual(filePathsFromArgv(['SpyDE.exe'], { defaultApp: false, cwd: CWD }), [])
  assert.deepEqual(filePathsFromArgv(['electron', '.'], { defaultApp: true, cwd: CWD }), [])
})

test('an argument that names nothing on disk is dropped', () => {
  const onDisk = new Set([resolve(CWD, 'real.hspy')])
  assert.deepEqual(
    filePathsFromArgv(['SpyDE.exe', 'real.hspy', 'not-there.hspy'],
                      { defaultApp: false, cwd: CWD, exists: (p) => onDisk.has(p) }),
    [resolve(CWD, 'real.hspy')],
  )
})

test('paths wait for the backend, then open in arrival order', () => {
  const queue = new LaunchFileQueue()
  const opened: string[] = []
  queue.add(['a.hspy'])
  queue.add(['b.mrc', 'c.csb'])
  assert.deepEqual(opened, [])
  queue.release((path) => opened.push(path))
  assert.deepEqual(opened, ['a.hspy', 'b.mrc', 'c.csb'])
  queue.add(['d.de5'])
  assert.deepEqual(opened, ['a.hspy', 'b.mrc', 'c.csb', 'd.de5'])
})
