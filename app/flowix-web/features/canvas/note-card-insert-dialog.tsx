'use client';

/**
 * Insert-note-card dialog: pick a note, then choose the card's read-only
 * scope. `full` renders the whole note body, `section` renders the subtree
 * under one top-level heading (Obsidian `![[note#heading]]` semantics).
 *
 * Headings are read from the note itself and parsed with the same markdown
 * parser the card renderer uses, so what the picker offers is exactly what
 * `sliceNoteByHeading` can find.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { FileText, Loader2 } from 'lucide-react';
import { notes as notesClient } from '@platform/tauri/client';
import { joinNotebookMemoPath } from '@/lib/path';
import { useI18n } from '@/lib/i18n';
import { queryMentionNotes, type MentionNoteItem } from '@features/editor/extensions/note-mention/note-mention-data';
import { listNoteHeadings, parseNoteMarkdown } from '@features/editor/read-only/render-note-content';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { Button } from '@shared/ui/button';

export interface NoteCardSelection {
  notebookId: string;
  /** Snapshot so the card still resolves after syncing to another device. */
  notebookName?: string;
  /** Notebook-relative path used by `BoardCard.path`. */
  path: string;
  title: string;
  renderScope: 'full' | 'section';
  heading?: string;
}

interface HeadingOption {
  level: number;
  text: string;
}

export function NoteCardInsertDialog({
  open,
  onClose,
  onInsert,
}: {
  open: boolean;
  onClose: () => void;
  onInsert: (selection: NoteCardSelection) => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [notes, setNotes] = useState<MentionNoteItem[] | null>(null);
  const [selected, setSelected] = useState<MentionNoteItem | null>(null);
  const [scope, setScope] = useState<'full' | 'section'>('full');
  const [headings, setHeadings] = useState<HeadingOption[] | null>(null);
  const [heading, setHeading] = useState<string | null>(null);
  const [loadingHeadings, setLoadingHeadings] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const requestRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setNotes(null);
    setSelected(null);
    setScope('full');
    setHeadings(null);
    setHeading(null);
    setSubmitting(false);
  }, [open]);

  useEffect(() => {
    if (!open || notes !== null) return;
    let cancelled = false;
    void queryMentionNotes('')
      .then((items) => { if (!cancelled) setNotes(items); })
      .catch(() => { if (!cancelled) setNotes([]); });
    return () => { cancelled = true; };
  }, [open, notes]);

  const filtered = useMemo(() => {
    if (!notes) return [];
    const needle = query.trim().toLowerCase();
    // This dialog inserts note cards; canvas files are not note content and
    // their JSON would not survive the markdown heading extraction below.
    const listable = notes.filter((note) => !note.relativePath.toLowerCase().endsWith('.flowix-canvas'));
    if (!needle) return listable;
    return listable.filter((note) => (
      note.title.toLowerCase().includes(needle)
      || note.relativePath.toLowerCase().includes(needle)
    ));
  }, [notes, query]);

  const loadHeadings = async (note: MentionNoteItem) => {
    const request = ++requestRef.current;
    setLoadingHeadings(true);
    setHeadings(null);
    setHeading(null);
    try {
      const absolute = joinNotebookMemoPath(note.notebookPath, note.relativePath);
      const content = absolute ? await notesClient.readDocument(absolute) : null;
      if (request !== requestRef.current) return;
      const parsed = content ? parseNoteMarkdown(content) : null;
      const next = parsed ? listNoteHeadings(parsed) : [];
      setHeadings(next);
      setHeading(next[0]?.text ?? null);
    } catch {
      if (request !== requestRef.current) return;
      setHeadings([]);
      setHeading(null);
    } finally {
      if (request === requestRef.current) setLoadingHeadings(false);
    }
  };

  const chooseScope = (next: 'full' | 'section') => {
    setScope(next);
    if (next === 'section' && selected && headings === null && !loadingHeadings) {
      void loadHeadings(selected);
    }
  };

  const chooseNote = (note: MentionNoteItem) => {
    setSelected(note);
    setScope('full');
    setHeadings(null);
    setHeading(null);
  };

  const canInsert = Boolean(selected) && (scope === 'full' || Boolean(heading)) && !submitting;

  const submit = async () => {
    if (!selected || !canInsert) return;
    setSubmitting(true);
    try {
      await onInsert({
        notebookId: selected.notebookId,
        notebookName: selected.notebookName,
        path: selected.relativePath,
        title: selected.title,
        renderScope: scope,
        ...(scope === 'section' && heading ? { heading } : {}),
      });
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !submitting) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">{t('canvas.board.insert.title')}</DialogTitle>
          <DialogDescription>{t('canvas.board.insert.description')}</DialogDescription>
        </DialogHeader>
        <div className="mt-3 space-y-3">
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('canvas.board.insert.searchPlaceholder')}
            className="h-9 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm outline-none focus:border-[var(--brand)]"
          />
          <div className="max-h-56 overflow-y-auto rounded-lg border border-[var(--border)]">
            {notes === null ? (
              <div className="flex items-center justify-center gap-2 px-3 py-6 text-xs text-[var(--muted-foreground)]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                {t('canvas.board.insert.loading')}
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-[var(--muted-foreground)]">
                {t('canvas.board.insert.empty')}
              </div>
            ) : (
              filtered.map((note) => {
                const active = selected?.notebookId === note.notebookId && selected?.relativePath === note.relativePath;
                return (
                  <button
                    key={`${note.notebookId}:${note.relativePath}`}
                    type="button"
                    onClick={() => chooseNote(note)}
                    className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm transition-colors ${active ? 'bg-[var(--muted)]' : 'hover:bg-[var(--muted)]/60'}`}
                  >
                    <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" aria-hidden="true" />
                    <span className="min-w-0">
                      <span className="block truncate text-[var(--foreground)]">{note.title}</span>
                      <span className="block truncate text-[11px] text-[var(--muted-foreground)]">
                        {note.notebookName}/{note.relativePath}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>

          {selected ? (
            <div className="space-y-2 rounded-lg border border-[var(--border)] px-3 py-2.5">
              <div className="text-xs font-medium text-[var(--muted-foreground)]">{t('canvas.board.insert.scope')}</div>
              <div className="flex gap-2">
                <ScopeButton active={scope === 'full'} onClick={() => chooseScope('full')}>
                  {t('canvas.board.insert.scopeFull')}
                </ScopeButton>
                <ScopeButton
                  active={scope === 'section'}
                  disabled={loadingHeadings || headings?.length === 0}
                  onClick={() => chooseScope('section')}
                >
                  {t('canvas.board.insert.scopeSection')}
                </ScopeButton>
              </div>
              {scope === 'section' ? (
                loadingHeadings ? (
                  <div className="flex items-center gap-2 py-1 text-xs text-[var(--muted-foreground)]">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    {t('canvas.board.insert.loading')}
                  </div>
                ) : headings && headings.length > 0 ? (
                  <div className="max-h-40 overflow-y-auto rounded-md border border-[var(--border)]">
                    {headings.map((option, index) => (
                      <button
                        key={`${option.level}:${option.text}:${index}`}
                        type="button"
                        onClick={() => setHeading(option.text)}
                        className={`flex w-full items-center gap-2 py-1.5 pr-2 text-left text-xs ${heading === option.text ? 'bg-[var(--muted)]' : 'hover:bg-[var(--muted)]/60'}`}
                        style={{ paddingLeft: 10 + (option.level - 1) * 14 }}
                      >
                        <span className="truncate">{option.text}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="py-1 text-xs text-[var(--muted-foreground)]">
                    {t('canvas.board.insert.noHeadings')}
                  </div>
                )
              ) : null}
            </div>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" className="rounded-lg" disabled={submitting} onClick={onClose}>
              {t('dialog.cancel')}
            </Button>
            <Button type="button" size="sm" className="rounded-lg" disabled={!canInsert} onClick={() => { void submit(); }}>
              {t('canvas.board.insert.confirm')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ScopeButton({
  active,
  disabled = false,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-md border px-2.5 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
        active
          ? 'border-[var(--brand)] bg-[var(--brand)]/10 text-[var(--foreground)]'
          : 'border-[var(--border)] text-[var(--muted-foreground)] hover:bg-[var(--muted)]'
      }`}
    >
      {children}
    </button>
  );
}
