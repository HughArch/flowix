import { expect, it } from "vitest";
import { reconcilePiTimeline } from "./pi-message-reconciliation";

it("keeps the delivered Pi prompt text when native history arrives", () => {
  const live = [{
    id: "native-user",
    messageId: "native-user",
    role: "user" as const,
    content: "queued prompt",
    timestamp: "2026-01-01T00:00:00.000Z",
  }];
  const history = [{
    ...live[0],
    content: "queued prompt\n\n<runtime-context>internal</runtime-context>",
  }];

  expect(reconcilePiTimeline(live, history, { kind: "snapshot", coverage: "full-branch" })[0].content)
    .toBe("queued prompt");
});
