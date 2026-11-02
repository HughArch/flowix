import type { AgentMessage } from "./message-render-context";

type Messages = readonly AgentMessage[];
export interface MessageActionState { canFork: boolean; showActions: boolean }

function currentTurnBoundary(messages: Messages) {
  let latestTurnId: string | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    latestTurnId ||= message.codexTurnId;
    if (message.role === "user") {
      return { userIndex: index, turnId: message.codexTurnId || latestTurnId };
    }
  }
  return { userIndex: -1, turnId: latestTurnId };
}

function belongsToCurrentTurn(message: AgentMessage, index: number, boundary: ReturnType<typeof currentTurnBoundary>): boolean {
  if (boundary.turnId && message.codexTurnId) return boundary.turnId === message.codexTurnId;
  return boundary.userIndex < 0 || index >= boundary.userIndex;
}

/** A following row ends this reply unless it starts another native/user turn. */
export function isLastMessageInTurnAndAssistant(messages: Messages, index: number): boolean {
  const message = messages[index];
  if (!message || message.role !== "assistant" || message.isCompleted === false) return false;
  const next = messages[index + 1];
  if (!next) return true;
  if (message.codexTurnId && next.codexTurnId && message.codexTurnId !== next.codexTurnId) return true;
  return next.role === "user" &&
    (!message.codexTurnId || !next.codexTurnId || message.codexTurnId !== next.codexTurnId);
}

export function isCurrentTurnMessage(message: AgentMessage, messages: Messages): boolean {
  const index = messages.indexOf(message);
  return index >= 0 && belongsToCurrentTurn(message, index, currentTurnBoundary(messages));
}

export function shouldShowMessageActions(message: AgentMessage, messages: Messages, isLoading: boolean): boolean {
  return isLastMessageInTurnAndAssistant(messages, messages.indexOf(message)) &&
    !(isLoading && isCurrentTurnMessage(message, messages));
}

/** One linear pass shared by row creation, tail patches and action syncing. */
export function createMessageActionStates(messages: Messages, isLoading: boolean): ReadonlyMap<AgentMessage, MessageActionState> {
  const boundary = currentTurnBoundary(messages);
  const states = new Map<AgentMessage, MessageActionState>();
  messages.forEach((message, index) => {
    if (states.has(message)) return;
    const canFork = isLastMessageInTurnAndAssistant(messages, index);
    states.set(message, { canFork,
      showActions: canFork && !(isLoading && belongsToCurrentTurn(message, index, boundary)),
    });
  });
  return states;
}
