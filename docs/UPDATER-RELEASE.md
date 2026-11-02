---
key: luofjg67
---

# Flownote updater release

Flownote ships per-platform update manifests and static website downloads:

- **Per-platform updater manifests** under stable R2 paths, served directly to
  the in-app updater. Each one advertises exactly one release platform
  group's binaries and pins its own top-level `version`.
- **Version-prefixed R2 artifacts** (`v<version>/...`) that the manifests point
  at. These are immutable per release. Flownote updater archives are signed with
  the Tauri updater key; the client verifies the `.sig` value from the HTTPS
  manifest before installation. The standalone DSH runtime is also checked
  with SHA-256 and the same Tauri/Minisign signature before installation.

Per-platform updater manifests live on R2 (under `${FLOWNOTE_R2_PUBLIC_BASE}/${FLOWNOTE_R2_UPDATER_PREFIX}/`) so each release can overwrite the stable URL without rebuilding flownote-home. The split exists so that macOS and Windows can ship on independent cadences —
macOS can publish `1.3.0` while Windows stays on `1.2.4` without confusing
either client into a self-install loop.

Manifests include `notify: true` by default. Set `FLOWNOTE_UPDATE_NOTIFY=false`
when publishing a release that should remain available to manual checks but must
not show the automatic status-bar update button. The release is still detected
by the updater and can be installed from Preferences.

## Manifest layout

| Manifest                          | Consumer             | Stable URL                                       |
| --------------------------------- | -------------------- | ------------------------------------------------ |
| `updater/macos/latest.json`       | Flownote custom updater | `https://download.flownote.cc/updater/macos/latest.json`      |
| `updater/windows/latest.json`     | Flownote custom updater | `https://download.flownote.cc/updater/windows/latest.json`    |
| `updater/linux/latest.json`       | Flownote custom updater | `https://download.flownote.cc/updater/linux/latest.json`      |

Each per-platform manifest's `platforms` block contains only its own group:

| Manifest                | `platforms` keys                        |
| ----------------------- | --------------------------------------- |
| `updater/macos/...`     | `darwin-aarch64`, `darwin-x86_64`       |
| `updater/windows/...`   | `windows-x86_64`                        |
| `updater/linux/...`     | `linux-x86_64`                          |

The updater picks the manifest containing
its current OS-arch key, so a misconfigured binary that points at the wrong
group manifest will fail the update check rather than silently offering nothing.

## Release scope

`scripts/release.sh` infers the release scope from `FLOWNOTE_TARGETS`:

- **Full release** — writes/uploads all covered per-platform manifests and
  rebuilds/deploys the flownote-home website.
- **Partial release** — writes/uploads only the covered per-platform manifests;
  the website is not rebuilt or deployed.

## Environment overrides

| Variable                            | Default                                              | Notes |
| ----------------------------------- | ---------------------------------------------------- | ----- |
| `FLOWNOTE_R2_UPDATER_PREFIX`          | `updater`                                            | R2 key prefix for per-platform manifests |
| `FLOWNOTE_R2_PREFIX`                  | `v${VERSION}`                                        | R2 key prefix for versioned artifacts (unchanged) |
| `FLOWNOTE_R2_BUCKET`                  | `flownote-downloads`                                   | R2 bucket (unchanged) |
| `FLOWNOTE_R2_PUBLIC_BASE`             | `https://download.flownote.cc`                   | Public origin for artifact URLs (unchanged) |

## Publish flow

```bash
# Full release from a freshly built matrix
FLOWNOTE_SKIP_BUILD=1 \
FLOWNOTE_TARGETS="aarch64-apple-darwin x86_64-apple-darwin x86_64-pc-windows-msvc x86_64-unknown-linux-gnu" \
FLOWNOTE_PUBLISH=1 \
bash scripts/release.sh
```

```bash
# Partial release — only Windows (e.g. when macOS is held back)
FLOWNOTE_SKIP_BUILD=1 \
FLOWNOTE_TARGETS="x86_64-pc-windows-msvc" \
FLOWNOTE_PUBLISH=1 \
bash scripts/release.sh
```

Both flows upload the per-group manifest to the matching stable R2 path so the
in-app updater picks up the new version immediately. Full releases also deploy
the website's download links through flownote-home.

For macOS, the updater artifact is the Tauri `.app.tar.gz` archive; the DMG is
published separately for website downloads. For Windows, the updater artifact
is the Tauri NSIS `*-setup.exe`. Both updater artifacts have adjacent `.sig`
files and are installed by `tauri-plugin-updater`; the Windows NSIS package
continues to use its `/UPDATE` replacement flow.

Production Flownote builds require `TAURI_SIGNING_PRIVATE_KEY` (and optionally
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`). `FLOWNOTE_ALLOW_UNSIGNED=1` is reserved
for local builds and disables updater artifact generation.

## Verifying a manifest locally

`scripts/verify-updater-release.mjs` validates a single manifest against the
artifacts on disk:

```bash
node scripts/verify-updater-release.mjs \
  --release-dir "$RELEASE_OUT" \
  "$RELEASE_OUT/updater/macos/latest.json" \
  "$VERSION" "v$VERSION" \
  darwin-aarch64 darwin-x86_64
```

`--release-dir` defaults to the manifest's parent directory, but per-group
manifests live under `updater/<group>/` while artifacts are staged at the
top level of `$RELEASE_OUT`, so the override is required in this flow.
