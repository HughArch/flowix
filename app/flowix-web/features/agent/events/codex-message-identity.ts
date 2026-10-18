/** Shared marker used when Codex omits a user item's native ID. */
export const CODEX_MISSING_USER_ITEM_ID = "flowix:codex:missing-user-item";

export function codexCommandMessageId(turnId: string): string {
  return `flowix:codex:command:${turnId}`;
}

/** Temporary identity while the provider has not attached a turn ID yet. */
export function codexPendingCommandMessageId(commandId: string): string {
  return `flowix:codex:command:pending:${commandId}`;
}

export function codexToolCallMessageId(
  turnId: string | undefined,
  callId: string,
): string {
  return `flowix:codex:tool-call:${turnId?.trim() ? turnId : "unbound"}:${callId}`;
}

export function codexCustomToolOutputMessageId(
  turnId: string | undefined,
  callId: string,
): string {
  return `flowix:codex:tool-output:${turnId?.trim() ? turnId : "unbound"}:${callId}`;
}

/**
 * Fallback for a completed provider item that has no native id. Hash UTF-8
 * bytes so Rust history projection and the browser live projection produce
 * the same value. The occurrence distinguishes repeated identical items in
 * the same turn.
 */
export function codexFallbackItemMessageId(
  turnId: string,
  role: string,
  content: string,
  occurrence: number,
): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (const byte of new TextEncoder().encode(content)) {
    first = Math.imul(first ^ byte, 0x01000193) >>> 0;
    second = Math.imul(second ^ byte, 0x85ebca6b) >>> 0;
  }
  const fingerprint = `${first.toString(16).padStart(8, "0")}${second
    .toString(16)
    .padStart(8, "0")}`;
  return `flowix:codex:item:${turnId}:${role}:${fingerprint}:${occurrence}`;
}
