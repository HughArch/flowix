import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import {
  createInlineAtomCloseIcon,
  createInlineAtomNodeView,
  deleteInlineAtomNode,
} from "@features/editor/extensions/shared/inline-atom-nodeview";
import { createComposerAttachmentPreview } from "./composer-attachment-preview";

export function createComposerAttachmentNodeView(options: {
  node: ProseMirrorNode;
  view: EditorView;
  getPos: (() => number | undefined) | boolean;
}) {
  const { node, view, getPos } = options;
  const path = String(node.attrs.path ?? "");
  const name = String(node.attrs.name ?? "");
  const mimeType = String(node.attrs.mimeType ?? "application/octet-stream");
  const content = document.createElement("span");
  content.className = "agent-composer__attachment-token";
  content.title = name;
  content.setAttribute("aria-label", `附件 ${name}`);

  const preview = createComposerAttachmentPreview(path, name, mimeType, content);
  const label = document.createElement("span");
  label.className = "agent-composer__attachment-token-label";
  label.textContent = name;
  label.title = name;
  content.append(preview.element, label);

  const nodeView = createInlineAtomNodeView({
    caretGeometry: "single-line",
    wrapperClassName: "agent-composer__inline-atom-wrapper agent-composer__attachment-token-wrapper",
    content,
    title: name,
    onClick: () => preview.onClick(),
    hoverActions: [{
      ariaLabel: `移除附件 ${name}`,
      icon: createInlineAtomCloseIcon(),
      onClick: () => deleteInlineAtomNode(
        view,
        node,
        () => typeof getPos === "function" ? getPos() : undefined,
      ),
    }],
  });

  return {
    ...nodeView,
    destroy: () => {
      preview.destroy();
    },
  };
}
