import type { CachedAgentAttachment } from "@platform/tauri/client";

export type AgentThreadCardInputAttachment = CachedAgentAttachment;

export function isAgentThreadCardImageAttachment(
  attachment: Pick<AgentThreadCardInputAttachment, "mimeType">,
): boolean {
  return attachment.mimeType.toLowerCase().startsWith("image/");
}
