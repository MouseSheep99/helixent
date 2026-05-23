import type { UserMessageContent } from "@/foundation";

import { HttpError } from "./http-error";
import type { WebImageInput, WebImageMimeType } from "./types";

/** Per-image hard cap (decoded bytes). Conservative threshold derived from the
 * Anthropic Vision API documented per-request 32 MB limit (32 / 1.34 / 4 ≈ 5.97 MB).
 * Not an Anthropic-documented per-image cap on its own. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Per-message image count cap. */
export const MAX_IMAGES_PER_MESSAGE = 4;

/** Aggregate base64 payload cap across one turn. Leaves ~4 MB of headroom under
 * the documented 32 MB whole-request cap for prompt + system + tool schemas. */
export const MAX_TOTAL_BASE64_BYTES = 28 * 1024 * 1024;

const ALLOWED_MIMES: ReadonlySet<WebImageMimeType> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

function asMime(value: unknown): WebImageMimeType | null {
  return typeof value === "string" && ALLOWED_MIMES.has(value as WebImageMimeType)
    ? (value as WebImageMimeType)
    : null;
}

/**
 * Validates a `SubmitMessageBody.images` array and returns a normalized list.
 * Throws {@link HttpError} (400) on any rule violation so the HTTP route can
 * surface a useful 400 response without wrapping.
 */
export function validateWebImageInputs(
  images: readonly unknown[] | undefined,
): WebImageInput[] {
  if (!images || images.length === 0) return [];

  if (images.length > MAX_IMAGES_PER_MESSAGE) {
    throw new HttpError(`Too many images (max ${MAX_IMAGES_PER_MESSAGE}).`, 400);
  }

  const out: WebImageInput[] = [];
  let totalBase64 = 0;

  for (let i = 0; i < images.length; i += 1) {
    const raw = images[i];
    if (!raw || typeof raw !== "object") {
      throw new HttpError(`Invalid image at index ${i}.`, 400);
    }
    const item = raw as Record<string, unknown>;
    const mimeType = asMime(item.mimeType);
    if (!mimeType) {
      throw new HttpError(
        `Unsupported image mime at index ${i} (allowed: png/jpeg/gif/webp).`,
        400,
      );
    }
    const dataUrl = typeof item.dataUrl === "string" ? item.dataUrl : "";
    const expectedPrefix = `data:${mimeType};base64,`;
    if (!dataUrl.startsWith(expectedPrefix)) {
      throw new HttpError(
        `Image dataUrl at index ${i} does not match its declared mimeType.`,
        400,
      );
    }
    const base64Body = dataUrl.slice(expectedPrefix.length);
    if (base64Body.length === 0) {
      throw new HttpError(`Image dataUrl at index ${i} is empty.`, 400);
    }

    // Decoded byte estimation (base64 expands ~4/3, padding accounted for).
    const decodedBytes = Math.floor(base64Body.length * 0.75);
    const declaredSize = typeof item.size === "number" && Number.isFinite(item.size)
      ? Math.max(0, Math.floor(item.size))
      : undefined;
    const effectiveSize = declaredSize ?? decodedBytes;
    if (effectiveSize > MAX_IMAGE_BYTES) {
      throw new HttpError(
        `Image at index ${i} exceeds per-image limit (${MAX_IMAGE_BYTES} bytes).`,
        400,
      );
    }
    if (decodedBytes > MAX_IMAGE_BYTES) {
      throw new HttpError(
        `Image at index ${i} exceeds per-image limit (${MAX_IMAGE_BYTES} bytes).`,
        400,
      );
    }

    totalBase64 += dataUrl.length;
    if (totalBase64 > MAX_TOTAL_BASE64_BYTES) {
      throw new HttpError(
        `Total image payload exceeds per-request limit (${MAX_TOTAL_BASE64_BYTES} bytes).`,
        400,
      );
    }

    const detail = item.detail;
    const normalized: WebImageInput = {
      mimeType,
      dataUrl,
    };
    if (typeof item.name === "string" && item.name) normalized.name = item.name;
    if (declaredSize !== undefined) normalized.size = declaredSize;
    if (detail === "auto" || detail === "high" || detail === "low") {
      normalized.detail = detail;
    }
    out.push(normalized);
  }

  return out;
}

/**
 * Builds the multimodal `UserMessage.content` for a single user turn.
 *
 * Per Anthropic Vision best practice (image-before-text), images are emitted
 * first in declared order, followed by the text segment when non-empty.
 */
export function buildUserMessageContent(
  text: string,
  images: readonly WebImageInput[] | undefined,
): UserMessageContent {
  const content: UserMessageContent = [];
  if (images && images.length > 0) {
    for (const img of images) {
      content.push({
        type: "image_url",
        image_url: img.detail
          ? { url: img.dataUrl, detail: img.detail }
          : { url: img.dataUrl },
      });
    }
  }
  if (text) {
    content.push({ type: "text", text });
  }
  return content;
}
