/** Device-local workspace DTOs; runtime preference types support upgrades. */

import type {
  AgentCodexReasoningEffort,
  AgentHarnessPreset,
  AgentPermissionMode,
} from "@/types/agent";

export interface LegacyAgentRuntimePreference {
  model?: { key: string; providerId?: string };
  access?: { sandbox: AgentPermissionMode };
  reasoningEffort?: AgentCodexReasoningEffort;
  serviceTier?: "auto" | "priority";
  /** DeepSeek Harness tool presentation mode. */
  mode?: AgentHarnessPreset;
  /** Default Pi codemode setting for newly created conversations. */
  piCodeMode?: boolean;
}

/** Legacy preference payload is a string-keyed map because its keys migrate. */
export type LegacyAgentRuntimePreferences = Record<string, LegacyAgentRuntimePreference>;

/** Notebook-local mount data read from local.db. The notebook itself is cwd;
 * `addDirs` contains only additional runtime roots. */
export interface NotebookAddDir {
  id: string;
  path: string;
  label: string;
  enabled: boolean;
  missing?: boolean;
}

export interface NotebookWorkspaceConfig {
  version: 1;
  revision: number;
  addDirs: NotebookAddDir[];
}

/** Authoritative device-local workspace read from local.db. */
export interface AgentWorkspaceSnapshot {
  notebooks: Array<{ id: string; name: string; path: string }>;
  notebookConfigs: Record<string, NotebookWorkspaceConfig>;
}

/** Derived resource metadata; these rows are never persisted independently. */
export interface AgentWorkspaceResource {
  id: string;
  path: string;
  name: string;
  enabled: boolean;
  missing: boolean;
}
