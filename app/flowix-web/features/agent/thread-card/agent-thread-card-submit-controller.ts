import { ensureAgentWorkspaceReady } from "@features/agent/store/agent-data-store";
import type { AgentTypeKey } from "@/types/agent";
import type { AgentConversationSource } from "@features/agent/store/agent-conversation-types";
import { createConversationInstanceId } from "@features/agent/store/conversation-slice";
import { buildInitialInstanceRuntimeConfig } from "@features/agent/store/initial-runtime-config";
import {
  ensureConversationWorkspaceSnapshot,
  markConversationWorkspaceStarted,
} from "@features/agent/runtime/workspace-snapshot";
import { ensureAgentThreadCardThread } from "@features/agent/thread-card/agent-thread-card-submit";
import { upsertAgentThreadCardConversationInstance } from "@features/agent/thread-card/runtime/thread-card-conversation";

export interface EnsureAgentThreadCardConversationInput {
  prompt: string;
  fallbackTitle: string;
  typeKey: AgentTypeKey;
  currentThreadId: string | null;
  currentInstanceId: string | null;
  currentTitle: string;
  runtimeHandleId: string;
  source: AgentConversationSource;
  buildTitle: (prompt: string, fallback: string) => string;
  onThreadBound: (binding: {
    instanceId: string;
    threadId: string;
    typeKey: AgentTypeKey;
  }) => void;
}

export interface EnsureAgentThreadCardConversationResult {
  instanceId: string;
  threadId: string;
  title: string;
  typeKey: AgentTypeKey;
  runtimeConfig: ReturnType<typeof ensureConversationWorkspaceSnapshot>;
  isFirstMessage: boolean;
}

/** Bind a card without starting a model turn; DSH commands use this path. */
export async function ensureAgentThreadCardConversation(
  input: EnsureAgentThreadCardConversationInput,
): Promise<EnsureAgentThreadCardConversationResult> {
  let nextThreadId = input.currentThreadId;
  let nextInstanceId = input.currentInstanceId;
  let nextTitle =
    input.currentTitle || input.buildTitle(input.prompt, input.fallbackTitle);
  let nextTypeKey = input.typeKey;
  const isFirstMessage = !nextThreadId;

  if (!nextInstanceId) nextInstanceId = createConversationInstanceId();

  if (!nextThreadId) {
    const ensured = await ensureAgentThreadCardThread({
      prompt: input.prompt,
      fallbackTitle: input.fallbackTitle,
      typeKey: input.typeKey,
      currentThreadId: input.currentThreadId,
      runtimeHandleId: input.runtimeHandleId,
      instanceId: nextInstanceId,
      buildTitle: input.buildTitle,
    });
    if (ensured) {
      nextThreadId = ensured.threadId;
      nextTitle = ensured.title;
      nextTypeKey = ensured.typeKey;
    }
  }

  if (!nextThreadId) throw new Error("Agent thread id was not created");

  const conversation = await upsertAgentThreadCardConversationInstance({
    instanceId: nextInstanceId,
    agentType: nextTypeKey,
    title: nextTitle,
    threadId: nextThreadId,
    source: input.source,
    runtimeConfig: buildInitialInstanceRuntimeConfig(nextTypeKey),
  });
  nextInstanceId = conversation.instanceId;
  await ensureAgentWorkspaceReady();
  const runtimeConfig = ensureConversationWorkspaceSnapshot(nextInstanceId);
  markConversationWorkspaceStarted(nextInstanceId);
  input.onThreadBound({
    instanceId: nextInstanceId,
    threadId: nextThreadId,
    typeKey: nextTypeKey,
  });

  return {
    instanceId: nextInstanceId,
    threadId: nextThreadId,
    title: nextTitle,
    typeKey: nextTypeKey,
    runtimeConfig,
    isFirstMessage,
  };
}
