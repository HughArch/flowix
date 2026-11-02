import { describe, expect, it } from 'vitest';

import { resolveNotebookImportStatusEffect } from '@features/memo/hooks/create-notebook-flow-state';
import type { NotebookImportStatus } from '@platform/tauri/client';

function status(overrides: Partial<NotebookImportStatus>): NotebookImportStatus {
  return {
    notebookId: 'nb_current',
    status: 'completed',
    message: null,
    ...overrides,
  };
}

describe('resolveNotebookImportStatusEffect', () => {
  it('ignores status events for a notebook that is no longer selected', () => {
    expect(
      resolveNotebookImportStatusEffect(
        'nb_other',
        status({ notebookId: 'nb_current', status: 'completed' }),
        'Failed to create',
      ),
    ).toBeNull();
  });

  it('marks matching started events as importing without reloading', () => {
    expect(
      resolveNotebookImportStatusEffect(
        'nb_current',
        status({ status: 'started' }),
        'Failed to create',
      ),
    ).toEqual({
      creationState: { status: 'importing', notebookId: 'nb_current' },
      reloadMemoList: false,
      errorMessage: null,
    });
  });

  it('marks completed events as ready and requests a memo-list reload', () => {
    expect(
      resolveNotebookImportStatusEffect(
        'nb_current',
        status({ status: 'completed' }),
        'Failed to create',
      ),
    ).toEqual({
      creationState: { status: 'ready', notebookId: 'nb_current' },
      reloadMemoList: true,
      errorMessage: null,
    });
  });

  it('surfaces backend failures', () => {
    expect(
      resolveNotebookImportStatusEffect(
        'nb_current',
        status({ status: 'failed', message: 'import failed' }),
        'Failed to create',
      ),
    ).toEqual({
      creationState: { status: 'failed', message: 'import failed' },
      reloadMemoList: false,
      errorMessage: 'import failed',
    });
  });

  it('uses the localized fallback message for failures without a backend message', () => {
    expect(
      resolveNotebookImportStatusEffect(
        'nb_current',
        status({ status: 'failed', message: null }),
        'Failed to create',
      ),
    ).toEqual({
      creationState: { status: 'failed', message: 'Failed to create' },
      reloadMemoList: false,
      errorMessage: 'Failed to create',
    });
  });

  it('treats skipped imports as ready', () => {
    expect(
      resolveNotebookImportStatusEffect(
        'nb_current',
        status({ status: 'skipped' }),
        'Failed to create',
      ),
    ).toEqual({
      creationState: { status: 'ready', notebookId: 'nb_current' },
      reloadMemoList: false,
      errorMessage: null,
    });
  });
});
