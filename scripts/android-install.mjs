// Install the most recent Android APK onto a connected device and launch it.
//
// Tauri's `android dev` cannot run on a Windows host (cargo-mobile2 only opens
// Android Studio there), so JS iteration uses this build+install loop instead:
//   npm run android:install            # current ABI, first connected device
//   npm run android:install -- <serial>
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')
const apkRoot = path.join(repoRoot, 'app/flowix-desktop/gen/android/app/build/outputs/apk')

function findSdk() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : undefined,
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'platform-tools'))) return path.resolve(candidate)
  }
  throw new Error(`Android SDK not found (checked: ${candidates.join(', ')}). Set ANDROID_HOME.`)
}

const adb = path.join(findSdk(), 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb')

function run(args, capture = false) {
  const result = spawnSync(adb, args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`adb ${args.join(' ')} failed`)
  return result.stdout ?? ''
}

const requested = process.argv[2]
const devices = run(['devices'], true)
  .split('\n')
  .slice(1)
  .map((line) => line.trim().split(/\s+/))
  .filter(([serial, state]) => serial && state === 'device')
  .map(([serial]) => serial)

if (devices.length === 0) throw new Error('No connected Android device')
const serial = requested ?? devices[0]
if (!devices.includes(serial)) throw new Error(`Device ${serial} is not connected (have: ${devices.join(', ')})`)

const abi = run(['-s', serial, 'shell', 'getprop', 'ro.product.cpu.abi'], true).trim()
const apkDir = abi === 'x86_64' ? 'x86_64' : abi.startsWith('arm64') ? 'arm64' : 'armeabi-v7a'
const flavorDir = path.join(apkRoot, apkDir, 'debug')
if (!existsSync(flavorDir)) throw new Error(`No APK for ${abi}; run "npm run tauri:android:build -- --debug --apk --split-per-abi --target ${abi === 'x86_64' ? 'x86_64' : 'aarch64'}" first`)

const apk = readdirSync(flavorDir)
  .filter((name) => name.endsWith('.apk'))
  .map((name) => path.join(flavorDir, name))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
if (!apk) throw new Error(`No APK found in ${flavorDir}`)

const sizeMb = (statSync(apk).size / 1024 / 1024).toFixed(1)
process.stdout.write(`Installing ${path.basename(apk)} (${sizeMb} MB) to ${serial} (${abi})\n`)
run(['-s', serial, 'install', '-r', apk])
run(['-s', serial, 'shell', 'monkey', '-p', 'com.flowix.app', '-c', 'android.intent.category.LAUNCHER', '1'], true)
process.stdout.write('Launched com.flowix.app\n')
