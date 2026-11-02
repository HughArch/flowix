import { beforeEach, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({ getFeatures: vi.fn(), clearLegacyCodeMode: vi.fn(), chatStream: vi.fn() }));
vi.mock("@platform/tauri/client", () => ({ piModels: backend, agentAccess: {} }));
vi.mock("./agent-client", () => ({ agentClient: backend }));
vi.mock("@features/agent/runtime/workspace-snapshot", () => ({
  normalizeWorkspaceSnapshot: () => null,
  markConversationWorkspaceStarted: vi.fn(),
}));
vi.mock("@features/agent/runtime/conversation-workspace", () => ({ normalizeConversationWorkspaceState: () => null }));

import { dispatchChatStream } from "./chat-stream";
import { useAgentDataStore } from "./agent-data-store";

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  useAgentDataStore.setState(useAgentDataStore.getInitialState(), true);
  useAgentDataStore.setState({ legacyPreferencesMigrated: true });
  backend.clearLegacyCodeMode.mockResolvedValue(undefined);
  backend.chatStream.mockResolvedValue(undefined);
});

const input = {
  threadId: "pi-thread", content: "hello", llmContent: "hello", runId: "run",
  userPayload: { llmContent: "hello", systemReminderDirectory: "/notes" },
  agentType: "pi" as const,
};

it("waits for startup migration on first send and uses the shared mode on subsequent turns", async () => {
  let finish!: (features: { toolSearch: boolean; legacyCodeMode: boolean }) => void;
  backend.getFeatures.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const firstSend = dispatchChatStream({ ...input, runtimeConfig: { pi: { codeMode: false } } });
  expect(backend.chatStream).not.toHaveBeenCalled();
  finish({ toolSearch: false, legacyCodeMode: true });
  await firstSend;
  expect(backend.chatStream).toHaveBeenLastCalledWith("pi-thread", expect.objectContaining({
    runtimeConfig: expect.objectContaining({ pi: expect.objectContaining({ codeMode: true }) }),
  }));
  useAgentDataStore.getState().setUserPreference("pi", { mode: "writing" });
  await dispatchChatStream({ ...input, runtimeConfig: { pi: { codeMode: true } } });
  expect(backend.chatStream).toHaveBeenLastCalledWith("pi-thread", expect.objectContaining({
    runtimeConfig: expect.objectContaining({ pi: expect.objectContaining({ codeMode: false }) }),
  }));
});

it("rejects a send when migration fails instead of silently using another mode", async () => {
  backend.getFeatures.mockRejectedValueOnce(new Error("settings unavailable"));
  await expect(dispatchChatStream(input)).rejects.toThrow("settings unavailable");
  expect(backend.chatStream).not.toHaveBeenCalled();
  expect(backend.clearLegacyCodeMode).not.toHaveBeenCalled();
});
