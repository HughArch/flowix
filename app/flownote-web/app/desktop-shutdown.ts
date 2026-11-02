import { createLogger } from '@/lib/logger';
import { invoke } from '@platform/tauri/core';
import { subscribe } from '@platform/tauri/event-bus';
import { isTauriDesktopRuntime } from '@platform/tauri/runtime';
import { flushDocumentsForShutdown, documentShutdownDiagnostics } from '@features/document/public/shutdown-api';
import { flushWorkspaceSurfacesForShutdown } from '@features/workspace/public/shutdown-api';
import { flushPreferencesForShutdown } from '@features/preferences/public/shutdown-api';

const log = createLogger('window:shutdown');
let installed = false;

type ShutdownKind = 'close' | 'exit';
type ShutdownAttempt = {
  request: number;
  kind: ShutdownKind;
};

function safeDiagnostics(): object {
  try {
    return documentShutdownDiagnostics();
  } catch {
    return { unavailable: true };
  }
}

function logFailure(level: 'warn' | 'error', message: string, detail?: unknown): void {
  try {
    const context = detail === undefined
      ? undefined
      : detail !== null && typeof detail === 'object' && !Array.isArray(detail)
        ? detail as Readonly<Record<string, unknown>>
        : { error: detail };
    log[level](message, context);
  } catch {
    // Logging is diagnostic and must not become part of the close protocol.
  }
}

/** This is a best-effort report, never permission to close. Rust owns deadlines. */
async function prepare(): Promise<boolean> {
  const started = Date.now();
  try {
    const results = await Promise.allSettled([
      Promise.resolve().then(flushDocumentsForShutdown),
      Promise.resolve().then(flushPreferencesForShutdown),
      Promise.resolve().then(flushWorkspaceSurfacesForShutdown),
    ]);
    const ready = results.every(result => result.status === 'fulfilled' && result.value !== false);
    try {
      log.info('prepare settled', { ready, elapsedMs: Date.now() - started, ...safeDiagnostics() });
    } catch {
      // A diagnostics or logger failure cannot veto the close acknowledgement.
    }
    return ready;
  } catch (error) {
    logFailure('warn', 'shutdown preparation failed', error);
    return false;
  }
}

async function acknowledge(attempt: ShutdownAttempt, ready: boolean): Promise<void> {
  try {
    await invoke(attempt.kind === 'close' ? 'finish_document_close' : 'finish_document_shutdown', {
      request: attempt.request,
      ready,
    });
  } catch (error) {
    logFailure('warn', 'shutdown acknowledgement failed; native deadline remains active', {
      request: attempt.request,
      kind: attempt.kind,
      error,
    });
  }
}

/** Install once. Native CloseRequested must never depend on a JS listener. */
export function installDesktopShutdown(): void {
  if (installed || !isTauriDesktopRuntime()) return;
  installed = true;

  let active: ShutdownAttempt | null = null;
  const clear = () => { active = null; };

  const begin = (request: number, kind: ShutdownKind) => {
    if (active?.request === request && active.kind === kind) return;
    clear();
    const attempt: ShutdownAttempt = { request, kind };
    active = attempt;

    // Persistence is background work; native Rust owns the hard close deadline.
    const preparation = prepare();

    void preparation.then(async ready => {
      if (active !== attempt) return;
      await acknowledge(attempt, ready);
    }).catch(async error => {
      logFailure('error', 'shutdown preparation failed; reporting best-effort close', {
        request,
        kind,
        error,
      });
      if (active === attempt) await acknowledge(attempt, false);
    });
  };

  subscribe<number>('document:prepare-close', request => begin(request, 'close'));
  subscribe<number>('document:exit-cancelled', request => {
    // Only the updater can cancel. Ordinary user close/quit never emits this.
    if (active?.kind === 'exit' && active.request === request) clear();
  });
  subscribe<number>('document:prepare-exit', request => begin(request, 'exit'), {
    onListenerReady: () => {
      void invoke('register_document_window').catch(error => {
        logFailure('error', 'window registration failed', error);
      });
    },
  });
}
