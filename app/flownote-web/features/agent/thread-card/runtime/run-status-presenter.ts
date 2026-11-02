import type { AgentRunState, AgentTypeKey, StatusInfo, UsageInfo } from "@/types/agent";
import type { I18nKey } from "@/lib/i18n";
import type { ThreadState } from "@features/agent/store/thread-runtime-state";
import { selectAgentThreadCardRunStatus } from "@features/agent/thread-card/agent-thread-card-selectors";

/**
 * The compact subset of runtime state required by the agent badge hover card.
 * Both an embedded ThreadState and the standalone conversation projection
 * expose this shape, so the two fullscreen conversation surfaces can render
 * the same metadata without copying the presentation rules.
 */
export interface AgentThreadCardBadgeRuntimeState {
  lastRun?: ThreadState["lastRun"];
  activeRunId: string | null;
  runs: ThreadState["runs"];
}

export interface AgentThreadCardBadgeData {
  runId: string | undefined;
  model: string | undefined;
  /** Full nested token usage breakdown — see [`UsageInfo`]. */
  usage?: UsageInfo;
  /** Provider-specific status snapshot — see [`StatusInfo`]. */
  statusInfo?: StatusInfo;
}

export function computeAgentThreadCardBadgeData(options: {
  threadState: AgentThreadCardBadgeRuntimeState | undefined;
  codexModel: string | undefined;
  typeKey: AgentTypeKey;
}): AgentThreadCardBadgeData {
  const { threadState, codexModel, typeKey } = options;
  const activeRun = threadState?.activeRunId
    ? threadState.runs[threadState.activeRunId]
    : undefined;
  const latestRun = activeRun ?? (threadState?.lastRun
    ? undefined
    : Object.values(threadState?.runs ?? {}).reduce<AgentRunState | undefined>((latest, run) =>
        !latest || run.startedAt > latest.startedAt ? run : latest,
      undefined));
  const run = activeRun ?? threadState?.lastRun ?? latestRun;
  let model = run?.modelId ?? run?.model;
  const usage = run?.usage;
  const statusInfo = run?.statusInfo;

  if (!model && typeKey === "codex" && codexModel && codexModel !== "inherit") {
    model = codexModel;
  }

  return { runId: run?.runId, model, usage, statusInfo };
}

export function renderAgentThreadCardMetaState(options: {
  dom: HTMLElement;
  metaEl: HTMLElement;
  runStatusEl: HTMLSpanElement;
  state: ThreadState | undefined;
  isCreating: boolean;
  isLoading: boolean;
  typeKey: AgentTypeKey;
  t: (key: I18nKey) => string;
}): void {
  const { dom, metaEl, runStatusEl, state, isCreating, isLoading, typeKey, t } =
    options;
  const statusView = selectAgentThreadCardRunStatus({
    state,
    isCreating,
    isLoading,
    typeKey,
  });
  const label = statusView.shouldShowStatus
    ? statusView.status === "stopping"
      ? t("editor.threadCard.stopping")
      : statusView.status === "running"
      ? t("editor.threadCard.running")
      : statusView.status === "failed"
        ? t("editor.threadCard.failed")
        : statusView.status === "cancelled"
          ? t("editor.threadCard.cancelled")
          : ""
    : "";

  dom.classList.toggle(
    "agent-thread-card--running",
    statusView.status === "running" || statusView.status === "stopping",
  );
  runStatusEl.textContent = label;
  runStatusEl.hidden = !statusView.shouldShowStatus;
  runStatusEl.className = `agent-thread-card__run-status agent-thread-card__run-status--${statusView.statusClass}`;
  if (statusView.latestRun?.runId) {
    runStatusEl.title = `Run: ${statusView.latestRun.runId}`;
  } else {
    runStatusEl.removeAttribute("title");
  }

  metaEl.replaceChildren(runStatusEl);
}
