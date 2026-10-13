import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/types";
import { reconcileCodexHistory, codexHistoryConfirmsLiveTurn } from "./codex-history-reconciliation";

const row = (id: string, role: ChatMessage["role"], turn = "t1", content = id): ChatMessage => ({
  id, role, codexTurnId: turn, content, timestamp: "2026-01-01T00:00:00Z",
});
const complete = { kind: "complete-turns" as const, turnIds: ["t1"] };

describe("Codex turn reconciliation", () => {
  it("replaces all rows of a steered turn while retaining older pages and the next run", () => {
    const prefix = row("prefix", "user", "older");
    const user = row("u1", "user");
    const commentary = { ...row("native-a", "assistant", "t1", "commentary"), messageId: "native-a", isCompleted: true };
    const steer = row("steer", "user");
    const final = { ...row("native-b", "assistant", "t1", "answer"), messageId: "native-b", isCompleted: true };
    const next = row("next", "user", "t2");
    const current = [prefix, user, commentary, steer, final, next];
    const persisted = [user, { ...commentary }, steer, { ...final }];
    const result = reconcileCodexHistory(current, persisted, complete, current);
    expect(result.map((item) => item.id)).toEqual(["prefix", "u1", "native-a", "steer", "native-b", "next"]);
    expect(result[0]).toBe(prefix);
    expect(result[result.length - 1]).toBe(next);
    expect(reconcileCodexHistory(result, persisted, complete, result)).toBe(result);
  });

  it("preserves a distinct draft when history cannot prove it is the same output", () => {
    const user = row("u", "user");
    const draft = { ...row("assistant-123-1", "assistant", "t1", "partial"), isCompleted: true };
    const final = { ...row("native", "assistant", "t1", "finished"), messageId: "native", isCompleted: true };
    const current = [user, draft, final];
    const history = [user, { ...final }];
    expect(reconcileCodexHistory(current, history, complete, current).map((item) => item.id)).toEqual(["u", draft.id, "native"]);
    expect(codexHistoryConfirmsLiveTurn(history, current, "t1", complete)).toBe(false);
    expect(codexHistoryConfirmsLiveTurn([user], current, "t1", complete)).toBe(false);
  });

  it("does not replace a completed live tool result with an unfinished history item", () => {
    const user = row("u", "user");
    const liveTool = {
      ...row("call-1", "tool", "t1", "completed output"),
      messageId: "call-1",
      toolCallId: "call-1",
      isLoading: false,
    };
    const historyTool = {
      ...row("call-1", "tool", "t1", ""),
      toolCallId: "call-1",
      isCompleted: false,
    };
    const current = [user, liveTool];
    const result = reconcileCodexHistory(current, [user, historyTool], complete, current);
    expect(result[1]).toBe(liveTool);
    expect(codexHistoryConfirmsLiveTurn([user, historyTool], current, "t1", complete)).toBe(false);
  });

  it("keeps loaded pages before newly materialized turns at the start of the latest page", () => {
    const prefix = row("prefix", "user", "older");
    const user = row("u", "user");
    const current = [prefix, user];
    const result = reconcileCodexHistory(current, [row("between", "user", "between"), user], complete, current);
    expect(result.map((item) => item.id)).toEqual(["prefix", "between", "u"]);
  });

  it("orders disjoint history pages by their native turn-count boundaries", () => {
    const old = [row("old-u", "user", "old"), row("old-a", "assistant", "old")];
    const latest = [row("new-u", "user", "new"), row("new-a", "assistant", "new")];
    const result = reconcileCodexHistory(
      old, latest, { kind: "partial" }, old, undefined, undefined,
      { start: 0, end: 5 }, { start: 5, end: 10 },
    );
    expect(result.map((item) => item.id)).toEqual(["old-u", "old-a", "new-u", "new-a"]);
  });

  it("allows an old turn to converge while the next turn changes during the read", () => {
    const user = row("u", "user");
    const draft = { ...row("native", "assistant", "t1", "answer"), messageId: "native", isCompleted: true };
    const next = row("next", "assistant", "t2", "partial");
    const updated = { ...next, content: "newer" };
    const current = [user, draft, updated];
    const result = reconcileCodexHistory(current, [user, { ...draft }], complete, [user, draft, next]);
    expect(result.map((item) => item.id)).toEqual(["u", "native", "next"]);
    expect(result[2]).toBe(updated);
  });

  it("protects same-turn output from a stale terminal response with the same turn count", () => {
    const user = row("u", "user");
    const draft = { ...row("a", "assistant"), messageId: "a", content: "partial" };
    const final = { ...draft, content: "finished", isCompleted: true };
    const result = reconcileCodexHistory([user, final], [user, draft], complete, [user, draft]);
    expect(result[1]).toBe(final);
  });

  it("retains a missing completed native item even when another assistant is present", () => {
    const user = row("u", "user");
    const answer = { ...row("a", "assistant"), messageId: "a", isCompleted: true };
    const history = [user, row("other", "assistant")];
    const current = [user, answer];
    const result = reconcileCodexHistory(current, history, complete, current);
    expect(result).toContain(answer);
    expect(codexHistoryConfirmsLiveTurn(history, current, "t1", complete)).toBe(false);
  });

  it("places live-only items inside their turn before the next known item", () => {
    const user = row("u", "user");
    const tool = { ...row("tool", "tool"), codexTurnId: undefined, toolCallId: "call" };
    const answer = row("a", "assistant");
    const next = row("next", "user", "t2");
    const current = [user, tool, answer, next];
    const result = reconcileCodexHistory(current, [user, answer, next], { kind: "partial" });
    expect(result.map((item) => item.id)).toEqual(["u", "tool", "a", "next"]);
  });

  it("does not erase application command/error rows or merge equal text across turns", () => {
    const user = row("u", "user");
    const answer = { ...row("a", "assistant", "t1", "same"), isCompleted: true };
    const command = { ...row("command", "system"), messageType: "codex-command" as const };
    const next = row("next", "assistant", "t2", "same");
    const current = [user, command, answer, next];
    const result = reconcileCodexHistory(current, [user, { ...answer }], complete, current);
    expect(result.map((item) => item.id)).toEqual(["u", "command", "a", "next"]);
  });

  it("reuses a large loaded prefix and the array for an equivalent latest-page snapshot", () => {
    const current: ChatMessage[] = [];
    for (let turn = 0; turn < 2000; turn += 1) {
      for (let item = 0; item < 5; item += 1) {
        const id = `turn-${turn}-item-${item}`;
        current.push({ ...row(id, item === 0 ? "user" : "assistant", `turn-${turn}`), messageId: id, isCompleted: true });
      }
    }
    const history = current.slice(-50).map((item) => ({ ...item }));
    const coverage = { kind: "complete-turns" as const, turnIds: Array.from({ length: 10 }, (_, index) => `turn-${1990 + index}`) };
    expect(reconcileCodexHistory(current, history, coverage, current)).toBe(current);
  });

  it("releases a materialized turn cache using turn identity, including legacy draft ids", () => {
    const user = row("u", "user");
    const answer = { ...row("draft", "assistant", "t1", "answer"), isCompleted: true };
    const history = [user, { ...answer, id: "native" }];
    expect(codexHistoryConfirmsLiveTurn(history, [user, answer], "t1", complete)).toBe(true);
    expect(codexHistoryConfirmsLiveTurn([user], [user, answer], "t1", complete)).toBe(false);
    expect(codexHistoryConfirmsLiveTurn(history, [user, answer], "t1", { kind: "partial" })).toBe(false);
  });
});
