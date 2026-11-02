import {
  confirmShellNotebookTemplateOverwrite,
  ensureShellNotebookTemplateSetup,
  startNotebookImportWithMonitoring,
  type Notebook,
} from '@features/memo/public/shell-api';
import { selectNotebook } from '@features/workspace/public/shell-api';
import { clearActionableNotice, upsertActionableNotice } from '@features/notifications/actionable-notice-store';

export async function finishOnboardingNotebook(
  notebook: Notebook,
  { startImport, templateId }: { startImport: boolean; templateId?: string | null },
  {
    completeOnboarding,
    failureTitle,
    retryLabel,
    overwriteConfirmMessage,
  }: {
    completeOnboarding: () => Promise<void>;
    failureTitle: string;
    retryLabel: string;
    overwriteConfirmMessage?: string;
  },
): Promise<void> {
  await selectNotebook(notebook);
  // Template setup performs its own import after the template files are written.
  // Avoid starting a competing import alongside that background job.
  let shouldStartImport = startImport && !templateId;
  if (templateId) {
    try {
      await ensureShellNotebookTemplateSetup(notebook.id, templateId);
    } catch (error) {
      if (!String(error).includes('NOTEBOOK_PRESET_OVERWRITE_CONFIRM_REQUIRED')) throw error;
      const confirmed = await confirmShellNotebookTemplateOverwrite(
        overwriteConfirmMessage ?? '所选文件夹中已有文件或笔记。继续将用场景内容覆盖同路径文件，是否继续？',
      );
      if (confirmed) {
        await ensureShellNotebookTemplateSetup(notebook.id, templateId, true);
      } else {
        shouldStartImport = true;
      }
    }
  }
  if (shouldStartImport) {
    const noticeId = `notebook-import:${notebook.id}`;
    let attempt = 0;
    let importing = false;
    const beginImport = async () => {
      if (importing) return;
      importing = true;
      const revision = ++attempt;
      try {
        await startNotebookImportWithMonitoring(notebook.id, (status) => {
          importing = false;
          if (status.status === 'failed') {
            upsertActionableNotice({
              id: noticeId,
              priority: 50,
              tone: 'error',
              title: `${notebook.name} · ${failureTitle}`,
              message: status.message ?? undefined,
              revision,
              dismissible: true,
              actions: [{ id: 'retry', label: retryLabel, run: beginImport }],
            });
          } else {
            clearActionableNotice(noticeId);
          }
        });
      } catch (error) {
        importing = false;
        throw error;
      }
    };
    await beginImport();
  }
  await completeOnboarding();
}
