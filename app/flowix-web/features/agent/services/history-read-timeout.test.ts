import { afterEach, expect, it, vi } from "vitest";
import { HISTORY_READ_TIMEOUT_MS, HistoryReadTimeoutError, readHistoryWithTimeout } from "./history-read-timeout";

afterEach(() => vi.useRealTimers());

it("clears the deadline when a read succeeds or rejects", async () => {
  vi.useFakeTimers();
  await expect(readHistoryWithTimeout(async () => "ready")).resolves.toBe("ready");
  expect(vi.getTimerCount()).toBe(0);
  await expect(readHistoryWithTimeout(async () => { throw new Error("offline"); })).rejects.toThrow("offline");
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects a hung read and never adopts its late response", async () => {
  vi.useFakeTimers();
  let release!: (value: string) => void;
  const adopt = vi.fn();
  const read = readHistoryWithTimeout(() => new Promise<string>((resolve) => { release = resolve; })).then(adopt);
  const timedOut = expect(read).rejects.toBeInstanceOf(HistoryReadTimeoutError);
  await vi.advanceTimersByTimeAsync(HISTORY_READ_TIMEOUT_MS);
  await timedOut;
  release("late");
  await vi.advanceTimersByTimeAsync(0);
  expect(adopt).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  await expect(readHistoryWithTimeout(async () => "retry")).resolves.toBe("retry");
});
