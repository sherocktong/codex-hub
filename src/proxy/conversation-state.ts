/**
 * Conversation state for the Responses API → Chat Completions translation.
 *
 * OpenAI's Responses API is stateful: a client can send `previous_response_id`
 * instead of replaying the entire conversation. Chat Completions providers are
 * stateless and require the full `messages` array on every request. This module
 * stores the upstream messages we sent for each response so follow-ups can be
 * reconstructed.
 */

interface ConversationState {
  messages: Array<Record<string, unknown>>;
  updatedAt: number;
}

// In-memory store keyed by the response id returned to Codex CLI. IDs are
// unique per provider response, so a single global map is sufficient even when
// multiple profiles are active.
const conversations = new Map<string, ConversationState>();

export function getConversationMessages(
  responseId: string,
): Array<Record<string, unknown>> | undefined {
  return conversations.get(responseId)?.messages;
}

export function setConversationMessages(
  responseId: string,
  messages: Array<Record<string, unknown>>,
): void {
  conversations.set(responseId, { messages, updatedAt: Date.now() });
}

/**
 * Merge prior conversation history with a new request's instructions and input.
 *
 * When `previous_response_id` is supplied, the new request only carries the
 * latest turn(s). Prepend the stored history so the upstream model sees the
 * full context. New `instructions` override the stored system message.
 */
export function mergeConversationHistory(
  previousResponseId: string | undefined,
  instructionsText: string | undefined,
  newMessages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const priorMessages = previousResponseId
    ? getConversationMessages(previousResponseId)
    : undefined;

  if (!priorMessages || priorMessages.length === 0) {
    return newMessages;
  }

  const merged: Array<Record<string, unknown>> = [];

  if (instructionsText) {
    merged.push({ role: "system", content: instructionsText });
  } else if (priorMessages[0]?.role === "system") {
    merged.push(priorMessages[0]);
  }

  // Append prior non-system messages.
  const startIndex = priorMessages[0]?.role === "system" ? 1 : 0;
  for (let i = startIndex; i < priorMessages.length; i++) {
    merged.push(priorMessages[i]);
  }

  // Append new messages, skipping their system message if we already placed one.
  let newStartIndex = 0;
  if (newMessages[0]?.role === "system" && merged.length > 0 && merged[0].role === "system") {
    newStartIndex = 1;
  }
  for (let i = newStartIndex; i < newMessages.length; i++) {
    merged.push(newMessages[i]);
  }

  return merged;
}
