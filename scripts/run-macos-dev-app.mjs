#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
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

const openArgs = ['-W', '-a', appPath]
for (const name of ['FLOWIX_PI_PROVIDER_CATALOG']) {
  const value = process.env[name]
  if (value) openArgs.push('--env', `${name}=${value}`)
}
openArgs.push('--args', ...appArgs)

const result = spawnSync('/usr/bin/open', openArgs, {
  cwd: repoRoot,
  env: process.env,
  stdio: 'inherit',
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
