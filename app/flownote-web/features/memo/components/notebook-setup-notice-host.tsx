'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useI18n } from '@/lib/i18n';
import { subscribeNotebookSetupJobs, getNotebookSetupJobs } from '@features/memo/store/notebook-setup-store';
import {
  clearActionableNotice,
  dismissActionableNotice,
  upsertActionableNotice,
} from '@features/notifications/actionable-notice-store';

const EMPTY_JOBS: ReturnType<typeof getNotebookSetupJobs> = [];

export function NotebookSetupNoticeHost() {
  const { t } = useI18n();
  const jobs = useSyncExternalStore(
    subscribeNotebookSetupJobs,
    getNotebookSetupJobs,
    () => EMPTY_JOBS,
  );
  const activeNoticeIdsRef = useRef(new Set<string>());

  useEffect(() => {
    const activeJobs = jobs.filter((job) => job.status === 'running');
    const nextIds = new Set(activeJobs.map((job) => `notebook-setup-running:${job.jobId}`));

    for (const noticeId of activeNoticeIdsRef.current) {
      if (!nextIds.has(noticeId)) clearActionableNotice(noticeId);
    }

    for (const job of activeJobs) {
      const noticeId = `notebook-setup-running:${job.jobId}`;
      const title = job.stage === 'preparing'
        ? t('notebook.setup.preparingTemplate')
        : job.stage === 'indexing'
          ? t('notebook.setup.indexing')
          : t('notebook.setup.applyingTemplate');

      upsertActionableNotice({
        id: noticeId,
        priority: 80,
        tone: 'neutral',
        width: 'narrow',
        title,
        leadingIcon: 'loading',
        revision: `${job.jobId}:${job.runId || `revision:${job.revision}`}`,
        dismissible: true,
        actions: [{
          id: 'hide',
          label: t('notebook.setup.hide'),
          variant: 'outline',
          run: () => dismissActionableNotice(noticeId),
        }],
      });
    }

    activeNoticeIdsRef.current = nextIds;
  }, [jobs, t]);

  useEffect(() => () => {
    for (const noticeId of activeNoticeIdsRef.current) clearActionableNotice(noticeId);
    activeNoticeIdsRef.current.clear();
  }, []);

  return null;
}
