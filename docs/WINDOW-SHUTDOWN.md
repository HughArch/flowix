# Window close and application exit

A user close/quit request has a **one second total deadline**, measured from
native receipt (the mouse-up message timestamp for Windows custom controls).
This is not a one-second delay: successful saves trigger destruction immediately.
After one second, outstanding work is abandoned and the process is terminated.
Already issued disk writes cannot necessarily be rolled back.

## Responsibilities

- Windows retains `decorations: false` and its existing React-drawn controls.
  React publishes only the close button's physical rectangle and a revision.
  A dedicated native message pump uses Windows Raw Input in background mode to
  observe mouse input without JS. It does not suppress or capture clicks, checks
  the owning process, and keeps the region anchored during resize/DPI changes.
  Raw mouse input has one registration per process, so this module owns the
  application's sole mouse registration. Failed initialization and stopped
  pumps retry; a heartbeat reports whether the registered input pump is live.
  The UI reports loss and recovery. The custom control remains clickable through
  JS while the renderer responds.
- The native pump only enqueues close intent. Separate workers arm deadlines before
  framework/coordinator locks; a blocked UI dispatch cannot delay another click.
  Geometry remains registered until the host unmounts or native `Destroyed`.
- macOS keeps native traffic lights and native `CloseRequested` handling.
- `app/desktop-shutdown.ts` installs at window startup, not editor mount. It
  concurrently flushes document sessions, all mounted workspace surface barriers
  (tables/media/CSV/etc.), and preferences including already dispatched writes.
  Every close attempt captures fresh feature state, including after an updater
  cancellation. Each feature exposes a narrow public shutdown API. No JS close
  interceptor is installed. Frontend completion is a report, never permission to
  close; Rust owns the only timeout so app exit and updater deadlines cannot race
  a second frontend timer.
- `commands/window_shutdown.rs` coordinates saving, window destruction and
  updater preparation. Save acknowledgements and waiters use native window
  instance identity rather than its reusable label. Only native `Destroyed`
  confirms a window closed. Repeated clicks reuse the original request and do
  not create extra deadline workers; repeated app-quit events remain deferred
  behind the original save request.
- `commands/shutdown_watchdog.rs` enforces an absolute `Instant` deadline on an
  independent OS thread. A destroyed window's shared atomic liveness state
  makes its callback a no-op. It bypasses UI/Tokio, logger locks, destructors
  and atexit handlers when forcing process termination.
- App cleanup runs once off the UI thread. It shares the original close/quit
  deadline; it gets no extra saving or cleanup allowance.

## Forced termination scope

A hung native UI thread cannot reliably destroy only one window of a shared
process. Under the strict one-second policy, a window still not destroyed at its
deadline triggers **whole-application termination**, including other windows.
A normally closed auxiliary window marks its watchdog target destroyed and
leaves other windows open.
Explicit app quit / closing the last window additionally keeps the app watchdog
armed until the process exits. There is no confirmation that can extend the
strict deadline. Unsaved changes may be lost as specified by this policy.

A completely unresponsive native UI on macOS may not deliver a traffic-light
click at all; OS Force Quit remains the external fallback. The application can
only enforce its deadline once it receives a close intent. OS scheduling can
also delay execution; the deadline is an enforcement target, not a real-time OS
scheduling guarantee.

## Installer separation

Windows updater preparation still requires durable documents; a failed save or
an unacknowledged window destruction cancels installation rather than discarding
edits. Its native missing-response timeout is separate (8 seconds), and must
never arm a user-exit watchdog. User close/quit supersedes update preparation.
IPC names retaining `document` are kept for compatibility, while the coordinator
owns the complete window lifecycle.

## Verification and release checks

Automated tests cover immediate completion, failed/stalled saves, concurrent
surface/preferences flushing, preference writes already in flight, repeated
quit requests, instance-scoped acknowledgements, stale request generations,
native region hit boundaries/DPI and a real subprocess deadlocked on a mutex
that must be terminated after the product's one-second budget. The Windows
routing module is separately cross-type-checked.

Before release, test on Windows and macOS:

1. Close clean/dirty/conflicted documents and tables with inaccessible storage.
2. Hang the Windows renderer after close-region registration. Click custom X;
   verify native intent and termination without a renderer acknowledgement.
3. Hang cleanup/storage; verify termination at the original total deadline.
4. Close an auxiliary window normally; other windows must remain open. Stall
   that close beyond the deadline; strict-policy whole-app termination must occur.
5. Overlap close/quit/updater preparation; stale timers must not affect new requests.
6. Verify custom control hit regions across scale, zoom, theme, fullscreen,
   onboarding, preferences, overlapping hosts and input over other applications.
