import { describe, expect, it } from 'vitest';
import { readDocumentLock } from './document-lock';

describe('readDocumentLock', () => {
  it('reads an explicit frontmatter lock', () => {
    expect(readDocumentLock('---\nflownote_locked: true\n---\nbody')).toBe(true);
  });

  it('treats a missing or non-boolean value as unlocked', () => {
    expect(readDocumentLock('body')).toBe(false);
    expect(readDocumentLock('---\ntitle: note\n---\nbody')).toBe(false);
    expect(readDocumentLock('---\nflownote_locked: false\n---\nbody')).toBe(false);
    expect(readDocumentLock('---\nflownote_locked: "true"\n---\nbody')).toBe(false);
  });

  it('keeps the last value stable for repeated reads of unchanged bytes', () => {
    expect(readDocumentLock('---\nflownote_locked: true\n---\nbody')).toBe(true);
    expect(readDocumentLock('---\nflownote_locked: true\n---\nbody')).toBe(true);
    expect(readDocumentLock('---\nflownote_locked: true\n---\nbody changed')).toBe(true);
    expect(readDocumentLock('body changed')).toBe(false);
  });

  it('leaves malformed frontmatter unlocked', () => {
    expect(readDocumentLock('---\nflownote_locked: [\n---\nbody')).toBe(false);
  });
});
