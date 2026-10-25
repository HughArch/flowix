import { DOCUMENT_LOCK_KEY, extractFrontmatter } from './frontmatter-model';

export { DOCUMENT_LOCK_KEY };

// Buffer subscribers ask for the lock state on every keystroke; the previous
// parse is reused while the document bytes are unchanged.
let lastContent: string | null = null;
let lastLocked = false;

/**
 * Lock state is authored state in the note itself (`flowix_locked: true`), so
 * it survives restarts and travels with the file. Only an explicit boolean is
 * honoured: a missing, malformed or non-boolean value leaves the note editable.
 */
export function readDocumentLock(content: string): boolean {
  if (content === lastContent) return lastLocked;
  lastContent = content;
  // Unlocked notes are the common case and re-read on every keystroke; skip
  // the YAML pass when the key cannot be present at all.
  lastLocked = content.includes(DOCUMENT_LOCK_KEY)
    && extractFrontmatter(content).data[DOCUMENT_LOCK_KEY] === true;
  return lastLocked;
}
