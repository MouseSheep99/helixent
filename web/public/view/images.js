import { escapeAttr, formatBytes } from "./utils.js";

/**
 * Extract image view models from a single message's content[].
 *
 * @returns {Array<{ url: string, mimeType?: string, name?: string, size?: number, source: string }>}
 */
export function extractImagesFromMessage(message, source = "user") {
  if (!message || !Array.isArray(message.content)) return [];
  return collectImageURLContents(message.content, source);
}

/**
 * Extract image view models from a SSE / trace event.
 * Currently supports `input_context` (event.data.messages[].content[]),
 * `model_output_block` events whose `block` is a user image_url, and
 * `user_message` events (BF-2: timeline first-class user input entry).
 */
export function extractImagesFromEvent(event) {
  if (!event || !event.data) return [];
  const kind = event.kind;
  if (kind === "input_context") {
    const messages = Array.isArray(event.data.messages) ? event.data.messages : [];
    const out = [];
    for (const msg of messages) {
      if (!msg || !Array.isArray(msg.content)) continue;
      out.push(...collectImageURLContents(msg.content, "input_context"));
    }
    return out;
  }
  if (kind === "model_output_block") {
    const block = event.data.block;
    if (block && block.type === "image_url") {
      return collectImageURLContents([block], "trace");
    }
  }
  if (kind === "user_message") {
    const content = Array.isArray(event.data.content) ? event.data.content : [];
    return collectImageURLContents(content, "user");
  }
  return [];
}

function collectImageURLContents(contents, source) {
  const out = [];
  for (const content of contents) {
    if (!content || content.type !== "image_url" || !content.image_url) continue;
    const url = content.image_url.url || "";
    if (!url) continue;
    const parsed = parseDataUrlMeta(url);
    out.push({
      url,
      mimeType: parsed?.mimeType,
      size: parsed?.byteLength,
      source,
    });
  }
  return out;
}

function parseDataUrlMeta(url) {
  if (typeof url !== "string" || !url.startsWith("data:")) return null;
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(url);
  if (!match) return null;
  const mimeType = match[1];
  const base64Body = match[2] || "";
  const byteLength = Math.floor(base64Body.length * 0.75);
  return { mimeType, byteLength };
}

/**
 * Summarize a message for run-row title rendering.
 * Returns plain text (no images) and image count.
 */
export function summarizeMessageWithImages(message) {
  const text = collectTextFromMessage(message);
  const imageCount = extractImagesFromMessage(message).length;
  return { text, imageCount };
}

function collectTextFromMessage(message) {
  if (!message || !Array.isArray(message.content)) return "";
  const parts = [];
  for (const content of message.content) {
    if (!content) continue;
    if (content.type === "text" && content.text) parts.push(content.text);
  }
  return parts.join("\n\n").trim();
}

/**
 * Render a horizontal strip of small clickable thumbnails. All thumbnails carry
 * `data-image-url` / `data-image-group` / `data-image-index` so the global
 * lightbox click delegate can pick them up.
 */
export function renderThumbnailStrip(images, { size = 64, group = "default" } = {}) {
  if (!Array.isArray(images) || images.length === 0) return "";
  const thumbs = images
    .map((image, index) => renderThumbnail(image, { size, group, index }))
    .join("");
  return `<div class="image-thumb-strip" style="--image-thumb-size:${size}px">${thumbs}</div>`;
}

function renderThumbnail(image, { size, group, index }) {
  const url = image?.url || "";
  if (!url) return "";
  const title = [image?.name, image?.mimeType, typeof image?.size === "number" ? formatBytes(image.size) : ""]
    .filter(Boolean)
    .join(" · ");
  const alt = image?.name || image?.mimeType || "image";
  return `<button type="button" class="image-thumb" data-image-group="${escapeAttr(group)}" data-image-index="${index}" data-image-url="${escapeAttr(url)}" title="${escapeAttr(title)}" style="--image-thumb-size:${size}px"><img src="${escapeAttr(url)}" alt="${escapeAttr(alt)}" loading="lazy"></button>`;
}

/**
 * Deep-clone a value and replace any `image_url.url` data URLs with a short
 * `[image <mimeType> <size>]` placeholder. Used for timeline `<pre>` dumps so
 * raw base64 never reaches the DOM.
 */
export function sanitizeImagesForDebugDump(value) {
  return cloneAndStripDataUrls(value);
}

function cloneAndStripDataUrls(value) {
  if (Array.isArray(value)) return value.map((item) => cloneAndStripDataUrls(item));
  if (value && typeof value === "object") {
    if (isImageUrlBlock(value)) {
      return { ...value, image_url: cloneImageUrlField(value.image_url) };
    }
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = cloneAndStripDataUrls(child);
    }
    return out;
  }
  return value;
}

function isImageUrlBlock(value) {
  return value && value.type === "image_url" && value.image_url && typeof value.image_url === "object";
}

function cloneImageUrlField(imageUrl) {
  const url = typeof imageUrl.url === "string" ? imageUrl.url : "";
  const placeholder = summarizeDataUrl(url);
  return { ...imageUrl, url: placeholder ?? url };
}

function summarizeDataUrl(url) {
  const meta = parseDataUrlMeta(url);
  if (!meta) return null;
  return `[image ${meta.mimeType} ${formatBytes(meta.byteLength)}]`;
}

export { parseDataUrlMeta };
