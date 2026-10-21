#!/usr/bin/env node
// CHROME_BIN=/path/to/chrome node scripts/check-editor-tag-layout.mjs
// --fixture-only keeps an HTML fixture for manual checks in other browsers.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureOnly = process.argv.includes('--fixture-only');
const chrome = process.env.CHROME_BIN ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find(existsSync);
assert(fixtureOnly || chrome, 'Set CHROME_BIN to a Chromium browser, or use --fixture-only.');

const folder = await mkdtemp(join(tmpdir(), 'flowix-tag-layout-'));
try {
  await build({
    absWorkingDir: root,
    entryPoints: ['scripts/fixtures/editor-tag-layout.js'],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    alias: { '@': resolve(root, 'app/flowix-web') },
    loader: { '.woff2': 'file' },
    outfile: join(folder, 'probe.js'),
  });
  const html = join(folder, 'probe.html');
  await writeFile(html, `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="probe.css">
<style>
:root { --font-sans: Inter; --document-tag-bg: #bdd; --muted: #eee; --brand: teal;
  --primary-foreground: #222; --document-foreground: #222; }
.markdown-editor { height: auto; overflow: visible; }
.markdown-editor .ProseMirror { min-height: 0; padding: 5px; max-width: 600px; }
</style>
<pre id="tag-layout-result">Running…</pre><script src="probe.js"></script>`);
  if (fixtureOnly) {
    console.log(pathToFileURL(html).href);
  } else {
    const { stdout } = await promisify(execFile)(chrome, [
      '--headless', '--disable-gpu', '--allow-file-access-from-files',
      `--user-data-dir=${join(folder, 'chrome')}`, '--virtual-time-budget=3000',
      '--dump-dom', pathToFileURL(html).href,
    ], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
    const match = stdout.match(/<pre id="tag-layout-result">(.*?)<\/pre>/s);
    assert(match, 'Browser did not return a layout report.');
    const result = JSON.parse(match[1]);
    assert(result.ok, result.error);
    assert.equal(result.cases.length, 12);
    console.log('Editor tag layout passed: 12 layout/edit cases; property and table note-tag colors verified.');
  }
} finally {
  if (!fixtureOnly) await rm(folder, { recursive: true, force: true });
}
