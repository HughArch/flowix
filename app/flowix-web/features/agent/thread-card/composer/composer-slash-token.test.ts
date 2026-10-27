import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ComposerSlashToken,
  composerSlashMarkdownToPrompt,
  extractComposerFlowixSkillNames,
  insertComposerFlowixSkillToken,
  stripComposerFlowixSkillTokens,
} from './composer-slash-token';

function createEditor(content = ''): Editor {
  return new Editor({
    extensions: [StarterKit, Markdown, ComposerSlashToken],
    content,
    contentType: 'markdown',
  });
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('composerSlashMarkdownToPrompt', () => {
  it('expands flowix skill chips to their display name', () => {
    expect(composerSlashMarkdownToPrompt(
      '帮我 [知识整理](flowix://slash/flowix/skill:personal-knowledge) 一下',
    )).toBe('帮我 知识整理 一下');
  });

  it('falls back to the bare skill name when the chip has no display name', () => {
    expect(composerSlashMarkdownToPrompt(
      '[personal-knowledge](flowix://slash/flowix/skill:personal-knowledge)',
    )).toBe('personal-knowledge');
  });

  it('keeps the dsh/pi/codex prompt-line behavior unchanged', () => {
    // dsh chips persist unscoped; only the LEGACY_DSH_COMMANDS names survive.
    expect(composerSlashMarkdownToPrompt('[/export](flowix://slash/export)')).toBe('/export');
    expect(composerSlashMarkdownToPrompt('[skill:review](flowix://slash/pi/skill:review)')).toBe('/skill:review');
    expect(composerSlashMarkdownToPrompt('[unknown](flowix://slash/codex/unknown)')).toBe('/unknown');
  });
});

describe('flowix skill chips', () => {
  it('round-trips through markdown with the display name preserved', () => {
    const editor = createEditor();
    insertComposerFlowixSkillToken(editor, 'skill:personal-knowledge', '知识整理');
    const markdown = editor.getMarkdown();
    expect(markdown).toContain('flowix://slash/flowix/skill:personal-knowledge');
    expect(markdown).toContain('知识整理');

    const reloaded = createEditor(markdown);
    expect(reloaded.getMarkdown()).toBe(markdown);
    expect(extractComposerFlowixSkillNames(reloaded.getMarkdown()))
      .toEqual(['skill:personal-knowledge']);
    expect(stripComposerFlowixSkillTokens(reloaded.getMarkdown()).trim()).toBe('');
    reloaded.destroy();
    editor.destroy();
  });

  it('supports several chips in one draft without clearing text', () => {
    const editor = createEditor('帮我处理');
    editor.commands.focus('end');
    insertComposerFlowixSkillToken(editor, 'skill:a', '技能A');
    insertComposerFlowixSkillToken(editor, 'skill:b', '技能B');
    const markdown = editor.getMarkdown();
    expect(markdown).toContain('帮我处理');
    expect(extractComposerFlowixSkillNames(markdown)).toEqual(['skill:a', 'skill:b']);
    const prompt = composerSlashMarkdownToPrompt(markdown);
    expect(prompt).toContain('帮我处理');
    expect(prompt).toContain('技能A');
    expect(prompt).toContain('技能B');
    editor.destroy();
  });

  it('extracts names in chip order and ignores other agents chips', () => {
    const markdown = [
      '[B 技能](flowix://slash/flowix/skill:beta)',
      '[/export](flowix://slash/dsh/export)',
      '[A 技能](flowix://slash/flowix/skill:alpha)',
      '[pi 技能](flowix://slash/pi/skill:pi-only)',
    ].join('');
    expect(extractComposerFlowixSkillNames(markdown)).toEqual(['skill:beta', 'skill:alpha']);
    expect(stripComposerFlowixSkillTokens(markdown))
      .toBe('[/export](flowix://slash/dsh/export)[pi 技能](flowix://slash/pi/skill:pi-only)');
  });
});
