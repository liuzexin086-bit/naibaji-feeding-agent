import type { ServerResponse } from "node:http";

export const CHAT_SSE_EVENTS = [
  "message_start",
  "delta",
  "tool_evidence",
  "message_end",
  "error",
] as const;

export type ChatSseEvent = (typeof CHAT_SSE_EVENTS)[number];

export interface ChatEventIdentity {
  messageId: string;
  clientMessageId: string;
}

export function writeChatSse(
  response: ServerResponse,
  event: ChatSseEvent,
  identity: ChatEventIdentity,
  data: Record<string, unknown> = {},
): boolean {
  if (response.writableEnded || response.destroyed) return false;
  response.write(
    `id: ${identity.messageId}\nevent: ${event}\ndata: ${JSON.stringify({
      ...identity,
      ...data,
    })}\n\n`,
  );
  return true;
}
