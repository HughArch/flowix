import type { AgentTypeKey } from "@/types/agent";

export interface ComposerSlashCommand {
  name: string;
  description: string;
  /** Agent-owned commands are only offered by that agent's composer. */
  agentType?: AgentTypeKey;
  /** Owner is explicit so another agent's same-named slash item is not reused. */
  owner?: "dsh" | "flowix";
  /** How selection continues: execute now, add a prompt token, or drill down. */
  interaction?: "direct" | "prompt" | "drilldown";
  /** Execution authority behind the selected item. */
  execution?: "dsh-command" | "dsh-skill" | "codex-command" | "codex-skill" | "host-action";
}

export const COMPOSER_SLASH_COMMANDS: readonly ComposerSlashCommand[] = [
  { name: "compact", description: "压缩较早的对话上下文", agentType: "dsh", owner: "dsh", interaction: "direct", execution: "dsh-command" },
  { name: "skill", description: "选择一个 DSH Skill", agentType: "dsh", owner: "dsh", interaction: "drilldown", execution: "dsh-skill" },
  { name: "goal", description: "设置或查看长时任务目标", agentType: "dsh", owner: "dsh", interaction: "prompt", execution: "dsh-command" },
  { name: "plan", description: "进入或退出计划模式", agentType: "dsh", owner: "dsh", interaction: "prompt", execution: "dsh-command" },
  { name: "model", description: "选择本次会话使用的模型", agentType: "dsh", owner: "flowix", interaction: "drilldown", execution: "host-action" },
  { name: "permission", description: "切换权限预设", agentType: "dsh", owner: "flowix", interaction: "drilldown", execution: "host-action" },
  { name: "export", description: "导出当前 DSH 会话记录", agentType: "dsh", owner: "dsh", interaction: "direct", execution: "dsh-command" },
  { name: "compact", description: "压缩较早的 Codex 对话上下文", agentType: "codex", owner: "flowix", interaction: "direct", execution: "codex-command" },
  { name: "skill", description: "选择一个 Codex Skill", agentType: "codex", owner: "flowix", interaction: "drilldown", execution: "codex-skill" },
  { name: "goal", description: "设置或查看 Codex 长时任务目标", agentType: "codex", owner: "flowix", interaction: "prompt", execution: "codex-command" },
  { name: "plan", description: "进入或退出 Codex 计划模式", agentType: "codex", owner: "flowix", interaction: "prompt", execution: "codex-command" },
  { name: "model", description: "选择本次会话使用的模型", agentType: "codex", owner: "flowix", interaction: "drilldown", execution: "host-action" },
  { name: "permission", description: "切换权限预设", agentType: "codex", owner: "flowix", interaction: "drilldown", execution: "host-action" },
];
