import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(), reload: vi.fn(async () => []), onError: vi.fn(),
}));
vi.mock("@features/agent/store/agent-client", () => ({
  agentClient: { executeDeepSeekHarnessCommand: mocks.execute },
}));
vi.mock("@features/agent/store/agent-session-store", () => ({
  useAgentSessionStore: { getState: () => ({
    sessionMeta: { settings: {} }, threadProjections: {},
    reloadMessagesFromHistory: mocks.reload,
  }) },
}));
vi.mock("@features/agent/store/agent-access-store", () => ({
  useAgentAccessStore: { getState: () => ({ config: { entries: [] } }) },
}));
vi.mock("@features/memo/store/note-store", () => ({
  useNoteStore: { getState: () => ({ selectedNotebook: null, notebooks: [] }) },
}));
vi.mock("@features/agent/runtime/agent-runtime-spec", () => ({
  buildAgentRuntimeConfig: () => ({}),
}));

import { runDshCommand } from "./dsh-command-service";

describe("DSH command acceptance", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  const input = {
    command: "/plan", ensureConversation: async () => ({ threadId: "thread-1" }),
    rejectOnFailure: true,
  };

  it("rejects explicit command errors rather than clearing the composer's snapshot", async () => {
    mocks.execute.mockResolvedValueOnce({ execution: { result: { kind: "error", text: "command rejected" } } });
    await expect(runDshCommand(input)).rejects.toThrow("command rejected");
  });

  it("propagates IPC failures to the submission coordinator", async () => {
    mocks.execute.mockRejectedValueOnce(new Error("IPC rejected"));
    await expect(runDshCommand(input)).rejects.toThrow("IPC rejected");
  });

  it("does not revoke command acceptance when only history refresh fails", async () => {
    mocks.execute.mockResolvedValueOnce({ execution: { result: { kind: "success" } } });
    mocks.reload.mockRejectedValueOnce(new Error("history unavailable"));
    await expect(runDshCommand(input)).resolves.toBeUndefined();
  });
});
