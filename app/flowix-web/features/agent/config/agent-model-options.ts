import type { AgentTypeKey } from "@/types/agent";
import { CODEX_MODEL_OPTIONS, formatModelDisplayLabel } from "./codex-options";
import { normalizeAgentId } from "@/lib/agent-types";

/** Built-in models shown before an Agent catalog has loaded. */
export function getFallbackAgentModelOptions(agentType: AgentTypeKey): Array<{ id: string; label: string }> {
  const id = normalizeAgentId(agentType);
  if (id === "codex") {
    return CODEX_MODEL_OPTIONS.map(({ id, label }) => ({ id, label }));
  }
  if (id === "claudecode") {
    return ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"]
      .map((id) => ({ id, label: formatModelDisplayLabel(id) }));
  }
  return [];
}
