import { agent, deepseekHarness } from "@platform/tauri/client";
import type { AgentTypeKey } from "@/types/agent";
import type { BadgeHoverCardRuntimeInfo } from "./use-badge-runtime-info";

/**
 * 按 agent 类型构造 BadgeHoverCard 的 runtime info 懒加载请求器。
 *
 * - threadId/sessionId 统一在调用时重新读取, 避免闭包捕获陈旧值;
 * - threadId 为空时直接返回 null, 不向后台发 invoke;
 * - 未适配的 agent 类型返回 undefined, 与组件"无懒加载"语义一致。
 */
export function createRuntimeInfoRequester(
  typeKey: AgentTypeKey,
  getThreadId: () => string | null | undefined,
  getSessionId: () => string | null | undefined = () => undefined,
): (() => Promise<BadgeHoverCardRuntimeInfo | null>) | undefined {
  switch (typeKey) {
    case "pi":
      return async () => {
        const threadId = getThreadId();
        if (!threadId) return null;
        // Pi run metadata lives in its native conversation history. Read the
        // latest complete turn so the popup can recover model and usage after
        // the in-memory run projection has been cleared by a reload.
        const page = await agent.getPiSessionPage(threadId, null, 1);
        const latestAssistant = [...page.messages].reverse().find(
          (message) => message.role === "assistant",
        );
        const nativeUsage = latestAssistant?.usage;
        const usage = nativeUsage && typeof nativeUsage === "object"
          ? nativeUsage as Record<string, unknown>
          : {};
        const numeric = (value: unknown) =>
          typeof value === "number" && Number.isFinite(value) ? value : undefined;
        const inputTokens = numeric(usage.input);
        const cachedInputTokens = numeric(usage.cacheRead);
        const outputTokens = numeric(usage.output);
        const totalTokens = numeric(usage.totalTokens) ?? (
          [inputTokens, cachedInputTokens, numeric(usage.cacheWrite), outputTokens]
            .some((value) => value !== undefined)
            ? (inputTokens ?? 0) + (cachedInputTokens ?? 0)
              + (numeric(usage.cacheWrite) ?? 0) + (outputTokens ?? 0)
            : undefined
        );
        const candidateSessionId = getSessionId();
        const sessionId = page.revision.sessionId || (
          candidateSessionId && candidateSessionId !== threadId
            ? candidateSessionId
            : await agent.getPiSessionId(threadId)
        );
        return {
          sessionId: sessionId ?? undefined,
          model: typeof latestAssistant?.model === "string"
            ? typeof latestAssistant.provider === "string"
              ? `${latestAssistant.provider}/${latestAssistant.model}`
              : latestAssistant.model
            : undefined,
          usage: {
            input_tokens: inputTokens,
            cached_input_tokens: cachedInputTokens,
            output_tokens: outputTokens,
            total_tokens: totalTokens,
          },
        };
      };
    case "deepseek-harness":
      return async () => {
        const threadId = getThreadId();
        if (!threadId) return null;
        const [sessionId, usage] = await Promise.all([
          agent.getDeepSeekHarnessSessionId(threadId),
          deepseekHarness.sessionUsage(threadId),
        ]);
        return usage
          ? { ...usage, sessionId: sessionId ?? undefined }
          : { sessionId: sessionId ?? undefined, usage: {} };
      };
    case "opencode":
      return async () => {
        const threadId = getThreadId();
        if (!threadId) return null;
        return {
          sessionId: getSessionId() ?? undefined,
          usage: {},
        };
      };
    case "codex":
      return async () => {
        const threadId = getThreadId();
        // Account and rate-limit data are global Codex runtime metadata and
        // are available before a conversation has created a provider
        // session. Only per-thread usage needs a session id.
        const candidateSessionId = getSessionId();
        const knownSessionId = candidateSessionId && candidateSessionId !== threadId
          ? candidateSessionId
          : null;
        const sessionId = knownSessionId ?? (threadId
          ? await agent.getCodexSessionId(threadId)
          : null);
        const info = await agent.getCodexRuntimeInfo(sessionId);
        return {
          sessionId: sessionId ?? undefined,
          usage: info.usage ?? {},
          codex: info,
        };
      };
    default:
      return undefined;
  }
}
