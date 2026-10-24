import type {
  AgentCodexModel,
  AgentCodexReasoningEffort,
} from "@/types/agent";

export type AgentModelOption = {
  id: AgentCodexModel;
  label: string;
  description?: string;
  reasoningEfforts?: AgentCodexReasoningEffort[];
  /** DeepSeek Harness llm-pi-ai route; absent for legacy/Codex options. */
  providerId?: string;
  providerName?: string;
};
