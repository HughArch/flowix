import { useMemo, useState } from 'react';
import { ImagePlus } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { decodeStorageKey, resolveAttachmentUrl } from '@features/editor/extensions/attachment-link/utils';
import { CoverPickerDialog } from './cover-picker-dialog';
import { useDocumentCover } from './use-document-cover';

const logger = createLogger('note-cover-banner');

interface NoteCoverBannerProps {
  path: string;
  displayId: string;
  editable: boolean;
  getNotebookId: () => string | undefined;
  getNotebookPath: () => string | null | undefined;
}

/**
 * Notion-style cover banner rendered inside the document scroller above the
 * title header. With no manual cover it degrades to a small "add cover"
 * action so the entry point stays discoverable without stealing space.
 */
export function NoteCoverBanner({ path, displayId, editable, getNotebookId, getNotebookPath }: NoteCoverBannerProps) {
  const { t } = useI18n();
  const { cover, setCover, removeCover } = useDocumentCover(path, displayId);
  const [pickerOpen, setPickerOpen] = useState(false);
  const coverUrl = useMemo(() => {
    if (!cover) return null;
    // Remote cover URLs render as-is; attachment keys resolve against the
    // notebook root. Keys persisted by this feature are plain
    // `attachments/...` paths, so `decodeStorageKey` alone is not enough.
    if (/^https?:\/\//i.test(cover)) return cover;
    const storageKey = decodeStorageKey(cover) ?? cover;
    return resolveAttachmentUrl(storageKey, getNotebookPath() ?? undefined);
  }, [cover, getNotebookPath]);

  const handleRemove = async () => {
    try {
      if (!await removeCover()) toast.error(t('document.cover.saveFailed'));
    } catch (error) {
      logger.warn('remove cover failed', { error, path });
      toast.error(t('document.cover.saveFailed'));
    }
  };

  const picker = (
    <CoverPickerDialog
      open={pickerOpen}
      onOpenChange={setPickerOpen}
      path={path}
      getNotebookId={getNotebookId}
      onSelect={setCover}
    />
  );

  if (!coverUrl) {
    if (!editable) return null;
    return (
      <>
        {/* Notion-style hover affordance: zero-footprint until the editor is hovered. */}
        <div className="pointer-events-none relative z-10 mx-auto -mb-7 flex h-7 w-full max-w-[var(--editor-document-max-width,680px)] justify-end px-10 opacity-0 transition-opacity focus-within:pointer-events-auto focus-within:opacity-100 group-hover/editor:pointer-events-auto group-hover/editor:opacity-100">
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="inline-flex items-center gap-1 rounded-md bg-[var(--card)] px-2 py-1 text-xs text-[var(--muted-foreground)] shadow-sm ring-1 ring-[var(--border)] transition-colors hover:text-[var(--foreground)]"
          >
            <ImagePlus className="h-3.5 w-3.5" aria-hidden="true" />
            {t('document.cover.add')}
          </button>
        </div>
        {picker}
      </>
    );
  }

  return (
    <>
      <div data-note-cover className="group/cover relative w-full overflow-hidden bg-[var(--muted)]">
        <img
          src={coverUrl}
          alt=""
          draggable={false}
          className="aspect-[3/1] w-full object-cover"
        />
        {editable && (
          <div className="absolute bottom-3 right-3 flex gap-1.5 opacity-0 transition-opacity group-hover/cover:opacity-100">
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="rounded-md bg-black/45 px-2.5 py-1 text-xs text-white backdrop-blur-sm transition-colors hover:bg-black/65"
            >
              {t('document.cover.change')}
            </button>
            <button
              type="button"
              onClick={() => void handleRemove()}
              className="rounded-md bg-black/45 px-2.5 py-1 text-xs text-white backdrop-blur-sm transition-colors hover:bg-black/65"
            >
              {t('document.cover.remove')}
            </button>
          </div>
        )}
      </div>
      {picker}
    </>
  );
}
