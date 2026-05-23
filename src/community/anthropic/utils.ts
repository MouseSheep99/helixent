import type Anthropic from "@anthropic-ai/sdk";

import type { AssistantMessage, Message, TokenUsage, Tool } from "@/foundation";

type AnthropicImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

const IMAGE_DATA_URL_RE = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/;

/**
 * Parses an `image_url.url` of the form `data:image/<png|jpeg|gif|webp>;base64,<b64>`
 * into the (mediaType, raw base64 payload) pair Anthropic expects for `source.type=base64`.
 *
 * Returns `null` for any non-matching input (http/https URL, unsupported mime, malformed
 * base64 alphabet, etc.) so the caller can fall back to the `source.type=url` branch.
 */
export function parseImageDataUrl(
  url: string,
): { mediaType: AnthropicImageMediaType; data: string } | null {
  const match = IMAGE_DATA_URL_RE.exec(url);
  if (!match) return null;
  return { mediaType: match[1] as AnthropicImageMediaType, data: match[2]! };
}

/**
 * Extracts the system prompt from helixent messages.
 * Anthropic takes the system prompt as a separate top-level parameter
 * rather than embedding it in the messages array.
 *
 * @param messages - The helixent messages to extract the system prompt from.
 * @returns The system prompt string, or undefined if none is present.
 */
export function extractSystemPrompt(messages: Message[]): string | undefined {
  const systemMessages = messages.filter((m) => m.role === "system");
  if (systemMessages.length === 0) return undefined;
  return systemMessages
    .flatMap((m) => m.content)
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n\n");
}

/**
 * Converts helixent messages to Anthropic MessageParam messages.
 * System messages are excluded here (handled separately via extractSystemPrompt).
 *
 * @param messages - The helixent messages to convert.
 * @returns The Anthropic MessageParam messages.
 */
export function convertToAnthropicMessages(
  messages: Message[],
): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      // System messages are passed separately in Anthropic's API.
      continue;
    }

    if (message.role === "user") {
      const content: Anthropic.ContentBlockParam[] = [];
      for (const part of message.content) {
        if (part.type === "text") {
          content.push({ type: "text", text: part.text });
        } else if (part.type === "image_url") {
          // Anthropic accepts either base64 sources (with media_type) or http/https url sources.
          // Inline `data:image/<mime>;base64,<payload>` URLs are rejected by the API as
          // url sources, so we transparently convert them to base64 sources here.
          const parsed = parseImageDataUrl(part.image_url.url);
          if (parsed) {
            content.push({
              type: "image",
              source: {
                type: "base64",
                media_type: parsed.mediaType,
                data: parsed.data,
              },
            });
          } else {
            content.push({
              type: "image",
              source: {
                type: "url",
                url: part.image_url.url,
              },
            });
          }
        }
      }
      result.push({ role: "user", content });
    } else if (message.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      for (const part of message.content) {
        if (part.type === "text") {
          content.push({ type: "text", text: part.text });
        } else if (part.type === "thinking") {
          // Retrieve the preserved signature if available (set during parseAssistantMessage).
          // Anthropic requires a valid signature for thinking blocks in multi-turn conversations.
          const signature =
            (part as unknown as Record<string, unknown>)._anthropicSignature as string | undefined;
          content.push({
            type: "thinking",
            thinking: part.thinking,
            signature: signature ?? "",
          });
        } else if (part.type === "tool_use") {
          content.push({
            type: "tool_use",
            id: part.id,
            name: part.name,
            input: part.input,
          });
        }
      }
      result.push({ role: "assistant", content });
    } else if (message.role === "tool") {
      // Anthropic expects tool results as user messages with tool_result content blocks.
      const content: Anthropic.ToolResultBlockParam[] = [];
      for (const part of message.content) {
        if (part.type === "tool_result") {
          content.push({
            type: "tool_result",
            tool_use_id: part.tool_use_id,
            content: part.content,
          });
        }
      }
      result.push({ role: "user", content });
    }
  }

  return result;
}

/**
 * Parses an Anthropic API response into a helixent AssistantMessage.
 *
 * @param response - The Anthropic API response.
 * @returns The parsed helixent AssistantMessage.
 */
export function parseAssistantMessage(
  response: Anthropic.Message,
  usage?: TokenUsage,
): AssistantMessage {
  const result: AssistantMessage = {
    role: "assistant",
    content: [],
    usage,
  };

  for (const block of response.content) {
    if (block.type === "text") {
      result.content.push({ type: "text", text: block.text });
    } else if (block.type === "thinking") {
      // Preserve the signature so it can be sent back in multi-turn conversations.
      // The signature is stored as an extra runtime property on the content object.
      const thinkingContent: Record<string, unknown> = {
        type: "thinking",
        thinking: block.thinking,
      };
      if (block.signature) {
        thinkingContent._anthropicSignature = block.signature;
      }
      result.content.push(thinkingContent as { type: "thinking"; thinking: string });
    } else if (block.type === "tool_use") {
      result.content.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      });
    }
  }

  return result;
}

/**
 * Converts helixent tools to Anthropic tool definitions.
 *
 * @param tools - The helixent tools to convert.
 * @returns The Anthropic tool definitions.
 */
export function convertToAnthropicTools(tools: Tool[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters.toJSONSchema() as Anthropic.Tool["input_schema"],
  }));
}
