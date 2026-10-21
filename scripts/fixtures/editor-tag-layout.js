import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Tag } from '../../app/flowix-web/features/editor/extensions/tag';
import '../../app/flowix-web/styles/fonts.css';
import '../../app/flowix-web/styles/editor.css';
import '../../app/flowix-web/styles/editor-frontmatter.css';

// Run in a real browser: jsdom cannot measure font-dependent backgrounds.
const report = document.querySelector('#tag-layout-result');
const editors = [];

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function verifyPropertyTagBackgrounds() {
  const editorProperties = document.createElement('div');
  editorProperties.className = 'markdown-editor';
  editorProperties.innerHTML = `
    <span class="frontmatter-property__edit-tag-chip"><span class="tag-node-prefix">#</span><span class="tag-node-content">note</span></span>
    <span class="frontmatter-property__edit-tag-chip frontmatter-property__edit-tag-chip--plain"><span class="tag-node-content">generic</span></span>
    <span class="frontmatter-property__value-chip tag-node"><span class="tag-node-prefix">#</span><span class="tag-node-content">display</span></span>
    <span class="frontmatter-property__value-chip frontmatter-property__value-chip--tag"><span class="tag-node-content">generic display</span></span>
    <button class="frontmatter-property__edit-tag-suggestion"><span class="tag-node-content">suggestion</span></button>`;
  document.body.append(editorProperties);

  const tableTags = document.createElement('div');
  tableTags.className = 'multidimensional-table__tag-chips';
  tableTags.innerHTML = `
    <span class="frontmatter-property__edit-tag-chip"><span class="tag-node-prefix">#</span><span class="tag-node-content">note</span></span>
    <span class="frontmatter-property__edit-tag-chip frontmatter-property__edit-tag-chip--plain"><span class="tag-node-content">generic</span></span>`;
  document.body.append(tableTags);

  const muted = document.createElement('span');
  muted.style.backgroundColor = 'var(--muted)';
  const documentTag = document.createElement('span');
  documentTag.style.backgroundColor = 'var(--document-tag-background)';
  document.body.append(muted, documentTag);
  const mutedColor = getComputedStyle(muted).backgroundColor;
  const documentTagColor = getComputedStyle(documentTag).backgroundColor;
  const expectColor = (element, color, label) => {
    const actual = getComputedStyle(element).backgroundColor;
    check(actual === color, `Unexpected background for ${label} (${element.className}): expected ${color}, got ${actual}`);
  };

  const noteTags = [
    ...editorProperties.querySelectorAll('.frontmatter-property__edit-tag-chip:not(.frontmatter-property__edit-tag-chip--plain), .frontmatter-property__edit-tag-chip:not(.frontmatter-property__edit-tag-chip--plain) > span'),
    ...editorProperties.querySelectorAll('.frontmatter-property__value-chip.tag-node, .frontmatter-property__value-chip.tag-node > span'),
    editorProperties.querySelector('.frontmatter-property__edit-tag-suggestion > .tag-node-content'),
    ...tableTags.querySelectorAll('.frontmatter-property__edit-tag-chip:not(.frontmatter-property__edit-tag-chip--plain), .frontmatter-property__edit-tag-chip:not(.frontmatter-property__edit-tag-chip--plain) > span'),
  ];
  for (const tag of noteTags) expectColor(tag, mutedColor, 'note tag');

  const genericTags = editorProperties.querySelectorAll(
    '.frontmatter-property__edit-tag-chip--plain, .frontmatter-property__edit-tag-chip--plain > span, .frontmatter-property__value-chip--tag, .frontmatter-property__value-chip--tag > span',
  );
  for (const tag of genericTags) expectColor(tag, documentTagColor, 'generic tag value');
  for (const tag of tableTags.querySelectorAll('.frontmatter-property__edit-tag-chip--plain, .frontmatter-property__edit-tag-chip--plain > span')) {
    expectColor(tag, documentTagColor, 'generic table value');
  }
}

async function verify() {
  verifyPropertyTagBackgrounds();
  for (const font of ['Inter', 'serif', 'monospace']) {
    for (const size of [16, 22]) {
      const wrapper = document.createElement('div');
      wrapper.className = 'markdown-editor';
      wrapper.style.setProperty('--editor-font-family', font);
      wrapper.style.setProperty('--editor-font-size', `${size}px`);
      document.body.append(wrapper);
      const host = document.createElement('div');
      wrapper.append(host);
      const editor = new Editor({
        element: host,
        extensions: [StarterKit, Tag],
        content: '<p>#xxx中文</p>',
      });
      editors.push({ font, size, wrapper, editor });
    }
  }

  const results = [];
  // These are CSS branches, not simulations of the operating systems.
  for (const os of ['macos', 'windows']) {
    document.documentElement.dataset.os = os;
    document.body.getBoundingClientRect();
    await document.fonts.ready;
    for (const { font, size, wrapper, editor } of editors) {
      const context = `${os}, ${font}, ${size}px`;
      const prefix = wrapper.querySelector('.tag-node-prefix-box');
      const content = wrapper.querySelector('.tag-node-content-box');
      const a = prefix.getBoundingClientRect();
      const b = content.getBoundingClientRect();
      check(a.top === b.top && a.height === b.height, `Background bounds differ: ${context}`);
      for (const box of [prefix, content]) {
        check(!['transparent', 'rgba(0, 0, 0, 0)'].includes(getComputedStyle(box).backgroundColor),
          `Missing background: ${context}`);
      }
      const icon = getComputedStyle(wrapper.querySelector('.tag-node-prefix'));
      const expectedFont = os === 'windows' ? 'Flowix Tag Icon Consolas' : 'Flowix Tag Icon';
      check(icon.fontFamily.split(',')[0].replaceAll('"', '').trim() === expectedFont,
        `Icon font changed: ${context}`);
      check(Math.abs(parseFloat(icon.fontSize) - size) < 0.01, `Icon size changed: ${context}`);

      editor.view.dom.focus();
      editor.commands.setTextSelection(2);
      // Native browser editing also exercises ProseMirror's DOM observer.
      check(document.execCommand('insertText', false, '测'), `Native insertion failed: ${context}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
      check(editor.getText() === '#测xxx中文', `Inserted text was lost: ${context}`);
      editor.commands.setContent('<p>#xxx中文</p>');
      results.push(context);
    }
  }
  return results;
}

verify().then((cases) => {
  report.textContent = JSON.stringify({ ok: true, cases });
}).catch((error) => {
  report.textContent = JSON.stringify({ ok: false, error: error.message });
});
