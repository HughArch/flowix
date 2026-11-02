import type { AgentTypeKey } from "@/types/agent";

export interface HistoryBinding {
  providerSessionId?: string;
  agentType?: AgentTypeKey;
}

export interface HistoryRequest {
  threadId: string;
  version: number;
  kind: "snapshot" | "more";
  epoch: number;
  binding: HistoryBinding;
}

interface HistoryRequestState {
  binding(threadId: string): HistoryBinding;
  epoch(threadId: string): number;
  isDeleted(threadId: string): boolean;
}

interface InitialRead {
  request: HistoryRequest;
  requestedAgentType: AgentTypeKey;
  binding: HistoryBinding;
}

/** Local request bookkeeping. None of these values is conversation state. */
export function createHistoryRequestCoordinator(state: HistoryRequestState) {
  const versions = new Map<string, number>();
  const key = (threadId: string, kind: HistoryRequest["kind"]) => JSON.stringify([threadId, kind]);
  const initialReads = new Map<string, InitialRead>();
  const codexReconciles = new Map<string, Map<string, Promise<void>>>();

  return {
    binding(threadId: string): HistoryBinding {
      return state.binding(threadId);
    },
    begin(threadId: string, kind: HistoryRequest["kind"] = "snapshot"): HistoryRequest {
      const requestKey = key(threadId, kind);
      const version = (versions.get(requestKey) ?? 0) + 1;
      versions.set(requestKey, version);
      return { threadId, kind, version, epoch: state.epoch(threadId), binding: state.binding(threadId) };
    },
    isCurrent(request: HistoryRequest): boolean {
      const binding = state.binding(request.threadId);
      return !state.isDeleted(request.threadId) &&
        versions.get(key(request.threadId, request.kind)) === request.version &&
        state.epoch(request.threadId) === request.epoch &&
        binding.providerSessionId === request.binding.providerSessionId &&
        binding.agentType === request.binding.agentType;
    },
    isLatest(request: HistoryRequest): boolean {
      return versions.get(key(request.threadId, request.kind)) === request.version;
    },
    hasInitial(threadId: string, requestedAgentType: AgentTypeKey, binding: HistoryBinding): boolean {
      const pending = initialReads.get(threadId);
      return pending?.requestedAgentType === requestedAgentType &&
        pending.binding.providerSessionId === binding.providerSessionId &&
        pending.binding.agentType === binding.agentType;
    },
    startInitial(request: HistoryRequest, requestedAgentType: AgentTypeKey, binding: HistoryBinding): void {
      initialReads.set(request.threadId, { request, requestedAgentType, binding });
    },
    finishInitial(request: HistoryRequest): boolean {
      if (initialReads.get(request.threadId)?.request !== request) return false;
      initialReads.delete(request.threadId);
      return true;
    },
    reconcileCodex(threadId: string, runId: string, execute: () => Promise<void>): Promise<void> {
      const pending = codexReconciles.get(threadId) ?? new Map<string, Promise<void>>();
      const duplicate = pending.get(runId);
      if (duplicate) return duplicate;
      const previous = [...pending.values()].pop();
      // A later run must read history after the preceding reconciliation, not
      // borrow its result or invalidate its request while it is in flight.
      const promise = previous
        ? previous.then(execute, execute)
        : execute();
      pending.set(runId, promise);
      codexReconciles.set(threadId, pending);
      void promise.finally(() => {
        pending.delete(runId);
        if (pending.size === 0) codexReconciles.delete(threadId);
      }).catch(() => undefined);
      return promise;
    },
  };
}
