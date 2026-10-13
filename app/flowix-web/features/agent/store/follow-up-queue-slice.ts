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
  /** A restored receipt is advanced by the runtime, not a webview RPC. */
  runtimeOwned?: boolean;
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
  isWorking: boolean,
): PendingSteeringMessage[] {
  const result = [...serverItems];
  for (const local of localItems) {
    const index = result.findIndex((item) => item.clientUserMessageId === local.clientUserMessageId);
    const isOperationInFlight = !local.runtimeOwned && (
      local.deliveryStatus === "submitting" ||
      local.deliveryStatus === "starting" ||
      local.deliveryStatus === "steering" ||
      local.deliveryStatus === "cleanup_failed" ||
      local.deliveryMode === "steer");
    if (index >= 0) {
      result[index] = {
        ...result[index],
        id: local.id,
        providerQueueId: result[index].providerQueueId ?? local.providerQueueId,
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
    } else if (isOperationInFlight && !(local.deliveryStatus === "steering" && !isWorking)) {
      // Preserve optimistic submissions and steering/cleanup operations that
      // have not reached a stable server snapshot yet.
      result.push(local);
    }
  }
  // Server queue order is authoritative. Local receipt timestamps must not
  // move a known queue tail ahead of an earlier item restored from the server.
  return result;
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

  // Receipts consumed while a snapshot RPC is in flight must not reappear.
  const queueReads = new Map<string, Set<string>[]>();

  const refreshCodexQueueUnlocked = async (threadId: string, restore = false): Promise<void> => {
    const consumed = new Set<string>();
    const reads = queueReads.get(threadId) ?? [];
    reads.push(consumed); queueReads.set(threadId, reads);
    try {
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
      for (const receipt of [...(result.pendingDeliveries ?? [])].reverse()) {
        if (receipt.runId && get().threadProjections[threadId]?.runs.lastRun?.runId === receipt.runId) continue;
        const queuedIndex = serverItems.findIndex((item) => item.clientUserMessageId === receipt.clientUserMessageId);
        const providerQueueId = queuedIndex >= 0 ? serverItems[queuedIndex].providerQueueId : undefined;
        if (queuedIndex >= 0) serverItems.splice(queuedIndex, 1);
        const text = receipt.input.filter((item): item is { type: "text"; text: string } =>
          !!item && typeof item === "object" && (item as { type?: unknown }).type === "text")
          .map((item) => item.text).join("\n");
        serverItems.unshift({
          id: `pending-${receipt.clientUserMessageId}`, threadId,
          clientUserMessageId: receipt.clientUserMessageId, providerQueueId,
          content: receipt.content ?? text, llmContent: text,
          imagePaths: receipt.input.filter((item): item is { type: "localImage"; path: string } =>
            !!item && typeof item === "object" && (item as { type?: unknown }).type === "localImage")
            .map((item) => item.path),
          queuedAt: receipt.queuedAt, deliveryMode: "steer", deliveryStatus: receipt.deliveryStatus, canDelete: false, runtimeOwned: true,
        });
      }
      const merged = mergeServerQueue(serverItems.filter((item) => !consumed.has(item.clientUserMessageId ?? "")), active,
        isProjectionWorking(get().threadProjections[threadId]));
      set((state) => {
        const pendingSteeringMessages = { ...state.pendingSteeringMessages };
        if (merged.length) pendingSteeringMessages[threadId] = merged;
        else delete pendingSteeringMessages[threadId];
        return { pendingSteeringMessages };
      });
    } finally {
      const remaining = (queueReads.get(threadId) ?? []).filter((read) => read !== consumed);
      if (remaining.length) queueReads.set(threadId, remaining);
      else queueReads.delete(threadId);
    }
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
      for (const read of queueReads.get(threadId) ?? []) read.add(clientUserMessageId);
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

      // Lock immediately, including the queue refresh, so the UI can show
      // pending delivery and repeated clicks cannot submit the same item.
      updateSteeringMessage(threadId, messageId, { deliveryStatus: "starting" });
      let current = pending;
      try {
        await refreshCodexQueueUnlocked(threadId);
        const refreshed = get().pendingSteeringMessages[threadId]?.find((message) => message.id === messageId);
        if (!refreshed || refreshed.deliveryMode !== "follow_up" || !refreshed.providerQueueId) return;
        current = refreshed;
        await agentClient.deliverCodexFollowUpNow(
          threadId,
          refreshed.providerQueueId,
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
        // RPC acceptance can precede actual delivery at the next tool boundary.
        // The matching user_message event removes the row when Codex consumes it.
        if (isProjectionWorking(get().threadProjections[threadId])) {
          updateSteeringMessage(threadId, messageId, {
            deliveryMode: "steer", deliveryStatus: "steering", canDelete: false,
          });
        } else {
          // The run may have ended before the RPC returned, without a
          // correlated user message. Acceptance must not leave an orphan row.
          removeMessage(set, threadId, messageId);
        }
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
