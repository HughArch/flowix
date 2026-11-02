import type { ChatMessage } from "@/types";
import type { AgentTypeKey } from "@/types/agent";
import type { HistoryCoverage } from "@features/agent/store/agent-history-adapters";
export { codexHistoryConfirmsLiveTurn } from "./codex-history-reconciliation";
import { reconcileCodexHistory, type CodexHistoryWindow } from "./codex-history-reconciliation";
import {
  areMessagesEquivalent,
  reconcilePiHistory,
  mergeHistoricalMessages,
} from "@features/agent/store/thread-history";

/** Provider-neutral history contract consumed by every conversation surface. */
export interface HistorySnapshot {
  messages: ChatMessage[];
  coverage?: HistoryCoverage;
  /** Stable provider/journal revision for the current pagination traversal. */
  revision: string | null;
  oldestCursor: number | null;
  hasMore: boolean;
}

export type HistorySyncReason = "open" | "run_completed" | "recovery";

export interface ReconcileHistoryInput {
  agentType: AgentTypeKey;
  current: ChatMessage[];
  snapshot: HistorySnapshot;
  reason: HistorySyncReason;
  runId?: string | null;
  /** Codex turn owning the run; anchors the user row when ids already match. */
  turnId?: string | null;
  /** In-memory immutable projection version before the history request. */
  requestProjection?: readonly ChatMessage[];
  /** Turn-count window represented by the currently loaded Codex page. */
  currentWindow?: CodexHistoryWindow;
}

export interface ReconcileHistoryResult {
  messages: ChatMessage[];
  /** False means callers must preserve the whole projection reference. */
  renderChanged: boolean;
}

/**
 * One reconciliation engine for open/completion/recovery.
 *
 * It never exposes a clearing/loading frame. Message helpers reuse render-
 * equivalent row and array references, so a semantically identical provider
 * snapshot produces no store write and therefore no visible refresh.
 */
export function reconcileHistorySnapshot(
  input: ReconcileHistoryInput,
): ReconcileHistoryResult {
  const { agentType, current, snapshot, runId, turnId } = input;
  const historyEnd = snapshot.revision?.startsWith("sequence:")
    ? Number(snapshot.revision.slice("sequence:".length))
    : NaN;
  const historyWindow = Number.isSafeInteger(historyEnd)
    ? {
        start: snapshot.oldestCursor ?? (snapshot.hasMore ? null : 0),
        end: historyEnd,
      }
    : undefined;
  const messages = agentType === "codex"
    ? reconcileCodexHistory(
        current, snapshot.messages, snapshot.coverage, input.requestProjection,
        runId, turnId, input.currentWindow, historyWindow,
      )
    : agentType === "pi"
      ? reconcilePiHistory(snapshot.messages, current, snapshot.hasMore, input.requestProjection)
      : mergeHistoricalMessages(current, snapshot.messages, agentType);

  const renderChanged =
    messages !== current && !areMessagesEquivalent(current, messages);
  return {
    // Make the no-op contract explicit even if an adapter/helper allocated an
    // equivalent array: callers can use reference equality as the store-write
    // guard without duplicating comparison logic.
    messages: renderChanged ? messages : current,
    renderChanged,
  };
}

export function historyRevision(
  snapshotSequence: number | null | undefined,
): string | null {
  return snapshotSequence == null ? null : `sequence:${snapshotSequence}`;
}

/** Sequence-backed revisions order pagination windows. Codex uses a turn
 * count, not an item-content revision; requestProjection protects same-turn
 * updates that happen while that count stays unchanged. */
export function isOlderHistorySnapshot(
  current: number | null | undefined,
  incoming: number | null | undefined,
): boolean {
  return current != null && incoming != null && incoming < current;
}
