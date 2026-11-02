import { describe, expect, it } from 'vitest';
import { rewriteMovedNoteLinks } from './note-link-rewriter';

const before = {
  book: 'My Vault',
  file: 'Projects/Old.md',
  notebookId: 'vault-id',
  path: 'C:/Notes/Projects/Old.md',
};
const after = { book: 'My Vault', file: 'Projects/New.md' };

describe('rewrite moved note links', () => {
  it('updates links and display names for the renamed file', () => {
    const content = '[Old title](flownote://open?b=My+Vault&f=Projects%2FOld.md) '
      + '[Other](flownote://open?b=My+Vault&f=Projects%2FOther.md)';
    expect(rewriteMovedNoteLinks(content, before, after)).toBe(
      '[New](flownote://open?b=My+Vault&f=Projects%2FNew.md) '
      + '[Other](flownote://open?b=My+Vault&f=Projects%2FOther.md)',
    );
  });

  it('migrates older path links while keeping heading parameters', () => {
    const content = '[Section](flownote://open?notebookId=vault-id&relativePath=Projects%2FOld.md&heading=Tasks)';
    expect(rewriteMovedNoteLinks(content, before, after)).toBe(
      '[New](flownote://open?heading=Tasks&b=My+Vault&f=Projects%2FNew.md)',
    );
  });

  it('updates existing book/file links to the new b/f format', () => {
    const content = '[Old](flownote://open?book=My+Vault&file=Projects%2FOld.md)';
    expect(rewriteMovedNoteLinks(content, before, after)).toBe(
      '[New](flownote://open?b=My+Vault&f=Projects%2FNew.md)',
    );
  });

  it('keeps heading anchor fragments when rewriting moved note links', () => {
    const content = '[Plan](flownote://open?b=My+Vault&f=Projects%2FOld.md#%E7%9B%AE%E6%A0%87)';
    expect(rewriteMovedNoteLinks(content, before, after)).toBe(
      '[New](flownote://open?b=My+Vault&f=Projects%2FNew.md#%E7%9B%AE%E6%A0%87)',
    );
  });

  it('does not replace plain text or links to another notebook', () => {
    const content = 'flownote://open?b=My+Vault&f=Projects%2FOld.md '
      + '[Old](flownote://open?b=Other&f=Projects%2FOld.md)';
    expect(rewriteMovedNoteLinks(content, before, after)).toBe(content);
  });

  it('leaves code examples unchanged', () => {
    const link = '[Old](flownote://open?b=My+Vault&f=Projects%2FOld.md)';
    const content = `\`${link}\`\n\`\`\`md\n${link}\n\`\`\`\n${link}`;
    expect(rewriteMovedNoteLinks(content, before, after)).toBe(
      `\`${link}\`\n\`\`\`md\n${link}\n\`\`\`\n[New](flownote://open?b=My+Vault&f=Projects%2FNew.md)`,
    );
  });

  it('updates each descendant when a folder moves without changing the note filename', () => {
    const content = '[Old](flownote://open?b=My+Vault&f=Projects%2FChild%2FNote.md)';
    expect(rewriteMovedNoteLinks(content, {
      ...before, file: 'Projects', path: 'C:/Notes/Projects',
    }, { book: 'My Vault', file: 'Archive/Projects' }, true)).toBe(
      '[Note](flownote://open?b=My+Vault&f=Archive%2FProjects%2FChild%2FNote.md)',
    );
  });
});
