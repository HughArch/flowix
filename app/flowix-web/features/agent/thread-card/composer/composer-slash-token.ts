import { Node, type Editor, type JSONContent, type MarkdownToken } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin, type EditorState } from "@tiptap/pm/state";
import type { AgentTypeKey } from "@/types/agent";
import { createTerminalInlineAtomCaretDecorations } from "@features/editor/extensions/shared/terminal-inline-atom-caret";

export interface ComposerSlashTokenOptions {
  onRemove?: () => void;
}

export interface ComposerSlashTokenValue {
  command: string;
  agentType?: AgentTypeKey;
}

const SLASH_TOKEN_RE = /^\[\/([a-z0-9._:-]+)\]\(flowix:\/\/slash\/(?:(deepseek-harness|codex|pi)\/)?([a-z0-9._:-]+)\)/i;
const SLASH_TOKEN_GLOBAL_RE = /\[\/([a-z0-9._:-]+)\]\(flowix:\/\/slash\/(?:(deepseek-harness|codex|pi)\/)?([a-z0-9._:-]+)\)/gi;
const LEGACY_DSH_COMMANDS = new Set([
  "compact",
  "skill",
  "goal",
  "plan",
  "export",
  "model",
]);

const CONTROL_COMMANDS = new Set(["goal", "plan"]);

function isControlCommand(command: string): boolean {
  return CONTROL_COMMANDS.has(command.trim().toLowerCase());
}

function slashTokenClass(command: string): string {
  return isControlCommand(command)
    ? "agent-thread-card__slash-token agent-thread-card__slash-token--control"
    : "agent-thread-card__slash-token";
}

export const ComposerSlashToken = Node.create<ComposerSlashTokenOptions>({
  name: "composerSlashToken",
  priority: 1000,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addOptions() { return { onRemove: undefined }; },
  addAttributes() {
    return {
      command: { default: "" },
      agentType: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-composer-slash]", getAttrs: (dom) => ({
      command: (dom as HTMLElement).getAttribute("data-composer-slash") ?? "",
      agentType: (dom as HTMLElement).getAttribute("data-composer-slash-agent") || null,
    }) }];
  },

  renderHTML({ node }) {
    const command = String(node.attrs?.command ?? "");
    const agentType = String(node.attrs?.agentType ?? "");
    return ["span", {
      "data-composer-slash": command,
      ...(agentType ? { "data-composer-slash-agent": agentType } : {}),
      class: "agent-thread-card__slash-token-wrapper",
    }, ["button", {
      class: slashTokenClass(command),
      type: "button",
    }, `/${command}`], "\u200B"];
  },

  markdownTokenizer: {
    name: "composerSlashToken",
    level: "inline" as const,
    start(src: string) {
      const index = src.indexOf("flowix://slash/");
      return index >= 0 ? index : -1;
    },
    tokenize(src: string) {
      const match = SLASH_TOKEN_RE.exec(src);
      return match ? {
        type: "composerSlashToken",
        raw: match[0],
        href: `flowix://slash/${match[2] ? `${match[2]}/` : ""}${match[3]}`,
        text: `/${match[1]}`,
      } : undefined;
    },
  },

  parseMarkdown(token: MarkdownToken) {
    const href = String(token.href ?? "");
    const path = href.replace(/^flowix:\/\/slash\//i, "");
    const parts = path.split("/");
    const agentType = parts[0] === "deepseek-harness" || parts[0] === "codex" || parts[0] === "pi"
      ? parts[0]
      : undefined;
    const command = (agentType ? parts[1] : parts[0]) ||
      String(token.text ?? "").replace(/^\//, "");
    return { type: "composerSlashToken", attrs: { command, agentType } };
  },

  renderMarkdown(node: JSONContent) {
    const command = String(node.attrs?.command ?? "");
    const agentType = String(node.attrs?.agentType ?? "");
    return `[/${command}](flowix://slash/${agentType ? `${agentType}/` : ""}${command})`;
  },

  addNodeView() {
    return ({ node, view, getPos }) => {
      // Keep the atom's visual card separate from its terminal caret landing
      // point. The trailing text node is deliberately real: a span boundary
      // is not a reliable caret anchor in Chromium/WebKit. There is no
      // leading spacer because it makes the native caret render inside the
      // chip, unlike the other composer reference cards.
      const wrapper = document.createElement("span");
      wrapper.className = "agent-thread-card__slash-token-wrapper";
      wrapper.contentEditable = "false";
      wrapper.setAttribute("data-composer-slash", String(node.attrs.command ?? ""));
      const agentType = String(node.attrs.agentType ?? "");
      if (agentType) wrapper.setAttribute("data-composer-slash-agent", agentType);

      const button = document.createElement("button");
      const command = String(node.attrs.command ?? "");
      button.type = "button";
      button.className = slashTokenClass(command);
      button.textContent = `/${command}`;
      button.title = "点击移除命令";
      button.setAttribute("aria-label", `移除 /${command} 命令`);
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const pos = typeof getPos === "function" ? getPos() : undefined;
        if (pos === undefined) return;
        view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
        view.focus();
      });

      wrapper.append(button, document.createTextNode("\u200B"));

      return {
        dom: wrapper,
        contentDOM: null,
        selectNode: () => wrapper.classList.add("is-selected"),
        deselectNode: () => wrapper.classList.remove("is-selected"),
        stopEvent: (event: Event) => !event.type.startsWith("composition"),
        ignoreMutation: () => true,
      };
    };
  },

  onCreate() {
    const tr = removeHardBreaksAroundComposerSlashTokens(this.editor.state);
    if (tr?.docChanged) this.editor.view.dispatch(tr);
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations: (state) => createTerminalInlineAtomCaretDecorations(
            state.doc,
            "composerSlashToken",
          ),
        },
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((transaction) => transaction.docChanged)) return null;
          return removeHardBreaksAroundComposerSlashTokens(newState);
        },
      }),
    ];
  },

  addKeyboardShortcuts() {
    return {
      Backspace: () => deleteAdjacentComposerSlashToken(this.editor, "before"),
      Delete: () => deleteAdjacentComposerSlashToken(this.editor, "after"),
    };
  },
});

function removeHardBreaksAroundComposerSlashTokens(state: EditorState) {
  const deletions: Array<{ from: number; to: number }> = [];
  const seen = new Set<string>();

  const pushDeletion = (from: number, to: number) => {
    const key = `${from}:${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    deletions.push({ from, to });
  };

  state.doc.descendants((node: ProseMirrorNode, pos: number) => {
    if (node.type.name !== "composerSlashToken") return;

    const $pos = state.doc.resolve(pos);
    if ($pos.nodeBefore?.type.name === "hardBreak") {
      pushDeletion(pos - $pos.nodeBefore.nodeSize, pos);
    }

    const afterPos = pos + node.nodeSize;
    const $after = state.doc.resolve(afterPos);
    if ($after.nodeAfter?.type.name === "hardBreak") {
      pushDeletion(afterPos, afterPos + $after.nodeAfter.nodeSize);
    }
  });

  if (deletions.length === 0) return null;

  const tr = state.tr;
  deletions.reverse().forEach(({ from, to }) => tr.delete(from, to));
  return tr;
}

function deleteAdjacentComposerSlashToken(
  editor: Editor,
  direction: "before" | "after",
): boolean {
  const { selection } = editor.state;
  if (selection instanceof NodeSelection && selection.node.type.name === "composerSlashToken") {
    editor.commands.deleteSelection();
    return true;
  }

  const { $from } = selection;
  const node = direction === "before" ? $from.nodeBefore : $from.nodeAfter;
  if (!node || node.type.name !== "composerSlashToken") return false;

  const from = direction === "before" ? $from.pos - node.nodeSize : $from.pos;
  editor.commands.deleteRange({ from, to: from + node.nodeSize });
  return true;
}

export function getComposerSlashToken(editor: Editor): ComposerSlashTokenValue | null {
  let value: ComposerSlashTokenValue | null = null;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "composerSlashToken" && value === null) {
      const agentType = String(node.attrs.agentType ?? "").trim();
      value = {
        command: String(node.attrs.command ?? ""),
        ...(agentType ? { agentType: agentType as AgentTypeKey } : {}),
      };
      return false;
    }
    return value === null;
  });
  return value;
}

export function insertComposerSlashToken(
  editor: Editor,
  command: string,
  agentType?: AgentTypeKey,
): void {
  const { selection } = editor.state;
  editor.chain().focus().deleteRange({ from: 1, to: selection.to })
    .insertContent([
      {
        type: "composerSlashToken",
        attrs: { command, agentType: agentType ?? null },
      },
      { type: "text", text: " " },
    ]).run();
}

/** Convert persisted slash chips back into the provider command/prompt line. */
export function composerSlashMarkdownToPrompt(markdown: string): string {
  return markdown.replace(
    SLASH_TOKEN_GLOBAL_RE,
    (match, command: string, scopedAgent: string | undefined, _encoded: string, offset: number, source: string) => {
      // Unscoped chips are legacy data. Preserve old DSH drafts while keeping
      // the product-only permission chips UI-only as before.
      if (
        scopedAgent &&
        scopedAgent.toLowerCase() !== "deepseek-harness" &&
        scopedAgent.toLowerCase() !== "codex" &&
        scopedAgent.toLowerCase() !== "pi" ||
        (!scopedAgent && !LEGACY_DSH_COMMANDS.has(command.toLowerCase()))
      ) {
        return "";
      }
      const after = source.slice(offset + match.length);
      // A chip is an atom, so text typed immediately after it needs the
      // separator that the native DSH command parser expects.
      return `/${command}${after && !/^\s/u.test(after) ? " " : ""}`;
    },
  );
}

export function removeComposerSlashToken(editor: Editor): void {
  let found: { from: number; to: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found === null && node.type.name === "composerSlashToken") {
      found = { from: pos, to: pos + node.nodeSize };
      return false;
    }
    return found === null;
  });
  if (!found) return;
  const range = found as { from: number; to: number };
  editor.view.dispatch(editor.state.tr.delete(range.from, range.to));
}
