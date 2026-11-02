import { useSyncExternalStore } from 'react';
import type { NotebookSetupJob, NotebookSetupSnapshot } from '@platform/tauri/client';

const jobsByNotebook = new Map<string, NotebookSetupJob>();
const listeners = new Set<() => void>();
let snapshot: readonly NotebookSetupJob[] = [];
let latestSnapshotRevision = -1;

function publish() {
  snapshot = [...jobsByNotebook.values()];
  for (const listener of [...listeners]) listener();
}

export function subscribeNotebookSetupJobs(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getNotebookSetupJobs(): readonly NotebookSetupJob[] {
  return snapshot;
}

export function getNotebookSetupJob(notebookId: string | null | undefined): NotebookSetupJob | null {
  return notebookId ? jobsByNotebook.get(notebookId) ?? null : null;
}

export function upsertNotebookSetupJob(job: NotebookSetupJob) {
  // The snapshot is authoritative for every revision it covers. An event that
  // arrives later with an older revision must not resurrect a removed job.
  if (job.revision <= latestSnapshotRevision) return;
  const previous = jobsByNotebook.get(job.notebookId);
  if (previous && job.revision < previous.revision) return;
  if (previous && job.revision === previous.revision
    && job.jobId === previous.jobId && job.runId === previous.runId) return;
  jobsByNotebook.set(job.notebookId, job);
  publish();
}

/** Replace persisted state while preserving events committed after the snapshot began. */
export function replaceNotebookSetupSnapshot(value: NotebookSetupSnapshot) {
  if (value.revision < latestSnapshotRevision) return;
  const next = new Map(value.jobs.map((job) => [job.notebookId, job]));
  for (const [notebookId, eventJob] of jobsByNotebook) {
    if (eventJob.revision > value.revision) next.set(notebookId, eventJob);
  }
  jobsByNotebook.clear();
  for (const [notebookId, job] of next) jobsByNotebook.set(notebookId, job);
  latestSnapshotRevision = value.revision;
  publish();
}

export function useNotebookSetupJob(notebookId: string | null | undefined): NotebookSetupJob | null {
  return useSyncExternalStore(
    subscribeNotebookSetupJobs,
    () => getNotebookSetupJob(notebookId),
    () => null,
  );
}
