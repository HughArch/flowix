import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')
const appPath = path.join(repoRoot, '.build', 'macos-dev', 'Flowix Dev.app')
const contentsPath = path.join(appPath, 'Contents')
const executableDirectory = path.join(contentsPath, 'MacOS')
const executablePath = path.join(executableDirectory, 'flowix-desktop')
const targetDirectory = process.env.CARGO_TARGET_DIR || path.join(repoRoot, '.build', 'cargo-target')
const target = path.join(targetDirectory, 'debug', 'flowix-desktop')
const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

mkdirSync(executableDirectory, { recursive: true })
rmSync(executablePath, { force: true })
symlinkSync(path.relative(executableDirectory, target), executablePath)
writeFileSync(path.join(contentsPath, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>flowix-desktop</string>
<key>CFBundleIdentifier</key><string>com.flowix-dev.app</string>
<key>CFBundleName</key><string>Flowix Dev</string>
<key>CFBundleDisplayName</key><string>Flowix Dev</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleURLTypes</key><array><dict>
<key>CFBundleURLName</key><string>com.flowix-dev.app.deeplink</string>
<key>CFBundleTypeRole</key><string>Editor</string>
<key>CFBundleURLSchemes</key><array><string>flowix-dev</string></array>
</dict></array>
</dict></plist>
`)

spawnSync(lsregister, ['-u', appPath], { stdio: 'ignore' })
const result = spawnSync(lsregister, ['-f', '-R', appPath], { stdio: 'inherit' })
if (result.error) throw result.error
if (result.status !== 0) throw new Error(`Launch Services registration failed: ${result.status}`)
process.stdout.write('Registered the Flowix Dev callback protocol.\n')
