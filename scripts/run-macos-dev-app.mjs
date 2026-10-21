#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appPath = path.join(repoRoot, '.build', 'macos-dev', 'Flowix Dev.app')
const registerScript = path.join(repoRoot, 'scripts', 'register-macos-dev-app.mjs')
const runnerArgs = process.argv.slice(2)
const separator = runnerArgs.indexOf('--')
const cargoArgs = separator < 0 ? runnerArgs : runnerArgs.slice(0, separator)
const appArgs = separator < 0 ? [] : runnerArgs.slice(separator + 1)

if (cargoArgs[0] !== 'run') throw new Error(`Unexpected Tauri runner arguments: ${runnerArgs.join(' ')}`)

// Tauri's custom runner replaces `cargo run`; build the same target first,
// then let Launch Services start the registered bundle around that binary.
const build = spawnSync('cargo', ['build', ...cargoArgs.slice(1)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
})
if (build.error) throw build.error
if (build.status !== 0) process.exit(build.status ?? 1)

// Register the bundle before Launch Services starts it. The executable is a
// symlink to Tauri's debug binary, but launching through the bundle gives the
// running process the Dev bundle identity required for macOS app activation.
const registration = spawnSync(process.execPath, [registerScript], {
  cwd: repoRoot,
  env: process.env,
  stdio: 'inherit',
})
if (registration.error) throw registration.error
if (registration.status !== 0) process.exit(registration.status ?? 1)

// Launch Services owns the app process, so killing `open -W` alone does not
// stop it. Reusing that process after a rebuild leaves new JS talking to old
// Rust commands. Match this checkout's executable only, never production.
const executablePath = realpathSync(path.join(appPath, 'Contents', 'MacOS', 'flowix-desktop'))
function devAppPids() {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('Unable to inspect the running Dev executable')
  return result.stdout.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    return match && match[2] === executablePath ? [Number(match[1])] : []
  })
}

async function stopDevApp() {
  const pids = devAppPids()
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM') }
    catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  const deadline = Date.now() + 5_000
  while (pids.some(pid => {
    try { process.kill(pid, 0); return true }
    catch (error) { if (error.code === 'ESRCH') return false; throw error }
  })) {
    if (Date.now() >= deadline) throw new Error('The previous Dev app did not exit after SIGTERM')
    await delay(100)
  }
}

await stopDevApp()
const openArgs = ['-n', '-W', '-a', appPath]
for (const name of ['FLOWIX_PI_PROVIDER_CATALOG']) {
  const value = process.env[name]
  if (value) openArgs.push('--env', `${name}=${value}`)
}
openArgs.push('--args', ...appArgs)

const launcher = spawn('/usr/bin/open', openArgs, {
  cwd: repoRoot,
  env: process.env,
  stdio: 'inherit',
})
let stopping = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    void stopDevApp().then(() => {
      launcher.kill(signal)
      process.exit(signal === 'SIGINT' ? 130 : 143)
    }).catch(error => {
      console.error(error)
      process.exit(1)
    })
  })
}
launcher.on('error', error => { throw error })
launcher.on('exit', (code, signal) => {
  if (!stopping) process.exitCode = code ?? (signal ? 1 : 0)
})
