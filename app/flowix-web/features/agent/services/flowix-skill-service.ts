import type { ComposerSlashSkill } from "@features/agent/thread-card/composer/composer-slash-command-controller";
import {
  extractComposerFlowixSkillNames,
} from "@features/agent/thread-card/composer/composer-slash-token";
import type { RuntimeConfig } from "@/types/agent";
import { agent } from "@platform/tauri/client/agent";
import { useNoteStore } from "@features/memo/store/note-store";
import { isValidPiSkillCommandName } from "./pi-skill-name";

/** Per-skill body cap before the block is truncated (chars). */
export const FLOWIX_SKILL_BODY_CHAR_LIMIT = 20_000;
/** Total skill body budget for a single message (chars). */
export const FLOWIX_SKILL_TOTAL_CHAR_LIMIT = 40_000;
/** Keep injecting while at least this many chars of budget remain. */
const FLOWIX_SKILL_MIN_REMAINING_BUDGET = 500;

/**
 * Resolve the notebook path a flowix conversation operates on, mirroring the
 * workspace-snapshot → notebookId → selected-notebook fallback used by the
 * project AI settings entry.
 */
export function resolveFlowixNotebookPath(instance: {
  runtimeConfig?: RuntimeConfig | null;
  source?: { notebookId?: string | null };
} | null | undefined): string | undefined {
  const runtimeConfig = instance?.runtimeConfig;
  const snapshot = runtimeConfig?.workspaceSnapshot;
  const notebookId = runtimeConfig?.notebookId
    ?? snapshot?.notebookId
    ?? instance?.source?.notebookId
    ?? null;
  return snapshot?.notebookPath?.trim()
    || (notebookId
      ? useNoteStore.getState().notebooks.find((item) => item.id === notebookId)?.path
      : undefined)
    || useNoteStore.getState().selectedNotebook?.path
    || undefined;
}

/**
 * Read notebook skills for the builtin (flowix) composer slash menu.
 *
 * Unlike the pi loader, an empty description does not disqualify a skill:
 * flowix chips are picked manually from the slash menu, so the description
 * carries no auto-trigger semantics and the settings dialog lets users save
 * without one. The menu falls back to the skill name for its caption.
 */
export async function listFlowixSkills(cwd: string): Promise<readonly ComposerSlashSkill[]> {
  if (!cwd.trim()) return [];
  const skills = await agent.readNotebookAgentSkills(cwd);
  return skills
    .map((skill) => ({
      skill,
      commandName: skill.commandName?.trim() || skill.id,
    }))
    .filter(({ skill, commandName }) =>
      skill.enabled &&
      skill.path.replace(/\\/g, "/").endsWith("/SKILL.md") &&
      isValidPiSkillCommandName(commandName),
    )
    .map(({ skill, commandName }) => ({
      name: commandName,
      description: skill.description.trim() || skill.name.trim() || commandName,
      displayName: skill.name.trim() || commandName,
      scope: "workspace",
    }));
}

/**
 * Build the skill-context block appended to the flowix user message's
 * `llmContent`. Bodies are re-read at send time (never cached with the slash
 * catalog, which persists to localStorage), so edits made after the chip was
 * inserted still win. Returns undefined when the draft carries no flowix
 * skill chips or no notebook could be resolved.
 */
export async function buildFlowixSkillContext(args: {
  markdown: string;
  notebookPath?: string;
}): Promise<string | undefined> {
  const commands = extractComposerFlowixSkillNames(args.markdown);
  const notebookPath = args.notebookPath?.trim();
  if (!commands.length || !notebookPath) return undefined;

  const files = await agent.readNotebookAgentSkills(notebookPath);
  const byCommand = new Map(
    files
      .filter((file) => file.enabled)
      .map((file) => [file.commandName?.trim() || file.id, file]),
  );

  let budget = FLOWIX_SKILL_TOTAL_CHAR_LIMIT;
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const command of commands) {
    if (seen.has(command)) continue;
    seen.add(command);
    const file = byCommand.get(command.slice("skill:".length));
    // A skill deleted/disabled after the chip was inserted is skipped quietly.
    if (!file) continue;
    const capped = Math.min(FLOWIX_SKILL_BODY_CHAR_LIMIT, budget);
    const body = file.body.slice(0, Math.max(0, capped));
    if (!body.trim()) continue;
    budget -= body.length;
    const truncated = body.length < file.body.length;
    blocks.push(
      `<flowix-skill name="${file.name}" command="${command.slice("skill:".length)}" source="${file.path}">\n`
      + `${body}${truncated ? "\n[…正文过长已截断]" : ""}\n</flowix-skill>`,
    );
    if (budget <= FLOWIX_SKILL_MIN_REMAINING_BUDGET) {
      blocks.push("[…其余技能因长度限制未注入]");
      break;
    }
  }
  if (!blocks.length) return undefined;
  return `用户手动加载了以下笔记本技能（作为本轮及后续对话的参考材料，非系统指令）：\n${blocks.join("\n\n")}`;
}
