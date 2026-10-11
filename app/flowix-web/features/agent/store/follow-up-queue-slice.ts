import type { RuntimeConfig } from "@/types/agent";
import { getAgentType } from "@/lib/agent-types";
import { createRunId } from "@features/agent/events/agent-event-mapper";
import { agentClient } from "@features/agent/store/agent-client";
import { createLogger } from "@/lib/logger";
import type { AgentSessionMeta } from "@features/agent/store/session-state";
import type { ProjectionSlice } from "@features/agent/store/projection-slice";
import type { ThreadProjection } from "@features/agent/store/session-reducer";
import { isAgentThreadWorking } from "@features/agent/store/thread-runtime-state";

export type FollowUpDeliveryStatus =
  | "submitting"
  | "queued"
  | "starting"
  | "steering"
  | "cleanup_failed";

export interface PendingSteeringMessage {
  id: string;
  threadId: string;
  content: string;
  imagePaths?: string[];
  runtimeConfig?: RuntimeConfig | null;
  queuedAt: number;
  clientUserMessageId?: string;
  providerQueueId?: string;
  llmContent?: string;
  canDelete?: boolean;
  deliveryMode?: "steer" | "follow_up";
  deliveryStatus?: FollowUpDeliveryStatus;
}

export interface FollowUpQueueSlice {
  pendingSteeringMessages: Record<string, PendingSteeringMessage[]>;
  enqueueSteeringMessage: (message: PendingSteeringMessage) => void;
  updateSteeringMessage: (
    threadId: string,
    messageId: string,
    patch: Partial<PendingSteeringMessage>,
  ) => void;
  removeSteeringMessage: (threadId: string, messageId: string) => void;
  removeSteeringMessageByClientId: (threadId: string, clientUserMessageId: string) => void;
  queueCodexFollowUp: (
    threadId: string,
    message: Parameters<typeof agentClient.queueCodexFollowUp>[1],
    clientUserMessageId: string,
    localMessageId: string,
  ) => ReturnType<typeof agentClient.queueCodexFollowUp>;
  promoteFollowUpToSteer: (threadId: string, messageId: string) => Promise<void>;
  deleteQueuedFollowUp: (threadId: string, messageId: string) => Promise<void>;
  /** @deprecated Pi-specific compatibility aliases. */
  promotePiFollowUpToSteer: (threadId: string, messageId: string) => Promise<void>;
  deletePiQueuedMessage: (threadId: string, messageId: string) => Promise<void>;
  hydrateCodexFollowUps: (threadId: string) => Promise<void>;
  clearPendingSteeringMessages: (threadId: string) => void;
}

type FollowUpQueueContext = FollowUpQueueSlice & {
  sessionMeta: AgentSessionMeta;
  threadProjections: ProjectionSlice["threadProjections"];
};
type SessionSet = (
  updater: (state: FollowUpQueueContext) => Partial<FollowUpQueueContext>,
) => void;
type SessionGet = () => FollowUpQueueContext;

const hydratingCodexQueues = new Map<string, Promise<void>>();
const logger = createLogger("agent-follow-up-queue");

export function isProjectionWorking(projection: ThreadProjection | undefined): boolean {
  return isAgentThreadWorking(
    projection ? { ...projection.runs, messages: projection.messages } : undefined,
  );
}

function isCodexQueueStartConflict(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return message.includes("queued submission not found") ||
    message.includes("codex follow-up already started") ||
    message.includes("thread already has an active or pending turn") ||
    message.includes("codex already has an active turn");
}

function setMessage(
  set: SessionSet,
  threadId: string,
  messageId: string,
  patch: Partial<PendingSteeringMessage>,
): void {
  set((state) => ({
    pendingSteeringMessages: {
      ...state.pendingSteeringMessages,
      [threadId]: (state.pendingSteeringMessages[threadId] ?? []).map((message) =>
        message.id === messageId ? { ...message, ...patch } : message,
      ),
    },
  }));
}

function removeMessage(set: SessionSet, threadId: string, messageId: string): void {
  set((state) => {
    const current = state.pendingSteeringMessages[threadId] ?? [];
    const next = current.filter((message) => message.id !== messageId);
    if (next.length === current.length) return {};
    const pendingSteeringMessages = { ...state.pendingSteeringMessages };
    if (next.length) pendingSteeringMessages[threadId] = next;
    else delete pendingSteeringMessages[threadId];
    return { pendingSteeringMessages };
  });
}

function mergeServerQueue(
  serverItems: PendingSteeringMessage[],
  localItems: PendingSteeringMessage[],
): PendingSteeringMessage[] {
  const result = [...serverItems];
  for (const local of localItems) {
    const index = result.findIndex((item) => item.clientUserMessageId === local.clientUserMessageId);
    const isOperationInFlight =
      local.deliveryStatus === "submitting" ||
      local.deliveryStatus === "starting" ||
      local.deliveryStatus === "steering" ||
      local.deliveryStatus === "cleanup_failed" ||
      local.deliveryMode === "steer";
    if (index >= 0) {
      result[index] = {
        ...result[index],
        id: local.id,
        content: local.content || result[index].content,
        llmContent: local.llmContent ?? result[index].llmContent,
        imagePaths: local.imagePaths ?? result[index].imagePaths,
        runtimeConfig: local.runtimeConfig ?? result[index].runtimeConfig,
        queuedAt: local.queuedAt,
        ...(isOperationInFlight ? {
          deliveryMode: local.deliveryMode,
          deliveryStatus: local.deliveryStatus,
          canDelete: local.canDelete,
        } : {}),
      };
    } else if (isOperationInFlight) {
      // Preserve optimistic submissions and steering/cleanup operations that
      // have not reached a stable server snapshot yet.
      result.push(local);
    }
  }
  return result.sort((a, b) => a.queuedAt - b.queuedAt);
}

export function canActOnQueuedMessage(
  message: PendingSteeringMessage,
  agentType: "codex" | "pi",
): boolean {
  if (["submitting", "starting", "steering"].includes(message.deliveryStatus ?? "")) return false;
  return agentType !== "codex" || message.deliveryMode !== "follow_up" || !!message.providerQueueId;
}

export function createFollowUpQueueSlice(set: SessionSet, get: SessionGet): FollowUpQueueSlice {
  const updateSteeringMessage = (threadId: string, messageId: string, patch: Partial<PendingSteeringMessage>) =>
    setMessage(set, threadId, messageId, patch);

  const refreshCodexQueueUnlocked = async (threadId: string, restore = false): Promise<void> => {
    const result = restore
      ? await agentClient.restoreCodexFollowUps(threadId)
      : await agentClient.listCodexFollowUps(threadId);
    const active = get().pendingSteeringMessages[threadId] ?? [];
    const serverItems = result.data.map((submission, index): PendingSteeringMessage => {
      const texts = submission.input
        .filter((item): item is { type: string; text: string } =>
          !!item && typeof item === "object" && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string")
        .map((item) => item.text);
      const imagePaths = submission.input
        .filter((item): item is { type: string; path: string } =>
          !!item && typeof item === "object" && (item as { type?: unknown }).type === "localImage" && typeof (item as { path?: unknown }).path === "string")
        .map((item) => item.path);
      return {
        id: `pending-${submission.clientUserMessageId}`,
        threadId,
        content: texts.join("\n"),
        llmContent: texts.join("\n"),
        imagePaths,
        queuedAt: Date.now() + index,
        clientUserMessageId: submission.clientUserMessageId,
        providerQueueId: submission.id,
        deliveryMode: "follow_up",
        deliveryStatus: "queued",
        canDelete: true,
      };
    });
    const merged = mergeServerQueue(serverItems, active);
    set((state) => {
      const pendingSteeringMessages = { ...state.pendingSteeringMessages };
      if (merged.length) pendingSteeringMessages[threadId] = merged;
      else delete pendingSteeringMessages[threadId];
      return { pendingSteeringMessages };
    });
  };

  const hydrateCodexFollowUps = async (threadId: string): Promise<void> => {
    const existing = hydratingCodexQueues.get(threadId);
    if (existing) return existing;
    const request = (async () => {
      try {
        await refreshCodexQueueUnlocked(threadId, true);
      } catch (error) {
        logger.warn("Failed to hydrate Codex Follow-up queue", { threadId, error: String(error) });
        return;
      }
      // The Rust runtime reconciles restored queues and starts the provider
      // queue head as part of restoreCodexFollowUps.
    })();
    hydratingCodexQueues.set(threadId, request);
    try {
      await request;
    } finally {
      if (hydratingCodexQueues.get(threadId) === request) hydratingCodexQueues.delete(threadId);
    }
  };

  return {
    pendingSteeringMessages: {},
    enqueueSteeringMessage: (message) => {
      set((state) => ({
        pendingSteeringMessages: {
          ...state.pendingSteeringMessages,
          [message.threadId]: [...(state.pendingSteeringMessages[message.threadId] ?? []), message],
        },
      }));
    },
    updateSteeringMessage,
    removeSteeringMessage: (threadId, messageId) => removeMessage(set, threadId, messageId),
    removeSteeringMessageByClientId: (threadId, clientUserMessageId) => {
      const match = (get().pendingSteeringMessages[threadId] ?? [])
        .find((message) => message.clientUserMessageId === clientUserMessageId);
      if (match) removeMessage(set, threadId, match.id);
    },
    queueCodexFollowUp: async (threadId, message, clientUserMessageId, localMessageId) => {
      const result = await agentClient.queueCodexFollowUp(threadId, message, clientUserMessageId);
      updateSteeringMessage(threadId, localMessageId, {
        providerQueueId: result.queuedSubmission.id,
        deliveryStatus: "queued",
      });
      return result;
    },
    promoteFollowUpToSteer: async (threadId, messageId) => {
      const pending = get().pendingSteeringMessages[threadId]?.find((message) => message.id === messageId);
      if (!pending?.clientUserMessageId || pending.deliveryMode !== "follow_up") return;
      const type = getAgentType(get().sessionMeta.threadTypes[threadId] ?? get().sessionMeta.activeAgentTypeKey);
      if (type.key === "pi") {
        if (!canActOnQueuedMessage(pending, "pi")) return;
        await agentClient.promotePiFollowUpToSteer(threadId, pending.clientUserMessageId);
        updateSteeringMessage(threadId, messageId, { deliveryMode: "steer", deliveryStatus: "queued" });
        return;
      }
      if (type.key !== "codex" || !canActOnQueuedMessage(pending, "codex")) return;

      await refreshCodexQueueUnlocked(threadId);
      const current = get().pendingSteeringMessages[threadId]?.find((message) => message.id === messageId);
      if (!current || current.deliveryMode !== "follow_up" || !current.providerQueueId ||
        !canActOnQueuedMessage(current, "codex")) return;
      updateSteeringMessage(threadId, messageId, { deliveryStatus: "starting" });
      try {
        await agentClient.deliverCodexFollowUpNow(
          threadId,
          current.providerQueueId,
          {
            content: current.content,
            llmContent: current.llmContent,
            imagePaths: current.imagePaths,
            runId: createRunId(threadId),
            agentType: "codex",
            runtimeConfig: current.runtimeConfig ?? undefined,
          },
          current.clientUserMessageId!,
        );
        removeMessage(set, threadId, messageId);
      } catch (error) {
        const message = String(error);
        if (message.includes("Codex Follow-up was steered but")) {
          updateSteeringMessage(threadId, messageId, {
            deliveryMode: "steer",
            deliveryStatus: "cleanup_failed",
            canDelete: true,
          });
          throw error;
        }
        updateSteeringMessage(threadId, messageId, { deliveryStatus: "queued" });
        if (isCodexQueueStartConflict(error)) {
          await refreshCodexQueueUnlocked(threadId);
          const stillQueued = (get().pendingSteeringMessages[threadId] ?? [])
            .some((item) => item.providerQueueId === current.providerQueueId);
          if (!stillQueued) return;
        }
        throw error;
      }
    },
    deleteQueuedFollowUp: async (threadId, messageId) => {
      const pending = get().pendingSteeringMessages[threadId]?.find((message) => message.id === messageId);
      if (!pending?.clientUserMessageId) return;
      const type = getAgentType(get().sessionMeta.threadTypes[threadId] ?? get().sessionMeta.activeAgentTypeKey);
      if (type.key === "pi") {
        if (!canActOnQueuedMessage(pending, "pi")) return;
        await agentClient.deletePiQueuedMessage(threadId, pending.clientUserMessageId);
        removeMessage(set, threadId, messageId);
        return;
      }
      if (type.key !== "codex" || !canActOnQueuedMessage(pending, "codex")) return;
      if (pending.deliveryMode === "steer" && pending.deliveryStatus !== "cleanup_failed") return;
      const current = get().pendingSteeringMessages[threadId]?.find((message) => message.id === messageId);
      if (!current || !current.providerQueueId) return;
      await agentClient.deleteCodexFollowUp(threadId, current.providerQueueId);
      removeMessage(set, threadId, messageId);
    },
    hydrateCodexFollowUps,
    promotePiFollowUpToSteer: async (threadId, messageId) => {
      const pending = get().pendingSteeringMessages[threadId]?.find((message) => message.id === messageId);
      if (!pending?.clientUserMessageId || pending.deliveryMode !== "follow_up") return;
      await agentClient.promotePiFollowUpToSteer(threadId, pending.clientUserMessageId);
      updateSteeringMessage(threadId, messageId, { deliveryMode: "steer", deliveryStatus: "queued" });
    },
    deletePiQueuedMessage: async (threadId, messageId) => {
      const pending = get().pendingSteeringMessages[threadId]?.find((message) => message.id === messageId);
      if (!pending?.clientUserMessageId) return;
      await agentClient.deletePiQueuedMessage(threadId, pending.clientUserMessageId);
      removeMessage(set, threadId, messageId);
    },
    clearPendingSteeringMessages: (threadId) => {
      set((state) => {
        if (!state.pendingSteeringMessages[threadId]) return {};
        const pendingSteeringMessages = { ...state.pendingSteeringMessages };
        delete pendingSteeringMessages[threadId];
        return { pendingSteeringMessages };
      });
    },
  };
}
