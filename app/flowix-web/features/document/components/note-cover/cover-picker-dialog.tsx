import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { ImagePlus, Link2, Loader2, Upload } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { notebookAssets } from '@platform/tauri/client/desktop';
import { web } from '@platform/tauri/client/general';
import { Button } from '@shared/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { Input } from '@shared/ui/input';
import { BUILTIN_COVER_OPTIONS } from './builtin-covers';
import { base64ToBlob, bytesToBase64, cropToCoverBlob, isSvgPayload } from './cover-image';

const logger = createLogger('note-cover-picker');

type CoverTab = 'gallery' | 'upload' | 'link';

interface CoverPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Owner note path; attachments are saved under the note's notebook. */
  path: string;
  /** Frontend-resolved owning notebook; Rust resolves attachments dir from it. */
  getNotebookId: () => string | undefined;
  /** Persist the saved attachment key into `flowix_cover`. */
  onSelect: (storageKey: string) => Promise<boolean>;
}

export function CoverPickerDialog({ open, onOpenChange, path, getNotebookId, onSelect }: CoverPickerDialogProps) {
  const { t } = useI18n();
  const [tab, setTab] = useState<CoverTab>('gallery');
  const [saving, setSaving] = useState(false);
  const [link, setLink] = useState('');
  const [downloading, setDownloading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const persistCover = async (blob: Blob, extension: string) => {
    setSaving(true);
    try {
      const base64 = await bytesToBase64(await blob.arrayBuffer());
      // Scope by the frontend-resolved notebook: key resolution in the UI
      // uses longest-prefix matching, and nested notebook roots on this
      // device make a notePath-based owner resolve differently in Rust.
      const notebookId = getNotebookId();
      if (!notebookId) throw new Error('notebook is not resolved for the cover owner note');
      const saved = await notebookAssets.saveContent({
        content: base64,
        fileName: `note-cover-${Date.now()}.${extension}`,
        notebookId,
      });
      const selected = await onSelect(saved.key);
      if (selected) {
        onOpenChange(false);
      } else {
        toast.error(t('document.cover.saveFailed'));
      }
    } catch (error) {
      logger.warn('save cover failed', { error: error instanceof Error ? error.message : String(error), path });
      toast.error(t('document.cover.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  /** Built-ins ship with the app: persist a `builtin:` reference, no copy. */
  const selectBuiltinCover = async (builtinKey: string) => {
    try {
      const selected = await onSelect(builtinKey);
      if (selected) {
        onOpenChange(false);
      } else {
        toast.error(t('document.cover.saveFailed'));
      }
    } catch (error) {
      logger.warn('select builtin cover failed', { error: error instanceof Error ? error.message : String(error) });
      toast.error(t('document.cover.saveFailed'));
    }
  };

  const selectLocalFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const extension = isSvgPayload(file.type, file.name) ? 'svg' : 'jpg';
      const blob = extension === 'svg' ? file : await cropToCoverBlob(file);
      await persistCover(blob, extension);
    } catch (error) {
      logger.warn('crop local cover failed', { error });
      toast.error(t('document.cover.linkInvalid'));
    }
  };

  const submitLink = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = link.trim();
    if (!trimmed || downloading) return;
    setDownloading(true);
    try {
      const payload = await web.fetchImageFromUrl(trimmed);
      const blob = base64ToBlob(payload.contentBase64, payload.mimeType);
      const extension = isSvgPayload(payload.mimeType) ? 'svg' : 'jpg';
      const coverBlob = extension === 'svg' ? blob : await cropToCoverBlob(blob);
      setLink('');
      await persistCover(coverBlob, extension);
    } catch (error) {
      logger.info('download cover image failed', { error, url: trimmed });
      toast.error(String(error).includes('image') ? t('document.cover.linkInvalid') : t('document.cover.downloadFailed'));
    } finally {
      setDownloading(false);
    }
  };

  const tabs: Array<{ id: CoverTab; label: string; icon: typeof ImagePlus }> = [
    { id: 'gallery', label: t('document.cover.tabBuiltIn'), icon: ImagePlus },
    { id: 'upload', label: t('document.cover.tabUpload'), icon: Upload },
    { id: 'link', label: t('document.cover.tabLink'), icon: Link2 },
  ];

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!saving && !downloading) onOpenChange(next); }}>
      <DialogContent className="max-w-[720px] rounded-xl border border-[var(--border-popup)] bg-[var(--card)] shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        <DialogHeader>
          <DialogTitle>{t('document.cover.pickerTitle')}</DialogTitle>
        </DialogHeader>
        <div className="inline-flex self-start rounded-lg border border-[var(--border)] bg-[var(--muted)] p-0.5 text-sm">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-3 py-1 transition-colors',
                tab === id
                  ? 'bg-[var(--card)] text-[var(--foreground)] shadow-sm'
                  : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]',
              )}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
        {tab === 'gallery' && (
          <div className="grid max-h-[380px] grid-cols-3 gap-3 overflow-y-auto pr-1">
            {BUILTIN_COVER_OPTIONS.map((option) => (
              <button
                key={option.key}
                type="button"
                disabled={saving}
                onClick={() => void selectBuiltinCover(option.key)}
                className="relative aspect-[3/1] overflow-hidden rounded-lg border border-[var(--border)] transition-colors hover:border-[var(--brand)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:opacity-60"
              >
                <img src={option.url} alt="" loading="lazy" draggable={false} className="h-full w-full object-cover" />
                {saving && <span className="absolute inset-0 flex items-center justify-center bg-black/30"><Loader2 className="flowix-spin text-white" aria-hidden="true" /></span>}
              </button>
            ))}
          </div>
        )}
        {tab === 'upload' && (
          <label className="flex h-[160px] cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--border)] text-sm text-[var(--muted-foreground)] transition-colors hover:border-[var(--brand)] hover:text-[var(--foreground)]">
            {saving
              ? <Loader2 className="flowix-spin" aria-hidden="true" />
              : <Upload className="h-5 w-5" aria-hidden="true" />}
            {t('document.cover.uploadHint')}
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => void selectLocalFile(event)} />
          </label>
        )}
        {tab === 'link' && (
          <form onSubmit={(event) => void submitLink(event)} className="space-y-3">
            <Input
              value={link}
              onChange={(event) => setLink(event.target.value)}
              placeholder={t('document.cover.linkPlaceholder')}
              disabled={downloading}
              autoFocus
            />
            <div className="flex justify-end">
              <Button type="submit" disabled={downloading || !link.trim()}>
                {downloading && <Loader2 className="flowix-spin" aria-hidden="true" />}
                {downloading ? t('document.cover.downloading') : t('document.cover.linkApply')}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
