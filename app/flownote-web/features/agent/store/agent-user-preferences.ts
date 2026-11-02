import type { AgentHarnessPreset, AgentTypeKey, RuntimeConfig } from "@/types/agent";
import { modelPreferenceKey, useAgentDataStore } from "./agent-data-store";

/** Apply this Agent's remembered preferences, preserving conversation overrides. */
export function resolveAgentPreferenceRuntimeConfig(
  agentType: AgentTypeKey,
  runtimeConfig: RuntimeConfig = {},
): RuntimeConfig {
  const agent = useAgentDataStore.getState().agents[agentType];
  const preference = agent.user;
  const model = runtimeConfig.model ?? (preference.model
    ? { key: preference.model.id, ...(preference.model.providerId ? { providerId: preference.model.providerId } : {}) }
    : undefined);
  const modelReasoning = model
    ? preference.reasoningByModel?.[modelPreferenceKey({ id: model.key, providerId: model.providerId })]
    : undefined;
  const supportedEfforts = model
    ? agent.catalog.models.items.find((item) => item.id === model.key && item.providerId === model.providerId)?.reasoningEfforts
    : undefined;
  const defaultEffort = supportedEfforts?.includes("medium") ? "medium" : supportedEfforts?.[0];
  const reasoningEffort = runtimeConfig.reasoningEffort ?? modelReasoning
    ?? (!model ? preference.reasoningEffort : defaultEffort);
  const permission = runtimeConfig.access?.sandbox ?? preference.permission;
  const serviceTier = runtimeConfig.serviceTier ?? preference.serviceTier;
  const harnessMode = runtimeConfig.deepseekHarness?.mode ?? preference.mode;
  // Historical Pi mode snapshots are ignored; Pi mode is shared across conversations.
  const { pi: _legacyPiMode, ...conversationConfig } = runtimeConfig;
  return {
    ...conversationConfig,
    ...(model ? { model } : {}),
    ...(permission ? { access: { ...runtimeConfig.access, sandbox: permission } } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    ...(harnessMode && agentType === "dsh"
      ? { deepseekHarness: { ...runtimeConfig.deepseekHarness, mode: harnessMode as AgentHarnessPreset } }
      : {}),
  };
}
