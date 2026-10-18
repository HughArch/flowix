import type { Editor } from "@tiptap/core";
import type { AgentThreadCardInputAttachment } from "./composer-attachment-types";
import { COMPOSER_ATTACHMENT_NODE_NAME } from "./composer-attachment-compat";
import {
  captureComposerInsertionAnchor,
  type ComposerInsertionAnchor,
  type ComposerInsertionPoint,
} from "./composer-insertion-anchor";

export interface ComposerAttachmentDocumentPort {
  captureAttachmentInsertionAnchor(): ComposerInsertionAnchor | undefined;
  insertAttachmentToken(
    attachment: AgentThreadCardInputAttachment,
    position?: ComposerInsertionPoint,
  ): ComposerInsertionPoint | undefined;
  removeAttachmentToken(path: string): void;
  setAttachmentTokensChanged(
    handler: (attachments: readonly AgentThreadCardInputAttachment[]) => void,
  ): void;
  dispose(): void;
}

export function insertComposerAttachmentToken(
  editor: Editor,
  attachment: AgentThreadCardInputAttachment,
  position?: ComposerInsertionPoint,
): ComposerInsertionPoint {
  const { doc } = editor.state;
  const maxPosition = Math.max(1, doc.content.size - 1);
  const from = position ? Math.max(1, Math.min(position.from, maxPosition)) : 1;
  const to = position ? Math.max(from, Math.min(position.to, maxPosition)) : from;
  const before = from > 1 ? doc.textBetween(from - 1, from, "\n", "\n") : "";
  const after = to < maxPosition ? doc.textBetween(to, to + 1, "\n", "\n") : "";
  const content: Array<Record<string, unknown>> = [];
  if (before && !/\s/u.test(before)) content.push({ type: "text", text: " " });
  content.push({
    type: COMPOSER_ATTACHMENT_NODE_NAME,
    attrs: { path: attachment.path, name: attachment.name, mimeType: attachment.mimeType },
  });
  if (after && !/\s/u.test(after)) content.push({ type: "text", text: " " });
  editor.chain().focus(null, { scrollIntoView: false }).insertContentAt({ from, to }, content).run();
  const end = editor.state.selection.to;
  return { from: end, to: end };
}

/** Tiptap document operations and token synchronization for composer files. */
export class ComposerAttachmentDocument implements ComposerAttachmentDocumentPort {
  private changed?: (attachments: readonly AgentThreadCardInputAttachment[]) => void;

  constructor(private readonly editor: Editor) {
    editor.on("transaction", this.handleTransaction);
  }

  dispose(): void {
    this.changed = undefined;
    if (!this.editor.isDestroyed) this.editor.off("transaction", this.handleTransaction);
  }

  captureAttachmentInsertionAnchor(): ComposerInsertionAnchor | undefined {
    if (this.editor.isDestroyed) return undefined;
    return captureComposerInsertionAnchor(this.editor);
  }

  insertAttachmentToken(
    attachment: AgentThreadCardInputAttachment,
    position?: ComposerInsertionPoint,
  ): ComposerInsertionPoint | undefined {
    if (this.editor.isDestroyed) return undefined;
    let exists = false;
    this.editor.state.doc.descendants((node) => {
      if (node.type.name === COMPOSER_ATTACHMENT_NODE_NAME && node.attrs.path === attachment.path) {
        exists = true;
      }
    });
    return exists ? position : this.insert(attachment, position);
  }

  removeAttachmentToken(path: string): void {
    if (this.editor.isDestroyed) return;
    const matches: Array<{ from: number; to: number }> = [];
    this.editor.state.doc.descendants((node, pos) => {
      if (node.type.name === COMPOSER_ATTACHMENT_NODE_NAME && node.attrs.path === path) {
        matches.push({ from: pos, to: pos + node.nodeSize });
      }
    });
    if (matches.length === 0) return;
    const transaction = this.editor.state.tr;
    for (const match of matches.reverse()) transaction.delete(match.from, match.to);
    this.editor.view.dispatch(transaction);
  }

  setAttachmentTokensChanged(
    handler: (attachments: readonly AgentThreadCardInputAttachment[]) => void,
  ): void {
    this.changed = handler;
    this.reportChanges();
  }

  private reportChanges(): void {
    if (!this.changed || this.editor.isDestroyed) return;
    const attachments = new Map<string, AgentThreadCardInputAttachment>();
    this.editor.state.doc.descendants((node) => {
      if (node.type.name !== COMPOSER_ATTACHMENT_NODE_NAME || !node.attrs.path) return;
      const path = String(node.attrs.path);
      attachments.set(path, {
        path,
        name: String(node.attrs.name ?? ""),
        mimeType: String(node.attrs.mimeType ?? "application/octet-stream"),
      });
    });
    this.changed([...attachments.values()]);
  }

  private readonly handleTransaction = ({ transaction }: { transaction: { docChanged: boolean } }): void => {
    if (transaction.docChanged) this.reportChanges();
  };

  private insert(
    attachment: AgentThreadCardInputAttachment,
    position?: ComposerInsertionPoint,
  ): ComposerInsertionPoint {
    return insertComposerAttachmentToken(this.editor, attachment, position);
  }
}
