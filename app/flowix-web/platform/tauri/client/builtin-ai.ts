import { invoke } from '@tauri-apps/api/core';

/**
 * 内置 AI 助手（移动端 builtin agent）的配置 IPC。
 *
 * 与桌面外部 Agent 的配置（agent-config / Pi / DSH）完全独立；API key
 * 永远不会从后端返回（只有 hasApiKey 布尔）。
 */
export interface BuiltinAiConfigView {
  enabled: boolean;
  apiUrl: string;
  model: string;
  maxTotalTokens: number;
  hasApiKey: boolean;
  configured: boolean;
}

export interface BuiltinAiConfigInput {
  enabled: boolean;
  apiUrl: string;
  /** `null` keeps the stored key; an explicit string (including '') replaces it. */
  apiKey: string | null;
  model: string;
  maxTotalTokens?: number;
}

export interface BuiltinAiOverride {
  apiUrl?: string;
  /** Empty/undefined falls back to the stored key. */
  apiKey?: string;
  model?: string;
}

export const builtinAi = {
  getConfig: () => invoke<BuiltinAiConfigView>('agent_builtin_get_config'),
  setConfig: (input: BuiltinAiConfigInput) =>
    invoke<BuiltinAiConfigView>('agent_builtin_set_config', { input }),
  /** Tests the given form values; empty apiKey falls back to the stored key. */
  testConnection: (over?: BuiltinAiOverride) =>
    invoke<string>('agent_builtin_test_connection', { over: over ?? null }),
  listModels: (over?: BuiltinAiOverride) =>
    invoke<string[]>('agent_builtin_list_models', { over: over ?? null }),
};
