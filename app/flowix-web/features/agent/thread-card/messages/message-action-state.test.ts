import { expect, it } from "vitest";
import type { ChatMessage } from "@/types";
import { createMessageActionStates } from "./message-action-state";

const row = (id: string, role: ChatMessage["role"], codexTurnId?: string): ChatMessage => ({
  id, role, codexTurnId, content: id, timestamp: "2026-01-01T00:00:00Z", isCompleted: true,
});

it("keeps completed historical actions while hiding the active native turn and its steer rows", () => {
  const messages = [row("old-user", "user", "old"), row("old-answer", "assistant", "old"),
    row("new-user", "user", "new"), row("commentary", "assistant", "new"), row("tool", "tool", "new"),
    row("steer", "user", "new"), row("final", "assistant", "new")];
  const active = createMessageActionStates(messages, true);
  expect(active.get(messages[1])).toEqual({ canFork: true, showActions: true });
  expect(active.get(messages[3])).toEqual({ canFork: false, showActions: false });
  expect(active.get(messages[6])).toEqual({ canFork: true, showActions: false });
  expect(createMessageActionStates(messages, false).get(messages[6]))
    .toEqual({ canFork: true, showActions: true });
});

it("uses the latest native turn before its user row is projected", () => {
  const messages = [row("old", "assistant", "old"), row("new", "assistant", "new")];
  const states = createMessageActionStates(messages, true);
  expect(states.get(messages[0])?.showActions).toBe(true);
  expect(states.get(messages[1])?.showActions).toBe(false);
});

it("never offers actions or a fork for an unfinished reply", () => {
  const draft = { ...row("draft", "assistant"), isCompleted: false };
  expect(createMessageActionStates([draft], false).get(draft)).toEqual({ canFork: false, showActions: false });
});

it("bounds message visits linearly for a long history", () => {
  const count = 4000;
  let visits = 0;
  const messages = new Proxy(Array.from({ length: count }, (_, index) => row(String(index), "assistant")), {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) visits += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  const states = createMessageActionStates(messages, true);
  expect(states.size).toBe(count);
  expect(visits).toBeLessThanOrEqual(count * 5);
});
