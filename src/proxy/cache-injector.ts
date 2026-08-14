import type { RequestContext } from "./types.js";
import { injectPromptCacheKey } from "./cache-key.js";
import * as logger from "../logger.js";

interface ContentBlock {
  type?: string;
  text?: string;
  cache_control?: Record<string, string>;
  [key: string]: unknown;
}

interface ChatMessage {
  role?: string;
  content?: string | ContentBlock[];
  cache_control?: Record<string, string>;
  [key: string]: unknown;
}

const MAX_CACHE_MARKERS = 4;

/**
 * Dispatch prompt-cache enrichment by provider type.
 *
 * - Qianwen (Alibaba DashScope) uses Anthropic-style `cache_control` markers
 *   inside message content blocks for explicit context caching.
 * - Other providers (e.g., Kimi) continue to use OpenAI Responses API
 *   `prompt_cache_key` routing.
 */
export function injectCacheRouting(
  body: Record<string, unknown>,
  ctx: RequestContext,
): void {
  if (ctx.provider.type === "qianwen") {
    injectQwenCacheMarkers(body);
  } else {
    injectPromptCacheKey(body, ctx);
  }
}

function injectQwenCacheMarkers(body: Record<string, unknown>): void {
  const rawMessages = body.messages as ChatMessage[] | undefined;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return;
  }

  // Work on a shallow copy so we do not mutate the caller's message objects.
  const messages = rawMessages.map((message) => ({
    ...message,
    content: cloneContent(message.content),
  }));
  body.messages = messages;

  const existingMarkers = countExistingCacheControls(messages);
  if (existingMarkers >= MAX_CACHE_MARKERS) {
    logger.debug(`qianwen cache: ${existingMarkers} existing markers, skipping injection`);
    return;
  }
  let remaining = MAX_CACHE_MARKERS - existingMarkers;
  const markersBeforeInjection = remaining;

  // 1. Cache the system prompt if present. It is the most reusable prefix.
  const systemIndex = messages.findIndex(
    (m) => m.role === "system" || m.role === "developer",
  );
  if (systemIndex !== -1 && !hasCacheControl(messages[systemIndex])) {
    if (markMessage(messages[systemIndex])) {
      remaining--;
    }
  }

  if (remaining <= 0) {
    logger.debug(
      `qianwen cache: injected ${markersBeforeInjection - remaining} new markers`,
    );
    return;
  }

  // 2. Mark the end of the reusable prefix: the last message before the final
  //    user message. In a multi-turn chat this caches all prior turns.
  const lastUserIndex = findLastUserIndex(messages);
  if (lastUserIndex > 0) {
    const prefixMessage = messages[lastUserIndex - 1];
    if (!hasCacheControl(prefixMessage)) {
      if (markMessage(prefixMessage)) {
        remaining--;
      }
    }
  } else if (systemIndex === -1 && messages.length > 0) {
    // No system prompt and only one user message; mark that user message.
    const firstMessage = messages[0];
    if (!hasCacheControl(firstMessage)) {
      markMessage(firstMessage);
    }
  }

  logger.debug(
    `qianwen cache: injected ${markersBeforeInjection - remaining} new markers`,
  );
}

function cloneContent(content: unknown): unknown {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((block) =>
      block && typeof block === "object" ? { ...(block as Record<string, unknown>) } : block,
    );
  }
  return content;
}

function findLastUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return i;
    }
  }
  return -1;
}

function hasCacheControl(message: ChatMessage | undefined): boolean {
  if (!message) return false;
  if (message.cache_control) return true;
  const content = message.content;
  if (Array.isArray(content)) {
    return content.some(
      (block) => block && typeof block === "object" && block.cache_control,
    );
  }
  return false;
}

function markMessage(message: ChatMessage): boolean {
  const content = message.content;
  if (typeof content === "string") {
    message.content = [
      { type: "text", text: content, cache_control: { type: "ephemeral" } },
    ];
    return true;
  }

  if (Array.isArray(content)) {
    // Place the marker on the last text block so the entire message prefix is
    // included in the cached window.
    for (let i = content.length - 1; i >= 0; i--) {
      const block = content[i];
      if (block && typeof block === "object" && block.type === "text") {
        block.cache_control = { type: "ephemeral" };
        return true;
      }
    }
  }

  return false;
}

export function countExistingCacheControls(body: Record<string, unknown>): number {
  const messages = body.messages as ChatMessage[] | undefined;
  if (!Array.isArray(messages)) return 0;
  return countCacheControlsInMessages(messages);
}

function countCacheControlsInMessages(messages: ChatMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (message.cache_control) {
      count++;
      continue;
    }
    const content = message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && block.cache_control) {
          count++;
          break;
        }
      }
    }
  }
  return count;
}
