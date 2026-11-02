import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { UndoRedo } from '@tiptap/extensions/undo-redo';
import { Markdown } from '@tiptap/markdown';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ComposerAttachmentToken,
  composerAttachmentMarkdownToPrompt,
  composerAttachmentFileUrl,
} from './composer-attachment-token';
import { COMPOSER_ATTACHMENT_NODE_NAME } from './composer-attachment-compat';

const cleanups: Array<() => void> = [];
beforeEach(() => {
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: { configurable: true, value: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }) },
  });
});
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.body.replaceChildren();
});
function setup(content = '') {
  const input = document.createElement('div');
  document.body.append(input);
  const editor = new Editor({ element: { mount: input }, extensions: [Document, Paragraph, Text, UndoRedo, Markdown, ComposerAttachmentToken], content, contentType: 'markdown' });
  cleanups.push(() => editor.destroy());
  return { editor, input };
}
/** Tokens no longer enter the editor through the attachment controller (chips
 * strip instead); drafts created by older builds still carry them, so insert
 * through the raw editor command to exercise the legacy path. */
function insertLegacyToken(editor: Editor, attachment: { path: string; name: string; mimeType: string }) {
  editor.commands.insertContentAt(1, {
    type: COMPOSER_ATTACHMENT_NODE_NAME,
    attrs: { ...attachment },
  });
}

describe('Legacy composer attachment tokens', () => {
  it('round-trips legacy attachment tokens through the saved Markdown draft', () => {
    const { editor } = setup();
    insertLegacyToken(editor, { path: '/tmp/report.pdf', name: 'report.pdf', mimeType: 'application/pdf' });
    const markdown = editor.getMarkdown();
    expect(markdown).toContain('⟦attachment:');
    editor.commands.setContent(markdown, { contentType: 'markdown' });
    expect(editor.state.doc.firstChild?.firstChild?.type.name).toBe(COMPOSER_ATTACHMENT_NODE_NAME);
  });

  it('renders legacy tokens with the attachment-token class and stored name', () => {
    const { editor } = setup();
    insertLegacyToken(editor, { path: '/tmp/report.pdf', name: 'report.pdf', mimeType: 'application/pdf' });
    expect(editor.view.dom.querySelector('.agent-composer__attachment-token')?.textContent).toBe('report.pdf');
  });

  it('maps image tokens to nothing and document tokens to file links in prompts', () => {
    const markdown = [
      'look at ⟦attachment:%2Ftmp%2Fphoto.png:photo.png:image%2Fpng⟧ end',
      'check ⟦attachment:%2Ftmp%2Freport.pdf:report.pdf:application%2Fpdf⟧ end',
    ].join('\n');
    const prompt = composerAttachmentMarkdownToPrompt(markdown);
    expect(prompt).not.toContain('photo.png');
    expect(prompt).toContain('[report.pdf](file:///tmp/report.pdf)');
  });

  it('builds file urls for absolute cached paths', () => {
    expect(composerAttachmentFileUrl('/tmp/report.pdf')).toBe('file:///tmp/report.pdf');
    expect(composerAttachmentFileUrl('C:\\tmp\\a.pdf')).toBe('file:///C:/tmp/a.pdf');
  });
});
