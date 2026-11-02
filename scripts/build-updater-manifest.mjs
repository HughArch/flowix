// Generate a single updater manifest for a release.
//
// Inputs (env vars):
//   FLOWNOTE_MANIFEST_OUT       output file path (overwritten if exists)
//   FLOWNOTE_VERSION            Flownote version this release advertises
//   FLOWNOTE_R2_PUBLIC_BASE     public origin for artifact URLs (no trailing slash)
//   FLOWNOTE_R2_PREFIX          R2 key prefix under which artifacts were uploaded
//   FLOWNOTE_RELEASE_OUT        artifact staging directory
//   FLOWNOTE_RELEASE_NOTES      optional human-facing release notes
//   FLOWNOTE_UPDATE_NOTIFY      whether clients should show update prompts
//
// Inputs (positional argv):
//   <platform>|<artifact-name>   one per built target. Multiple rows may share
//                                the same `platform` (e.g. darwin-aarch64 and
//                                darwin-x86_64 both belong to the macos group).
//
// `platforms` only ever contains the rows we received. This is what makes
// partial releases safe: each platform's updater hits a manifest whose top-
// level `version` matches the artifact's actual version. The artifact and its
// adjacent `.sig` file are the signed Flownote updater package; DSH is not part
// of this manifest or signing flow.

import fs from 'node:fs';
import path from 'node:path';

const out = process.env.FLOWNOTE_MANIFEST_OUT;
const version = process.env.FLOWNOTE_VERSION;
const publicBase = process.env.FLOWNOTE_R2_PUBLIC_BASE?.replace(/\/$/u, '');
const prefix = process.env.FLOWNOTE_R2_PREFIX?.replace(/^\/+|\/+$/gu, '');
const releaseOut = process.env.FLOWNOTE_RELEASE_OUT;
const releaseNotes = process.env.FLOWNOTE_RELEASE_NOTES?.trim() || `Flownote ${version}`;
const notifyValue = process.env.FLOWNOTE_UPDATE_NOTIFY?.trim().toLowerCase() || 'true';
const rows = process.argv.slice(1);

if (!out || !version || !publicBase || prefix === undefined || !releaseOut) {
  throw new Error('build-updater-manifest: FLOWNOTE_MANIFEST_OUT, FLOWNOTE_VERSION, FLOWNOTE_R2_PUBLIC_BASE, FLOWNOTE_R2_PREFIX, and FLOWNOTE_RELEASE_OUT are required');
}
if (notifyValue !== 'true' && notifyValue !== 'false') {
  throw new Error('build-updater-manifest: FLOWNOTE_UPDATE_NOTIFY must be true or false');
}

const platforms = {};
for (const row of rows) {
  const separator = row.indexOf('|');
  if (separator < 0) continue;
  const platform = row.slice(0, separator);
  const name = row.slice(separator + 1);
  const artifact = path.join(releaseOut, name);
  if (!fs.existsSync(artifact)) {
    throw new Error(`build-updater-manifest: artifact is missing: ${artifact}`);
  }
  const signaturePath = `${artifact}.sig`;
  if (!fs.existsSync(signaturePath)) {
    throw new Error(`build-updater-manifest: updater signature is missing: ${signaturePath}`);
  }
  platforms[platform] = {
    url: `${publicBase}/${prefix}/${name}`,
    signature: fs.readFileSync(signaturePath, 'utf8').trim(),
  };
}

const manifest = {
  version,
  notify: notifyValue === 'true',
  notes: releaseNotes,
  pub_date: new Date().toISOString(),
  platforms,
};

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`==> wrote ${path.relative(process.cwd(), out)}`);
