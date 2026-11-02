import { invoke } from '@tauri-apps/api/core';

/**
 * 内置 AI 助手（移动端 builtin agent）的配置 IPC。
 *
 * 与桌面外部 Agent 的配置（agent-config / Pi / DSH）完全独立；API key
 * 永远不会从后端返回（只有 hasApiKey 布尔）。支持配置多个厂商（provider），
 * 通过 activeProviderId 切换当前使用的厂商。
 */
export interface BuiltinAiProviderView {
  id: string;
  name: string;
  apiUrl: string;
  model: string;
  hasApiKey: boolean;
  configured: boolean;
}

export interface BuiltinAiConfigView {
  enabled: boolean;
  webSearchEnabled: boolean;
  providers: BuiltinAiProviderView[];
  activeProviderId: string;
  configured: boolean;
}

export interface BuiltinAiProviderInput {
  /** `null` creates a new provider; an existing id updates it in place. */
  id?: string | null;
  name: string;
  apiUrl: string;
  /** `null` keeps the stored key; an explicit string (including '') replaces it. */
  apiKey: string | null;
  model: string;
}

export interface BuiltinAiConfigInput {
  enabled: boolean;
  webSearchEnabled: boolean;
  providers: BuiltinAiProviderInput[];
  activeProviderId: string;
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
  setActiveProvider: (providerId: string) =>
    invoke<BuiltinAiConfigView>('agent_builtin_set_active_provider', { providerId }),
  /** Tests the given form values; empty apiKey falls back to the stored key. */
  testConnection: (over?: BuiltinAiOverride) =>
    invoke<string>('agent_builtin_test_connection', { over: over ?? null }),
  listModels: (over?: BuiltinAiOverride) =>
    invoke<string[]>('agent_builtin_list_models', { over: over ?? null }),
};
