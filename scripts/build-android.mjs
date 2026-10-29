// Build the Android app through the Tauri CLI with a working NDK toolchain.
//
// Why this wrapper exists: `ring` compiles C via cc-rs, which looks for NDK
// tool names removed after NDK r19 (`arm-linux-androideabi-clang`). Newer NDKs
// only ship API-suffixed wrappers (`armv7a-linux-androideabi24-clang.cmd`), so
// a plain `tauri android build` fails for every target whose compiler cc-rs
// cannot auto-locate. This script pins CC/CXX/AR per Rust target to the
// wrapper binaries and then forwards all arguments to `tauri android build`.
//
// Usage: npm run tauri:android:build -- <tauri android build args>
// e.g.   npm run tauri:android:build -- --debug --apk
//        npm run tauri:android:build -- --debug --apk --target aarch64

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')
const tauriEntrypoint = path.resolve(repoRoot, 'node_modules/@tauri-apps/cli/tauri.js')

function findSdk() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk')
      : undefined,
  ].filter(Boolean)
  for (const candidate of candidates) {
    // Distinguish a real SDK root from a stray env var pointing nowhere.
    if (existsSync(path.join(candidate, 'platform-tools'))) {
      return path.resolve(candidate)
    }
  }
  throw new Error(
    `Android SDK not found (checked: ${candidates.join(', ')}). Set ANDROID_HOME to the SDK root.`,
  )
}

function compareVersions(a, b) {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) - (right[i] || 0)
  }
  return 0
}

function findNdkHome(sdk) {
  const dir = path.join(sdk, 'ndk')
  if (!existsSync(dir)) {
    throw new Error(`No NDK installed under ${dir}. Install one via Android Studio or sdkmanager.`)
  }
  const versions = readdirSync(dir)
    .filter((entry) => /^\d+\.\d+\.\d+/.test(entry))
    .sort(compareVersions)
  const newest = versions.at(-1)
  if (!newest) throw new Error(`No NDK version directory found under ${dir}.`)
  return path.join(dir, newest)
}

// Rust target triple -> NDK toolchain prefix. armv7 is spelled differently on
// each side (`armv7-linux-androideabi` vs `armv7a-linux-androideabi`).
const RUST_TARGET_TOOLS = [
  ['aarch64-linux-android', 'aarch64-linux-android'],
  ['armv7-linux-androideabi', 'armv7a-linux-androideabi'],
  ['i686-linux-android', 'i686-linux-android'],
  ['x86_64-linux-android', 'x86_64-linux-android'],
]

// cc-rs env vars use underscores for the target triple.
const envKeyFor = (target, tool) =>
  `${tool}_${target.replaceAll('-', '_')}`

function compilerEnv(ndkHome) {
  const hostDir = {
    win32: 'windows-x86_64',
    darwin: 'darwin-x86_64',
    linux: 'linux-x86_64',
  }[process.platform]
  if (!hostDir) throw new Error(`Unsupported host platform: ${process.platform}`)
  const bin = path.join(ndkHome, 'toolchains', 'llvm', 'prebuilt', hostDir, 'bin')
  if (!existsSync(bin)) throw new Error(`NDK toolchain bin not found: ${bin}`)
  const listing = readdirSync(bin)

  const childEnv = { ...process.env }
  for (const [target, toolPrefix] of RUST_TARGET_TOOLS) {
    // Lowest available API level: compiling C against the oldest shipped
    // headers stays compatible with every wrapper the NDK provides.
    const wrapper = new RegExp(`^${toolPrefix}(\\d+)-clang(\\.cmd)?$`)
    const api = listing
      .map((name) => wrapper.exec(name)?.[1])
      .filter(Boolean)
      .sort((a, b) => Number(a) - Number(b))[0]
    if (!api) {
      process.stdout.write(`note: no NDK wrapper for ${toolPrefix}, leaving ${target} alone\n`)
      continue
    }
    const suffix = process.platform === 'win32' ? '.cmd' : ''
    const cc = path.join(bin, `${toolPrefix}${api}-clang${suffix}`)
    const cxx = path.join(bin, `${toolPrefix}${api}-clang++${suffix}`)
    const ar = path.join(bin, process.platform === 'win32' ? 'llvm-ar.exe' : 'llvm-ar')
    Object.assign(childEnv, {
      [envKeyFor(target, 'CC')]: cc,
      [envKeyFor(target, 'CXX')]: cxx,
      [envKeyFor(target, 'AR')]: ar,
    })
  }
  return childEnv
}

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
    shell: false,
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const sdk = findSdk()
const ndkHome = findNdkHome(sdk)
const childEnv = compilerEnv(ndkHome)
childEnv.ANDROID_HOME = sdk
childEnv.ANDROID_SDK_ROOT = sdk
// Keep Android artifacts beside the desktop ones, matching the other build scripts.
childEnv.CARGO_TARGET_DIR = path.resolve(
  process.env.CARGO_TARGET_DIR || path.resolve(repoRoot, '.build/cargo-target'),
)

const forwarded = process.argv.slice(2)
const devMode = forwarded[0] === '--dev'
// --with-debuginfo selects the symbol policy above; the editor script must not
// forward it to the Tauri CLI.
const tauriArgs = (devMode ? forwarded.slice(1) : forwarded).filter((arg) => arg !== '--with-debuginfo')
const subcommand = devMode ? 'dev' : 'build'
// Debug APKs ship the Rust library with full DWARF by default (~450 MB), which
// makes every `adb install` a minute-long transfer. JS iteration never needs it,
// so drop debug info for debug Android builds; the dev profile is still
// unoptimized. Pass --with-debuginfo to keep symbols for native debugging.
if (forwarded.includes('--debug') && !forwarded.includes('--with-debuginfo')) {
  childEnv.CARGO_PROFILE_DEV_DEBUG = '0'
  // Symbols are not needed to drive JS iteration; stripping them roughly halves
  // the shared library and every install.
  childEnv.CARGO_PROFILE_DEV_STRIP = 'symbols'
}
process.stdout.write(`Android SDK: ${sdk}\nNDK: ${ndkHome}\ntauri android ${subcommand} ${tauriArgs.join(' ')}\n`)
run(process.execPath, [tauriEntrypoint, 'android', subcommand, ...tauriArgs], childEnv)
