# Agent data ownership

Device-local notebook registration and repository mounts are stored in `~/.flowix/db/local.db`.

- `notebooks` owns notebook identity, display metadata, local root paths and order.
- `notebook_add_dirs` owns notebook-scoped repository mounts. The same directory may be mounted by multiple notebooks. A notebook deletion cascades to its mounts.
- `notebook_workspace_state` records migration completion and mount revisions.
- `app_state` stores selected notebook state; `notebook_setup_jobs` preserves first-open setup jobs.

The frontend Agent Store projects workspace data from IPC into memory. Its `workspace.resources` is derived from notebook mounts. Workspace data is neither persisted in localStorage nor merged from old browser caches. Agent model/skill catalogs and user preferences retain their existing browser persistence.

Repository selection commits a mount to a specific notebook. There is no independent global folder pool. Removing a mount does not affect another notebook's mount of the same path. Missing mounts remain visible and removable.

Flowix file IPC authorizes registered notebook roots and enabled mounted directories, together with existing explicit document grants. Agent submissions wait for initial workspace hydration; each conversation captures its own workspace snapshot. Backend chat and DSH command dispatch validate snapshot paths against current mounts, using notebook scope when present. Native Agent sandbox settings remain separate from these Flowix checks.

## Upgrade imports

- `index.db` is retired and is no longer opened or imported. After successful version initialization, copies in `~/.flowix/` and `~/.flowix/db/`, including SQLite companions, are moved to each directory's `rebuild-backups/<UUID>/` for manual recovery. Installations with only an old index must re-register their notebook folders.
- Each notebook's `.flowix/agent.json` is imported once. Older `agent-access.json.defaults.files` is a fallback for notebooks registered before the upgrade. Unattached global folder entries never create mounts.
- Missing notebook roots defer the mount import. Malformed legacy files fail without marking import complete, allowing a later retry. Successfully imported sources are not reread after mounts change.
- Old runtime defaults are exposed through a migration-only IPC and imported into the browser-owned user preference Store.

Legacy files are retained on disk for recovery, but normal workspace writes use only `local.db`.

On macOS, `~/.flowix/boot/bookmark.json` is the only bookmark store. Directory selections and successful access to registered notebook directories persist directory bookmarks; single-file selections persist file bookmarks without granting their parent directory. Saved scopes are restored at startup and held for the process lifetime. Stale bookmarks are regenerated from the resolved URL and their stored paths are updated. Denied directory access is not recorded. macOS privacy controls still apply; Flowix cannot observe the system Allow button directly. Old bookmark locations are no longer read or migrated.
