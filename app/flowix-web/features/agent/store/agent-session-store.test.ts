import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AGENT_SESSION_META,
  useAgentSessionStore,
} from "@features/agent/store/agent-session-store";
import { emptyProjection } from "@features/agent/store/session-reducer";
import { agentClient } from "@features/agent/store/agent-client";
import { STORAGE_KEYS } from "@/lib/constants";
import { DEFAULT_AGENT_TYPE_KEY } from "@/lib/agent-types";

const streamStart = (runId: string, threadId = "t1") => ({
  kind: "stream_start" as const,
  agentType: "deepseek-harness" as const,
  threadId,
  runId,
  timestamp: 0,
  model: "gpt-test",
});

const textDelta = (text: string, runId: string, threadId = "t1") => ({
  kind: "text_delta" as const,
  agentType: "deepseek-harness" as const,
  threadId,
  runId,
  timestamp: 1000,
  text,
  messageId: "assistant-r1",
  messagePhase: "updated" as const,
  contentMode: "delta" as const,
  sourceTimestamp: 1000,
  sourceSequence: 1,
  sourceSubsequence: 0,
});

const streamEnd = (runId: string, threadId = "t1") => ({
  kind: "stream_end" as const,
  agentType: "deepseek-harness" as const,
  threadId,
  runId,
  timestamp: 2000,
  reason: null,
});

describe("useAgentSessionStore", () => {
  beforeEach(() => {
    useAgentSessionStore.setState({
      sessionMeta: DEFAULT_AGENT_SESSION_META,
      conversationRegistry: { instances: {} },
      threadProjections: {},
      threadRunSignatures: {},
      latestCompletedRunIds: {},
      readThroughRunIds: {},
      runStateVersion: 0,
      pendingSteeringMessages: {},
    });
  });

  it("deletes a queued Pi message from the runtime before removing it locally", async () => {
    const deleteQueued = vi.spyOn(agentClient, "deletePiQueuedMessage").mockResolvedValue(undefined);
    useAgentSessionStore.setState({
      pendingSteeringMessages: {
        piThread: [{
          id: "pending-message",
          threadId: "piThread",
          content: "Please check this",
          queuedAt: 1,
          clientUserMessageId: "flowix-message",
          deliveryMode: "follow_up",
        }],
      },
    });

    await useAgentSessionStore.getState().deletePiQueuedMessage("piThread", "pending-message");

    expect(deleteQueued).toHaveBeenCalledWith("piThread", "flowix-message");
    expect(useAgentSessionStore.getState().pendingSteeringMessages.piThread).toBeUndefined();
    deleteQueued.mockRestore();
  });

  it("removes only the delivered Pi queue item and shows its own text", () => {
    const store = useAgentSessionStore.getState();
    const threadId = "pi-queued-delivery";
    store.bindThreadType(threadId, "pi");
    store.dispatch({
      kind: "stream_start", agentType: "pi", threadId, runId: "pi-run", timestamp: 1,
    });
    store.dispatch({
      kind: "user_message", agentType: "pi", threadId, runId: "pi-run", timestamp: 2,
      id: "first-user", text: "first prompt",
    });
    store.enqueueSteeringMessage({
      id: "pending-follow-up", threadId, content: "queued prompt", queuedAt: 3,
      clientUserMessageId: "flowix-follow-up", deliveryMode: "follow_up",
    });
    store.enqueueSteeringMessage({
      id: "pending-later", threadId, content: "later prompt", queuedAt: 4,
      clientUserMessageId: "flowix-later", deliveryMode: "follow_up",
    });

    store.dispatchAgentChunk({
      kind: "user_message", agent_type: "pi", thread_id: threadId, run_id: "pi-run",
      id: "native-follow-up", text: "queued prompt", timestamp: 4,
      client_user_message_id: "flowix-follow-up",
    });

    expect(useAgentSessionStore.getState().pendingSteeringMessages[threadId]
      .map((message) => message.content)).toEqual(["later prompt"]);
    expect(useAgentSessionStore.getState().threadProjections[threadId]?.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content)).toEqual(["first prompt", "queued prompt"]);
  });

  it("starts a Codex Follow-up as a tracked run and removes it from the composer queue", async () => {
    const threadId = `codex-follow-up-${Date.now()}`;
    const queueId = "queued-submission-1";
    const store = useAgentSessionStore.getState();
    store.bindThreadType(threadId, "codex");
    store.enqueueSteeringMessage({
      id: "pending-codex-follow-up",
      threadId,
      content: "Continue with the queued request",
      llmContent: "Continue with the queued request",
      queuedAt: 1,
      clientUserMessageId: "flowix-codex-follow-up",
      providerQueueId: queueId,
      deliveryMode: "follow_up",
    });
    const list = vi.spyOn(agentClient, "restoreCodexFollowUps").mockResolvedValue({
      data: [{
        id: queueId,
        clientUserMessageId: "flowix-codex-follow-up",
        input: [{ type: "text", text: "Continue with the queued request" }],
      }],
      nextCursor: null,
    });
    const start = vi.spyOn(agentClient, "deliverCodexFollowUpNow");

    await store.hydrateCodexFollowUps(threadId);

    expect(list).toHaveBeenCalledWith(threadId);
    expect(start).not.toHaveBeenCalled();
    expect(useAgentSessionStore.getState().pendingSteeringMessages[threadId]).toEqual([
      expect.objectContaining({ providerQueueId: queueId, deliveryStatus: "queued" }),
    ]);
    list.mockRestore();
    start.mockRestore();
  });

  it("preserves an optimistic Codex Follow-up while queue hydration is in flight", async () => {
    const threadId = `codex-hydrate-race-${Date.now()}`;
    const clientUserMessageId = `flowix-${threadId}`;
    let resolveList!: (value: {
      data: Array<{ id: string; clientUserMessageId: string; input: unknown[] }>;
      nextCursor: null;
    }) => void;
    const listResponse = new Promise<{
      data: Array<{ id: string; clientUserMessageId: string; input: unknown[] }>;
      nextCursor: null;
    }>((resolve) => { resolveList = resolve; });
    const list = vi.spyOn(agentClient, "listCodexFollowUps").mockReturnValue(listResponse);
    const add = vi.spyOn(agentClient, "queueCodexFollowUp").mockResolvedValue({
      queuedSubmission: { id: "queue-after-hydration", input: [], clientUserMessageId },
    });
    const store = useAgentSessionStore.getState();
    store.bindThreadType(threadId, "codex");
    store.dispatch({ kind: "stream_start", agentType: "codex", threadId, runId: "active", timestamp: 1 });
    expect(useAgentSessionStore.getState().threadProjections[threadId]?.runs.isLoading).toBe(true);
    store.enqueueSteeringMessage({
      id: `pending-${clientUserMessageId}`,
      threadId,
      content: "second prompt",
      clientUserMessageId,
      queuedAt: 2,
      deliveryMode: "follow_up",
      deliveryStatus: "submitting",
    });

    const hydration = store.hydrateCodexFollowUps(threadId);
    const queueing = store.queueCodexFollowUp(
      threadId,
      { content: "second prompt", agentType: "codex" },
      clientUserMessageId,
      `pending-${clientUserMessageId}`,
    );
    resolveList({ data: [], nextCursor: null });
    await Promise.all([hydration, queueing]);

    expect(useAgentSessionStore.getState().pendingSteeringMessages[threadId]).toEqual([
      expect.objectContaining({
        content: "second prompt",
        providerQueueId: "queue-after-hydration",
        deliveryStatus: "queued",
      }),
    ]);
    list.mockRestore();
    add.mockRestore();
  });

  it("delegates idle queue restoration to the Codex runtime", async () => {
    const threadId = `codex-idle-restore-${Date.now()}`;
    const store = useAgentSessionStore.getState();
    store.bindThreadType(threadId, "codex");
    const submission = {
      id: "restored-queue-id",
      clientUserMessageId: `flowix-${threadId}`,
      input: [{ type: "text", text: "resume this request" }],
    };
    const list = vi.spyOn(agentClient, "restoreCodexFollowUps").mockResolvedValue({
      data: [submission], nextCursor: null,
    });
    const start = vi.spyOn(agentClient, "deliverCodexFollowUpNow");

    await store.hydrateCodexFollowUps(threadId);
    expect(list).toHaveBeenCalledWith(threadId);
    expect(start).not.toHaveBeenCalled();
    expect(useAgentSessionStore.getState().pendingSteeringMessages[threadId]).toEqual([
      expect.objectContaining({ providerQueueId: submission.id }),
    ]);
    list.mockRestore();
    start.mockRestore();
  });

  it("lets Codex auto-start queued Follow-ups after the current turn ends", async () => {
    const threadId = `codex-auto-follow-up-${Date.now()}`;
    const clientUserMessageId = "auto-follow-up-client-id";
    const store = useAgentSessionStore.getState();
    store.bindThreadType(threadId, "codex");
    store.enqueueSteeringMessage({
      id: "auto-follow-up-row",
      threadId,
      content: "run this next",
      queuedAt: 2,
      clientUserMessageId,
      providerQueueId: "auto-follow-up-provider-id",
      deliveryMode: "follow_up",
      deliveryStatus: "queued",
    });
    const start = vi.spyOn(agentClient, "deliverCodexFollowUpNow");

    store.dispatch({
      kind: "stream_start", agentType: "codex", threadId, runId: "codex-current-run", timestamp: 1,
    });
    store.dispatch({
      kind: "stream_end", agentType: "codex", threadId, runId: "codex-current-run", timestamp: 3, reason: null,
    });
    await Promise.resolve();

    expect(start).not.toHaveBeenCalled();
    expect(useAgentSessionStore.getState().pendingSteeringMessages[threadId]).toHaveLength(1);

    store.dispatch({
      kind: "stream_start", agentType: "codex", threadId, runId: "codex-queued-run", timestamp: 4,
    });
    store.dispatchAgentChunk({
      kind: "user_message", agent_type: "codex", thread_id: threadId,
      run_id: "codex-queued-run", id: "provider-queued-user", text: "run this next",
      timestamp: 5, client_user_message_id: clientUserMessageId,
    });

    expect(useAgentSessionStore.getState().pendingSteeringMessages[threadId]).toBeUndefined();
    expect(useAgentSessionStore.getState().threadProjections[threadId]?.runs.isLoading).toBe(true);
    start.mockRestore();
  });

  it("hydrates Codex queue state without choosing a queue item to start", async () => {
    const threadId = `codex-stale-queue-${Date.now()}`;
    const store = useAgentSessionStore.getState();
    store.bindThreadType(threadId, "codex");
    store.enqueueSteeringMessage({
      id: "stale-local-entry",
      threadId,
      content: "already consumed elsewhere",
      queuedAt: 1,
      clientUserMessageId: "stale-client-id",
      providerQueueId: "stale-provider-id",
      deliveryMode: "follow_up",
      deliveryStatus: "queued",
    });
    const list = vi.spyOn(agentClient, "restoreCodexFollowUps").mockResolvedValue({ data: [], nextCursor: null });
    const start = vi.spyOn(agentClient, "deliverCodexFollowUpNow");

    await store.hydrateCodexFollowUps(threadId);

    expect(list).toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(useAgentSessionStore.getState().pendingSteeringMessages[threadId]).toBeUndefined();
    list.mockRestore();
    start.mockRestore();
  });

  it("silently removes a Codex Follow-up consumed between queue refresh and manual start", async () => {
    const threadId = `codex-stale-promote-${Date.now()}`;
    const queueId = "consumed-before-manual-start";
    const store = useAgentSessionStore.getState();
    store.bindThreadType(threadId, "codex");
    store.enqueueSteeringMessage({
      id: "manual-stale-entry",
      threadId,
      content: "start this follow-up",
      queuedAt: 1,
      clientUserMessageId: "manual-stale-client-id",
      providerQueueId: queueId,
      deliveryMode: "follow_up",
      deliveryStatus: "queued",
    });
    const queuedSubmission = {
      id: queueId,
      clientUserMessageId: "manual-stale-client-id",
      input: [{ type: "text", text: "start this follow-up" }],
    };
    const list = vi.spyOn(agentClient, "listCodexFollowUps")
      .mockResolvedValueOnce({ data: [queuedSubmission], nextCursor: null })
      .mockResolvedValueOnce({ data: [], nextCursor: null });
    const start = vi.spyOn(agentClient, "deliverCodexFollowUpNow")
      .mockRejectedValue(new Error(`queued submission not found: ${queueId}`));

    await expect(store.promoteFollowUpToSteer(threadId, "manual-stale-entry")).resolves.toBeUndefined();

    expect(start).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(2);
    expect(useAgentSessionStore.getState().pendingSteeringMessages[threadId]).toBeUndefined();
    list.mockRestore();
    start.mockRestore();
  });

  it("keeps accepted Codex steering visible until the matching user message arrives", async () => {
    const threadId = "codex-steering-waits-for-tool";
    const store = useAgentSessionStore.getState();
    store.bindThreadType(threadId, "codex");
    store.dispatch({ kind: "stream_start", agentType: "codex", threadId, runId: "active", timestamp: 1 });
    store.enqueueSteeringMessage({
      id: "waiting-entry", threadId, content: "next instruction", queuedAt: 2,
      clientUserMessageId: "waiting-client", providerQueueId: "waiting-provider",
      deliveryMode: "follow_up", deliveryStatus: "queued",
    });
    let finishRefresh!: (value: Awaited<ReturnType<typeof agentClient.listCodexFollowUps>>) => void;
    const list = vi.spyOn(agentClient, "listCodexFollowUps").mockImplementationOnce(() =>
      new Promise((resolve) => { finishRefresh = resolve; }));
    const deliver = vi.spyOn(agentClient, "deliverCodexFollowUpNow").mockResolvedValue(undefined);
    const promotion = store.promoteFollowUpToSteer(threadId, "waiting-entry");
    expect(useAgentSessionStore.getState().pendingSteeringMessages[threadId]?.[0].deliveryStatus).toBe("starting");
    await store.promoteFollowUpToSteer(threadId, "waiting-entry");
    expect(list).toHaveBeenCalledTimes(1);
    finishRefresh({ data: [{ id: "waiting-provider", clientUserMessageId: "waiting-client",
      input: [{ type: "text", text: "next instruction" }] }], nextCursor: null });
    await promotion;
    expect(useAgentSessionStore.getState().pendingSteeringMessages[threadId]?.[0]).toMatchObject({
      deliveryMode: "steer", deliveryStatus: "steering", canDelete: false,
    });
    await store.promoteFollowUpToSteer(threadId, "waiting-entry");
    await store.deleteQueuedFollowUp(threadId, "waiting-entry");
    expect(deliver).toHaveBeenCalledTimes(1);
    store.dispatchAgentChunk({
      kind: "user_message", agent_type: "codex", thread_id: threadId, run_id: "active",
      id: "provider-user", text: "next instruction", timestamp: 3, client_user_message_id: "waiting-client",
    });
    expect(useAgentSessionStore.getState().pendingSteeringMessages[threadId]).toBeUndefined();
    list.mockRestore();
    deliver.mockRestore();
  });

  it.each(["stream_end", "error"] as const)("clears only accepted Codex steering on %s without a correlated user event", (kind) => {
    const threadId = `codex-missing-user-${kind}`;
    const store = useAgentSessionStore.getState();
    store.bindThreadType(threadId, "codex");
    store.dispatch({ kind: "stream_start", agentType: "codex", threadId, runId: "active", timestamp: 1 });
    for (const status of ["steering", "queued", "starting", "cleanup_failed"] as const) {
      store.enqueueSteeringMessage({
        id: status, threadId, content: status, queuedAt: 2, deliveryStatus: status,
        deliveryMode: status === "steering" || status === "cleanup_failed" ? "steer" : "follow_up",
      });
    }
    const terminal = (runId: string) => kind === "stream_end"
      ? { kind, agentType: "codex" as const, threadId, runId, timestamp: 3, reason: null }
      : { kind, agentType: "codex" as const, threadId, runId, timestamp: 3, message: "failed" };
    store.dispatchAgentEvent(terminal("old"));
    expect(useAgentSessionStore.getState().pendingSteeringMessages[threadId]).toHaveLength(4);
    store.dispatchAgentEvent(terminal("active"));
    expect(useAgentSessionStore.getState().pendingSteeringMessages[threadId]?.map((item) => item.id))
      .toEqual(["queued", "starting", "cleanup_failed"]);
  });

  it("finalizes the cached turn and never inherits its identity into the next run", () => {
    const threadId = "codex-cache-turn-ownership";
    const store = useAgentSessionStore.getState();
    store.bindThreadType(threadId, "codex");
    store.dispatch({ ...streamStart("first", threadId), agentType: "codex" });
    store.dispatch({ kind: "user_message", agentType: "codex", threadId, runId: "first", timestamp: 1,
      id: "native-user", text: "prompt", codexTurnId: "turn-first" });
    store.dispatch({ ...textDelta("answer", "first", threadId), agentType: "codex", messageId: "native-answer", codexTurnId: "turn-first", sourceTimestamp: undefined, sourceSequence: undefined, sourceSubsequence: undefined, messagePhase: "completed", contentMode: "snapshot" });
    store.dispatch({ ...streamEnd("first", threadId), agentType: "codex", durationMs: 50 });
    const cached = useAgentSessionStore.getState().codexLiveTurns[threadId];
    expect(cached.status).toBe("completed");
    expect(cached.messages.find((item) => item.role === "assistant")?.isCompleted).toBe(true);
    expect(cached.messages.find((item) => item.role === "assistant")?.turnDurationMs).toBe(50);
    store.dispatch({ kind: "usage", agentType: "codex", threadId, runId: "first", timestamp: 3, usage: { input_tokens: 1, output_tokens: 1 } });
    expect(useAgentSessionStore.getState().codexLiveTurns[threadId]).toBe(cached);
    store.dispatch({ ...streamStart("second", threadId), agentType: "codex" });
    expect(useAgentSessionStore.getState().codexLiveTurns[threadId].turnId).toBeUndefined();
  });

  it("keeps provider queue order when a locally known tail has an older timestamp", async () => {
    const threadId = "provider-order-after-restore";
    const store = useAgentSessionStore.getState();
    store.bindThreadType(threadId, "codex");
    store.enqueueSteeringMessage({ id: "tail", threadId, content: "tail", queuedAt: 1,
      clientUserMessageId: "tail-client", providerQueueId: "tail-provider", deliveryMode: "follow_up", deliveryStatus: "queued" });
    const restore = vi.spyOn(agentClient, "restoreCodexFollowUps").mockResolvedValue({ data: [
      { id: "head-provider", clientUserMessageId: "head-client", input: [{ type: "text", text: "head" }] },
      { id: "tail-provider", clientUserMessageId: "tail-client", input: [{ type: "text", text: "tail" }] },
    ], nextCursor: null });
    await store.hydrateCodexFollowUps(threadId);
    expect(useAgentSessionStore.getState().pendingSteeringMessages[threadId].map((item) => item.content)).toEqual(["head", "tail"]);
    restore.mockRestore();
  });

  it("restores backend-owned accepted steering after a webview reload without resubmitting", async () => {
    const threadId = "restored-pending-steer";
    const store = useAgentSessionStore.getState();
    store.bindThreadType(threadId, "codex");
    const restore = vi.spyOn(agentClient, "restoreCodexFollowUps").mockResolvedValue({
      data: [], nextCursor: null,
      pendingDeliveries: [{ id: "client", clientUserMessageId: "client", queuedAt: 1,
        input: [{ type: "text", text: "private model context" }, { type: "localImage", path: "/tmp/image.png" }],
        content: "visible steer", deliveryStatus: "steering" }],
    });
    const deliver = vi.spyOn(agentClient, "deliverCodexFollowUpNow");
    await store.hydrateCodexFollowUps(threadId);
    expect(useAgentSessionStore.getState().pendingSteeringMessages[threadId]).toEqual([
      expect.objectContaining({ content: "visible steer", deliveryMode: "steer", deliveryStatus: "steering", canDelete: false, imagePaths: ["/tmp/image.png"] }),
    ]);
    expect(deliver).not.toHaveBeenCalled();
    restore.mockRestore(); deliver.mockRestore();
  });

  it("does not keep a restored submitting receipt after the runtime has removed it", async () => {
    const threadId = "runtime-receipt-rejected";
    const store = useAgentSessionStore.getState();
    store.bindThreadType(threadId, "codex");
    store.dispatch({ ...streamStart("active", threadId), agentType: "codex" });
    const restore = vi.spyOn(agentClient, "restoreCodexFollowUps")
      .mockResolvedValueOnce({ data: [], nextCursor: null, pendingDeliveries: [{
        id: "client", clientUserMessageId: "client", input: [{ type: "text", text: "submitting" }], queuedAt: 1, deliveryStatus: "submitting",
      }] })
      .mockResolvedValueOnce({ data: [], nextCursor: null, pendingDeliveries: [] });
    await store.hydrateCodexFollowUps(threadId);
    expect(useAgentSessionStore.getState().pendingSteeringMessages[threadId]?.[0].runtimeOwned).toBe(true);
    await store.hydrateCodexFollowUps(threadId);
    expect(useAgentSessionStore.getState().pendingSteeringMessages[threadId]).toBeUndefined();
    restore.mockRestore();
  });

  it("does not resurrect a steering receipt consumed while its snapshot was in flight", async () => {
    const threadId = "pending-steer-consumed-during-read";
    const store = useAgentSessionStore.getState();
    store.bindThreadType(threadId, "codex");
    let resolve!: (value: Awaited<ReturnType<typeof agentClient.restoreCodexFollowUps>>) => void;
    const response = new Promise<Awaited<ReturnType<typeof agentClient.restoreCodexFollowUps>>>((done) => { resolve = done; });
    const restore = vi.spyOn(agentClient, "restoreCodexFollowUps").mockReturnValue(response);
    const read = store.hydrateCodexFollowUps(threadId);
    store.removeSteeringMessageByClientId(threadId, "consumed");
    resolve({ data: [], nextCursor: null, pendingDeliveries: [{
      id: "consumed", clientUserMessageId: "consumed", input: [{ type: "text", text: "already consumed" }], queuedAt: 1, deliveryStatus: "steering",
    }] });
    await read;
    expect(useAgentSessionStore.getState().pendingSteeringMessages[threadId]).toBeUndefined();
    restore.mockRestore();
  });

  it("reconciles orphaned accepted steering from an idle Codex queue snapshot", async () => {
    const threadId = "codex-idle-orphan";
    const store = useAgentSessionStore.getState();
    store.bindThreadType(threadId, "codex");
    store.enqueueSteeringMessage({
      id: "orphan", threadId, content: "already sent", queuedAt: 1,
      clientUserMessageId: "orphan-client", deliveryMode: "steer", deliveryStatus: "steering", canDelete: false,
    });
    const restore = vi.spyOn(agentClient, "restoreCodexFollowUps").mockResolvedValue({
      data: [{ id: "next-provider", clientUserMessageId: "next-client", input: [{ type: "text", text: "next" }] }],
      nextCursor: null,
    });
    await store.hydrateCodexFollowUps(threadId);
    expect(useAgentSessionStore.getState().pendingSteeringMessages[threadId])
      .toEqual([expect.objectContaining({ content: "next", deliveryMode: "follow_up", deliveryStatus: "queued" })]);
    restore.mockRestore();
  });

  it("does not retain accepted steering when its run ends before the RPC response", async () => {
    const threadId = "codex-end-before-accept";
    const store = useAgentSessionStore.getState();
    store.bindThreadType(threadId, "codex");
    store.dispatch({ kind: "stream_start", agentType: "codex", threadId, runId: "active", timestamp: 1 });
    store.enqueueSteeringMessage({
      id: "late", threadId, content: "late response", queuedAt: 2,
      clientUserMessageId: "late-client", providerQueueId: "late-provider",
      deliveryMode: "follow_up", deliveryStatus: "queued",
    });
    const list = vi.spyOn(agentClient, "listCodexFollowUps").mockResolvedValue({
      data: [{ id: "late-provider", clientUserMessageId: "late-client", input: [{ type: "text", text: "late response" }] }],
      nextCursor: null,
    });
    const deliver = vi.spyOn(agentClient, "deliverCodexFollowUpNow").mockImplementation(async () => {
      store.dispatchAgentChunk({ kind: "stream_end", agent_type: "codex", thread_id: threadId, run_id: "active", reason: null });
      store.flushAgentEventBuffer();
    });
    await store.promoteFollowUpToSteer(threadId, "late");
    expect(useAgentSessionStore.getState().pendingSteeringMessages[threadId]).toBeUndefined();
    list.mockRestore();
    deliver.mockRestore();
  });

  it("restores a Codex follow-up when the initial promotion refresh fails", async () => {
    const threadId = "codex-promotion-refresh-error";
    const store = useAgentSessionStore.getState();
    store.bindThreadType(threadId, "codex");
    store.enqueueSteeringMessage({
      id: "retry-entry", threadId, content: "retry me", queuedAt: 1,
      clientUserMessageId: "retry-client", providerQueueId: "retry-provider",
      deliveryMode: "follow_up", deliveryStatus: "queued",
    });
    const list = vi.spyOn(agentClient, "listCodexFollowUps").mockRejectedValue(new Error("refresh failed"));
    await expect(store.promoteFollowUpToSteer(threadId, "retry-entry")).rejects.toThrow("refresh failed");
    expect(useAgentSessionStore.getState().pendingSteeringMessages[threadId]?.[0]).toMatchObject({
      deliveryMode: "follow_up", deliveryStatus: "queued",
    });
    list.mockRestore();
  });

  it("does not repeat a successful steer when queue cleanup fails, and allows cleanup retry", async () => {
    const threadId = `codex-steer-cleanup-${Date.now()}`;
    const store = useAgentSessionStore.getState();
    store.bindThreadType(threadId, "codex");
    store.dispatch({ kind: "stream_start", agentType: "codex", threadId, runId: "active", timestamp: 1 });
    expect(useAgentSessionStore.getState().threadProjections[threadId]?.runs.isLoading).toBe(true);
    store.enqueueSteeringMessage({
      id: "cleanup-entry",
      threadId,
      content: "steer exactly once",
      clientUserMessageId: "cleanup-client-id",
      providerQueueId: "cleanup-queue-id",
      queuedAt: 2,
      deliveryMode: "follow_up",
      deliveryStatus: "queued",
    });
    const deliver = vi.spyOn(agentClient, "deliverCodexFollowUpNow")
      .mockRejectedValue(new Error("Codex Follow-up was steered but queue cleanup failed: temporary delete failure"));
    const remove = vi.spyOn(agentClient, "deleteCodexFollowUp").mockResolvedValue({ deleted: true });
    const list = vi.spyOn(agentClient, "listCodexFollowUps").mockResolvedValue({
      data: [{
        id: "cleanup-queue-id",
        clientUserMessageId: "cleanup-client-id",
        input: [{ type: "text", text: "steer exactly once" }],
      }],
      nextCursor: null,
    });

    expect(useAgentSessionStore.getState().sessionMeta.threadTypes[threadId]).toBe("codex");
    expect(useAgentSessionStore.getState().pendingSteeringMessages[threadId]?.[0]).toMatchObject({
      deliveryMode: "follow_up", deliveryStatus: "queued", providerQueueId: "cleanup-queue-id",
    });
    await expect(store.promoteFollowUpToSteer(threadId, "cleanup-entry")).rejects.toThrow("temporary delete failure");
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(useAgentSessionStore.getState().pendingSteeringMessages[threadId]?.[0]).toMatchObject({
      deliveryMode: "steer",
      deliveryStatus: "cleanup_failed",
      canDelete: true,
    });

    await store.deleteQueuedFollowUp(threadId, "cleanup-entry");
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(useAgentSessionStore.getState().pendingSteeringMessages[threadId]).toBeUndefined();
    deliver.mockRestore();
    remove.mockRestore();
    list.mockRestore();
  });

  it("starts with empty projections and default meta", () => {
    const s = useAgentSessionStore.getState();
    expect(s.threadProjections).toEqual({});
    expect(s.sessionMeta.activeAgentTypeKey).toBe(DEFAULT_AGENT_TYPE_KEY);
    expect(s.conversationRegistry.instances).toEqual({});
  });

  it("dispatch(stream_start) creates a thread projection lazily", () => {
    useAgentSessionStore.getState().dispatch(streamStart("r1"));
    const proj = useAgentSessionStore.getState().threadProjections["t1"];
    expect(proj).toBeDefined();
    expect(proj?.runs.isLoading).toBe(true);
    expect(proj?.runs.activeRunId).toBe("r1");
    expect(proj?.messages).toEqual([]);
  });

  it("dispatch chain (stream_start → text_delta → stream_end) updates only one projection atomically", () => {
    const { dispatch } = useAgentSessionStore.getState();
    dispatch(streamStart("r1"));
    const afterStart = useAgentSessionStore.getState().runStateVersion;
    dispatch(textDelta("hello", "r1"));
    // Text-only projection updates must not invalidate the conversation list.
    expect(useAgentSessionStore.getState().runStateVersion).toBe(afterStart);
    dispatch(streamEnd("r1"));

    const proj = useAgentSessionStore.getState().threadProjections["t1"];
    expect(proj?.runs.isLoading).toBe(false);
    expect(proj?.runs.lastRun?.status).toBe("completed");
    expect(proj?.messages).toHaveLength(1);
    expect(useAgentSessionStore.getState().runStateVersion).toBe(afterStart + 1);
    expect(useAgentSessionStore.getState().latestCompletedRunIds).toEqual({ t1: "r1" });
    useAgentSessionStore.getState().markThreadRead("t1");
    expect(useAgentSessionStore.getState().readThroughRunIds).toEqual({ t1: "r1" });
    dispatch(streamStart("r2"));
    dispatch(streamEnd("r2"));
    expect(useAgentSessionStore.getState().latestCompletedRunIds).toEqual({ t1: "r2" });
    useAgentSessionStore.getState().markThreadRead("t1", "r1");
    expect(useAgentSessionStore.getState().readThroughRunIds).toEqual({ t1: "r1" });
    useAgentSessionStore.getState().markThreadRead("t1", "r2");
    expect(useAgentSessionStore.getState().readThroughRunIds).toEqual({ t1: "r2" });
    expect(proj?.messages[0]).toMatchObject({
      role: "assistant",
      content: "hello",
    });
  });

  it("clears pending steering messages when the active run is stopped", async () => {
    const stop = vi.spyOn(agentClient, "stopChatStream").mockResolvedValue(true);
    const store = useAgentSessionStore.getState();
    const threadId = "steer-stop-thread";

    store.bindThreadType(threadId, "deepseek-harness");
    store.dispatch(streamStart("steer-stop-run", threadId));
    store.enqueueSteeringMessage({
      id: "pending-steer-stop",
      threadId,
      content: "continue after the current step",
      queuedAt: 1,
    });

    await store.stopThreadRun(threadId, "steer-stop-run");

    expect(useAgentSessionStore.getState().pendingSteeringMessages[threadId]).toBeUndefined();
    stop.mockRestore();
  });

  it("clears pending steering messages when a run ends abnormally", () => {
    const store = useAgentSessionStore.getState();
    const threadId = "steer-error-thread";
    const runId = "steer-error-run";

    store.bindThreadType(threadId, "deepseek-harness");
    store.dispatch(streamStart(runId, threadId));
    store.enqueueSteeringMessage({
      id: "pending-steer-error",
      threadId,
      content: "this must not remain after a failed run",
      queuedAt: 1,
    });

    store.dispatchAgentChunk({
      kind: "stream_end",
      agent_type: "deepseek-harness",
      thread_id: threadId,
      run_id: runId,
      reason: "provider exited unexpectedly",
    });

    expect(useAgentSessionStore.getState().pendingSteeringMessages[threadId]).toBeUndefined();
  });

  it("does not clear steering messages for a newer active run on a delayed old end", () => {
    const store = useAgentSessionStore.getState();
    const threadId = "steer-stale-end-thread";

    store.bindThreadType(threadId, "deepseek-harness");
    store.dispatch(streamStart("steer-old-run", threadId));
    store.dispatch(streamStart("steer-new-run", threadId));
    store.enqueueSteeringMessage({
      id: "pending-steer-new",
      threadId,
      content: "keep this for the new run",
      queuedAt: 1,
    });

    store.dispatchAgentEvent({
      kind: "stream_end",
      agentType: "deepseek-harness",
      threadId,
      runId: "steer-old-run",
      timestamp: 2,
      reason: null,
    });

    expect(useAgentSessionStore.getState().pendingSteeringMessages[threadId]).toHaveLength(1);
  });

  it("keeps the completed Codex live turn available until history takes over", () => {
    const threadId = "codex-thread";
    const runId = "codex-run";
    const dispatch = useAgentSessionStore.getState().dispatch;
    const base = {
      agentType: "codex" as const,
      threadId,
      runId,
      timestamp: 0,
    };

    dispatch({ kind: "stream_start", ...base });
    dispatch({
      kind: "user_message",
      ...base,
      id: "item-user",
      text: "question",
      codexTurnId: "turn-1",
      messagePhase: "completed",
      contentMode: "snapshot",
    });
    dispatch({
      kind: "text_delta",
      ...base,
      timestamp: 1,
      messageId: "item-assistant",
      codexTurnId: "turn-1",
      text: "answer",
      messagePhase: "updated",
      contentMode: "delta",
    });
    dispatch({ kind: "stream_end", ...base, timestamp: 2, reason: null });

    const live = useAgentSessionStore.getState().codexLiveTurns[threadId];
    expect(live?.status).toBe("completed");
    expect(live?.messages.map((message) => message.id)).toEqual([
      "item-user",
      "item-assistant",
    ]);
  });

  it("dispatch is no-op for unknown event kinds (no projection churn)", () => {
    const before = useAgentSessionStore.getState();
    before.dispatch({
      kind: "session_resolved",
      agentType: "deepseek-harness",
      threadId: "t1",
      runId: "test-run",
      timestamp: 0,
      sessionId: "session-xyz",
    });
    const after = useAgentSessionStore.getState();
    expect(after.threadProjections).toBe(before.threadProjections);
  });

  it("setSessionMeta updates metadata without touching projections", () => {
    useAgentSessionStore.getState().dispatch(streamStart("r1"));
    const projBefore = useAgentSessionStore.getState().threadProjections["t1"];

    useAgentSessionStore.getState().setSessionMeta((meta) => ({
      ...meta,
      activeAgentTypeKey: "codex",
    }));

    const s = useAgentSessionStore.getState();
    expect(s.sessionMeta.activeAgentTypeKey).toBe("codex");
    // Projections ref unchanged (no churn).
    expect(s.threadProjections["t1"]).toBe(projBefore);
  });

  it("removeThreadProjection drops a thread entry", () => {
    useAgentSessionStore.getState().dispatch(streamStart("r1"));
    useAgentSessionStore.getState().dispatch(streamEnd("r1"));
    useAgentSessionStore.getState().markThreadRead("t1");
    expect(useAgentSessionStore.getState().threadProjections["t1"]).toBeDefined();
    useAgentSessionStore.getState().removeThreadProjection("t1");
    expect(useAgentSessionStore.getState().threadProjections["t1"]).toBeUndefined();
    expect(useAgentSessionStore.getState().threadRunSignatures["t1"]).toBeUndefined();
    expect(useAgentSessionStore.getState().latestCompletedRunIds["t1"]).toBeUndefined();
    expect(useAgentSessionStore.getState().readThroughRunIds["t1"]).toBeUndefined();
  });

  it("resetThreadProjections replaces specified entries with empty", () => {
    useAgentSessionStore.getState().dispatch(streamStart("r1", "t1"));
    useAgentSessionStore.getState().dispatch(streamStart("r2", "t2"));
    useAgentSessionStore.getState().dispatch(streamEnd("r1", "t1"));
    useAgentSessionStore.getState().markThreadRead("t1");
    useAgentSessionStore.getState().resetThreadProjections(["t1"]);
    const s = useAgentSessionStore.getState();
    expect(s.threadProjections["t1"]).toEqual(emptyProjection());
    expect(s.threadProjections["t2"]?.runs.isLoading).toBe(true);
    expect(s.latestCompletedRunIds["t1"]).toBeUndefined();
    expect(s.readThroughRunIds["t1"]).toBeUndefined();
  });

  it("keeps history and run writes within their projection partitions", () => {
    const store = useAgentSessionStore.getState();
    store.dispatch(streamStart("r1"));
    const before = useAgentSessionStore.getState().threadProjections.t1;
    store.updateThreadHistory("t1", (projection) => ({
      ...projection,
      messages: [{ id: "history", role: "assistant", content: "saved", timestamp: "2026-01-01T00:00:00Z" }],
      runs: emptyProjection().runs,
    }));
    const afterHistory = useAgentSessionStore.getState().threadProjections.t1;
    expect(afterHistory.runs).toBe(before.runs);
    store.updateThreadRuns("t1", () => emptyProjection().runs);
    expect(useAgentSessionStore.getState().threadProjections.t1.messages).toBe(afterHistory.messages);
  });
});

describe("useAgentSessionStore persist", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.resetModules();
  });

  it("starts with current defaults when only obsolete CHAT data exists", async () => {
    localStorage.setItem(STORAGE_KEYS.CHAT, JSON.stringify({ state: { activeAgentTypeKey: "claude" } }));
    const { useAgentSessionStore } = await import("@features/agent/store/agent-session-store");
    expect(useAgentSessionStore.getState().sessionMeta.activeAgentTypeKey).toBe(DEFAULT_AGENT_TYPE_KEY);
  });

  it("persists sessionMeta (incl. settings) and rehydrates from AGENT_SESSION", async () => {
    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    useAgentSessionStore.getState().setSessionMeta((m) => ({
      ...m,
      activeAgentTypeKey: "codex",
      activeThreadIds: { ...m.activeThreadIds, codex: "thread-x" },
      settings: { ...m.settings, agentCodexReasoningEffort: "high" },
    }));

    const stored = JSON.parse(
      localStorage.getItem(STORAGE_KEYS.AGENT_SESSION)!,
    );
    expect(stored.state.sessionMeta.activeAgentTypeKey).toBeUndefined();
    expect(stored.state.sessionMeta.settings.agentCodexReasoningEffort).toBe(
      "high",
    );
    const windowStored = JSON.parse(
      sessionStorage.getItem(`${STORAGE_KEYS.AGENT_SESSION}:window:main`)!,
    );
    expect(windowStored.state.sessionMeta.activeAgentTypeKey).toBe("codex");

    vi.resetModules();
    const { useAgentSessionStore: rehydrated } = await import(
      "@features/agent/store/agent-session-store"
    );
    const meta = rehydrated.getState().sessionMeta;
    expect(meta.activeAgentTypeKey).toBe("codex");
    expect(meta.activeThreadIds.codex).toBe("thread-x");
    expect(meta.settings.agentCodexReasoningEffort).toBe("high");
  });

  it("ignores the obsolete CHAT key when AGENT_SESSION is present", async () => {
    localStorage.setItem(
      STORAGE_KEYS.CHAT,
      JSON.stringify({ state: { activeAgentTypeKey: "claude" } }),
    );
    localStorage.setItem(
      STORAGE_KEYS.AGENT_SESSION,
      JSON.stringify({
        state: {
          sessionMeta: {
            ...DEFAULT_AGENT_SESSION_META,
            activeAgentTypeKey: "codex",
          },
        },
        version: 0,
      }),
    );

    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    expect(
      useAgentSessionStore.getState().sessionMeta.activeAgentTypeKey,
    ).toBe("codex");
  });

  it("falls back to default activeAgentTypeKey when persisted value is unselectable", async () => {
    localStorage.setItem(
      STORAGE_KEYS.AGENT_SESSION,
      JSON.stringify({
        state: {
          sessionMeta: {
            ...DEFAULT_AGENT_SESSION_META,
            activeAgentTypeKey: "bogus-type",
          },
        },
        version: 0,
      }),
    );

    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    expect(
      useAgentSessionStore.getState().sessionMeta.activeAgentTypeKey,
    ).toBe(DEFAULT_AGENT_TYPE_KEY);
  });

  it("uses DEFAULT_SESSION_META when no persisted data exists", async () => {
    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    expect(useAgentSessionStore.getState().sessionMeta).toEqual(
      DEFAULT_AGENT_SESSION_META,
    );
  });
});
