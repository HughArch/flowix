/**
 * Read-only ProseMirror schema for rendering note content outside the editor.
 *
 * Markdown parsing happens in the worker against the parser-only extension
 * registry; turning the resulting JSON back into DOM needs the *real* node
 * definitions (the parser registry only ships markdown tokenizers for
 * images/note references etc., not schema nodes). Reusing the interactive
 * editor registry guarantees the schema matches what the editor itself
 * renders — plugins and NodeViews are never instantiated here, `getSchema`
 * only consumes node/mark/attribute specs.
 */
import { getSchema } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import { createMarkdownEditorExtensions } from '@features/editor/markdown-editor-extensions';

let cachedSchema: Schema | null = null;

export function getReadOnlyNoteSchema(): Schema {
  if (cachedSchema) return cachedSchema;
  cachedSchema = getSchema(createMarkdownEditorExtensions({
    ownerPath: '',
    getOwnerPath: () => undefined,
    getAttachmentNotebookId: () => undefined,
    getAttachmentNotebookPath: () => undefined,
    propertyTargetId: undefined,
    onViewSourceMode: undefined,
    transitionId: null,
    workspaceHost: 'main-third',
    getPlaceholder: () => '',
    getHeadingFoldLabels: () => ({ fold: '', unfold: '' }),
  }));
  return cachedSchema;
}
