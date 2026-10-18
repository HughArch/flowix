# Desktop startup lifecycle

Stage 1 is controlled solely by the durable completion record for the current
application version. Missing indexes, offline notebooks, old watcher preferences
and background failures never reopen this stage.

Stage 2 prepares current local stores, selects the notebook from registry metadata,
and renders the workbench shell. It does not enumerate notebook files, query counts
across notebooks, probe every external directory, load Cloud credentials, or await
restored document/panel contents. A metadata failure exposes a retry screen rather
than pretending that the notebook list is empty. `notifyStartupInteractive` means
the shell or retry screen has painted, not that all its content has loaded.

Stage 3 has independent execution paths:

- Visible document, collection, media and Agent content loads through its normal
  view lifecycle. User navigation supersedes delayed restoration.
- The frontend admits non-essential startup checks only after the workbench has
  painted; Tauri sends the native interactive signal first. Admission is
  idempotent per WebView; named startup tasks run once and report failures
  without changing stage-2 readiness. This is a gate and deduplication point,
  not a shared task queue.
- Agent event subscriptions remain early so live session events are not missed.
  Agent run/history reconciliation waits for admission and the selected
  workspace target to settle (up to two seconds); stage-3 admission already
  follows the shell paint, so reconciliation needs no second paint wait. It
  refreshes currently interested conversations first, then catches up hidden
  sessions two at a time. Visible conversation hydration remains owned by its
  view. The one-time Agent runtime refresh waits for native startup CLI
  discovery to finish before reading paths. The backend runtime-status command
  owns this dependency for every caller. Its wait is race-safe and bounded to
  30 seconds; a timeout logs and returns the best available status so the Agent
  surface remains usable.
  Agent workspace and Pi mode snapshots load after main-window stage-3 admission;
  the separate preferences window loads them when that window is opened. Model
  and notebook skill catalogs load on demand instead of being prefetched for
  every launch. Note-link cache warming and interrupted repair resume run after
  admission.
- Automatic app-update checks retain their 3.6-second delay, but the timer starts
  only after admission and the named task is deduplicated. Explicit update
  checks remain immediate. DSH download progress subscription and its active
  download snapshot remain early; the main window skips a second DSH runtime
  status query because Agent runtime status already reads it. DSH preferences
  still load their own status when opened. The advisory DSH version check stays
  with the Agent card that displays it, waits for admission and shares one result
  across cards. Clicking the runtime update action still starts immediately.
- Onboarding state and the previous app-update result are read early. Onboarding
  is shown after admission. A previous update-result toast waits until onboarding,
  the product intro and other prompts are closed, so startup messages do not
  compete for the same attention.
- The stage-3 gate makes one attempt per named task and does not provide a shared
  retry policy. Note-link repair owns up to three delayed retries; Agent runtime
  refresh makes one startup request and can refresh again when an Agent surface
  requests stale status; Agent session
  reconciliation runs again after listener recovery or window focus; automatic
  app-update failure remains silent and the explicit check is the retry path.
  Agent workspace snapshots reload after listener recovery or workspace changes;
  Pi mode initialization retries when a Pi operation requests it. Other advisory
  checks stay feature-owned and can run again when requested.
- `NotebookBackground` admits passive note/media maintenance after shell paint.
  One worker coalesces requests, prioritizes the current notebook, yields between
  batches and cooperatively cancels work for shutdown/update or higher-priority
  work. Directory watcher events and watcher rebinds use the same note queue;
  media maintenance has its own status revisions and explicit retry command, so
  a media failure cannot change the note-index readiness state.
- The filesystem watcher binds all currently available notebook roots in one
  pass. A separate 15-second retry loop attaches roots that were offline or
  unavailable at startup, then requests one reconciliation for changes made
  while the root was detached. Watcher retries stop after accepted application
  exit. Split rename tracking is seeded when each root attaches.

Cloud initialization/credential recovery, CLI discovery and housekeeping also
start after shell paint. Cloud schema initialization retries with bounded
exponential backoff up to 60 seconds; Cloud store APIs initialize their schema
on first use if an explicit request arrives before the background service.
Credential reads hold no auth lock; a later login/logout supersedes startup
restoration. A 120-second wait without an interactive signal is recorded as
`interactive-timeout-degraded-release`: it releases independent services for
liveness and does not assert that the shell painted.

## Data and concurrency contracts

Note-list, count and tag queries do not reconcile files. Notebook list responses contain only registry metadata
and available background statistics. An omitted count is unknown; a completed
empty projection reports zero. Index-dependent queries return `NOTE_INDEX_PENDING`
or a scope-local unavailable state. Completion invalidates that notebook once.

A scan uses a separate `MemoFile` facade instead of holding AppState's global lock.
Note scanning retains per-file SQLite transactions and notebook OS locks across
GUI, CLI and Cloud operations. Media maintenance retains its SQLite consistency
checks, rechecks stale paths before cleanup, and guards against intervening catalog
renames/restoration. Filesystem traversal is never an atomic snapshot. Explicit accurate snapshots/imports/mutations
retain their blocking consistency requirements; they are not silently replaced by
cached results. Scanner cancellation is checked between files; an operating-system
filesystem call already blocked on an external device cannot be forcibly aborted.

Cancelled cold builds remain incomplete. Warm refreshes keep the preceding
projection readable. Incomplete/unavailable directory walks are not evidence of
resource deletion. Projection schema preparation preserves the shared notebook
DB and media properties. Higher-version session databases are rejected without
being classified as corruption or replaced by an empty store.

## Status delivery and lifecycle

`flowix:notebook-maintenance` publishes notebook ID, state, revision, optional
count/path availability and failure text. `get_notebook_background_status` is the
snapshot counterpart. The frontend reconciles on listener readiness/recovery and
rejects older revisions and regressing same-revision events. List/panel loading
and retry remain independent of global startup state.

Media cleanup uses `flowix:media-maintenance` and
`get_notebook_media_maintenance_status`; the media library exposes a retry action
for failed maintenance. Its revisions and state do not affect note-index status.

Queue failures do not stop other notebooks. Repeated passive failures have a short
admission backoff; explicit retry is immediate. Accepted application exit stops
admission and cooperatively cancels the current scan. Windows updater preparation
pauses maintenance; a failed update resumes it through the update guard.

## Implementation review

Review covered the version gate, stage-2 dependencies, stage-3 admission and
shutdown, separate facades, stale event/snapshot delivery, offline notebooks,
cold projections, shared media data, and delayed workspace navigation.

Issues found and fixed during review:

- A late pending-query response could overwrite a failed maintenance task and
  leave a list waiting indefinitely. Passive pending responses preserve terminal
  states; explicit retry can enqueue a new attempt.
- A maintenance-lock conflict could be reported as a successful background scan
  using an older warm count. Background scans now report busy explicitly; the
  older passive API retains its documented skip behavior.
- An older DB without projection tables could turn an unknown count into an SQL
  error. Cached counts now inspect table presence without creating a projection.
- Admission could race with accepted shutdown between its initial stop check
  and queue insertion. Both operations now serialize on the queue lock.
- Pausing the worker could race with its condition-variable wait and lose the
  resume notification. Pause/resume now update their predicate under the same
  queue lock used by the waiter.
- When the current notebook root was offline, the previous startup bind omitted
  every other root too. Startup now binds all available roots, and a stoppable
  retry loop attaches offline roots independently and reconciles their changes.
- Dynamically attached roots now seed the split-rename identity tracker, keeping
  rename pairing reliable after a volume becomes available.
- Restored workspace content could finish a slower table, collection, folder,
  media or Agent lookup after a newer user navigation. The startup navigation
  revision is now passed through each restore path and checked before navigation
  or filesystem side effects.
- Interrupted note-link repair no longer starts on component mount. Startup
  admits it after the shell paint signal; explicit file moves and document saves
  still resume it immediately.
- Cloud schema failures previously left credential recovery and polling
  disabled until restart. Initialization now retries with bounded backoff while
  the existing auth generation guard protects explicit login/logout.
- Media maintenance failures previously had only a log entry. They now publish
  a separate versioned status and can be retried from the media library.
- Startup metrics now say `background-services-admitted`; they no longer imply
  that background work itself has completed.
- A media file could reappear after traversal, or its row could be renamed or
  restored before stale cleanup. Cleanup rechecks the path and uses conditional
  updates/deletes against the captured path and missing/deleted state.
- Deferred credential results could share a revision with the initial Restoring
  snapshot. Changed results now advance the revision, so stale snapshots lose.
- A collection path-conflict retry kept the pre-navigation restore revision and
  could reject its own retry. The retry now carries the current navigation
  revision while remaining supersedable by later user navigation.
- A stale in-flight completion flag could disagree with a successful record for
  the same app version. The successful-version record now acts as a skip fallback;
  the explicit development rerun control clears that fallback for the current
  version.
- Agent runtime refresh could race native CLI discovery and cache an unknown path.
  The runtime-status command now waits on a completion condition backed by
  latched in-process state plus a notification, so every caller observes the
  dependency and late subscribers cannot miss completion.
- Agent model and notebook-skill catalog requests were being launched globally
  from the root effect. They now load only when their feature needs them; the
  initial runtime refresh remains ordered after CLI discovery.
- Main-window update and DSH checks previously started outside a shared
  first-paint admission point. Automatic update checking now runs as a named,
  deduplicated stage-3 task; the main window relies on the runtime snapshot for
  DSH status and retains only progress recovery at startup.
- Onboarding and the prior-install result toast could become visible during the
  same startup transition. Onboarding is now decided at the stage-2 notebook
  context boundary, and opens when no notebook is available; it does not wait
  for a boot-feature read or stage-3 admission. The toast still waits until
  startup prompts are closed.
- Agent history catch-up could race workspace restoration and fan out all
  conversations together. It now yields briefly to the restored view, starts
  interested histories first, and limits background catch-up to two requests at
  a time; listener recovery received during this window is replayed afterward.
- A follow-up runtime refresh after 1.5 seconds repeated the same startup check.
  Stage 3 now makes one request; Agent surfaces can refresh stale status when
  needed.
- Agent workspace and Pi mode reads were starting before the main shell painted.
  The main window now loads them through one named stage-3 task, while the
  separate preferences window loads them when opened. Workspace change
  subscriptions remain early and buffer reloads until the initial snapshot ends.
- DSH settings read runtime status in both the parent and its installer child.
  The parent owns the snapshot; child installer hooks now only subscribe to
  progress and perform install actions.
- Stage-3 tasks intentionally remain one-shot and own their retry policy. The
  lifecycle notes now document the existing retry paths and explicit checks.

Validation before the follow-up lifecycle hardening on the current macOS host:
55 frontend tests, 36 desktop startup tests,
15 core note-index tests, 18 media tests, 59 sync tests, and one test each for
notebook-list serialization, higher-version session preservation, and runtime
configuration across process restarts passed. The runtime registry regression also
passed (187 tests in total). Desktop library compilation
and `git diff --check` passed. A stale desktop test reference to a removed runtime
method was corrected to the existing `id()` API and canonical runtime IDs, so
these tests compile and execute normally.

The follow-up hardening changes above were reviewed statically but were not
revalidated after editing. The full TypeScript check remains blocked by 246 existing errors, principally the
AgentId migration; no errors were reported in the startup/maintenance files or
navigation files changed for this work. Two previously reproduced baseline core
index failures were excluded from the focused index run:
`mixed_v2_and_note_tables_keep_current_note_rows` and
`note_projection_coexists_with_legacy_rows_in_the_same_notebook_db`.

No packaged-app timing measurements or Windows/Linux runtime validation were
performed. No claim is made that an in-flight OS filesystem call can be cancelled.
The frontend stage-3 admission, deferred Agent recovery, DSH startup query split,
and native CLI-detection completion wait added in this implementation were
reviewed statically; no tests or builds were run for these changes.
The additional Agent-history priority, Agent-context admission, and DSH status
deduplication edits in this review were also checked statically; no tests or
builds were run for them.

## Watcher binding lock contract

Binding paths serialize a fresh registry read with watcher changes, using
`watcher::runtime::read_registered_notebooks` and a short-lived independent
MemoFile facade. They must not acquire AppState's global MemoFile lock while
holding the watcher lock: document writes hold a global MemoFile read guard
while registering watcher self-write marks, and a pending global writer can
turn a nested watcher-to-MemoFile read into a lock cycle. Current-notebook
identity for startup queue priority is read before taking the watcher lock.
A registry read failure preserves bindings; retrying an uninitialized watcher
must queue reconciliation for every successfully attached root after binding,
not merely initialize the OS watcher and skip the next retry.

Validation of the watcher lock/recovery follow-up: all 36 `app::` tests and
33 of 36 `watcher::` tests passed, including four new registry/recovery tests.
The registry test reads while the global MemoFile write lock is held; it
verifies removal of that dependency rather than relying on platform-specific
RwLock writer-priority behavior to reproduce a deadlock. Recovery queue tests
use real notify root attachments and exclude offline/suspended roots.
The three remaining watcher failures are unchanged whitelist assertions that
expect hidden files/default file exclusions which the current defaults no
longer apply. No packaged-app or cross-platform deadlock timing was exercised.
