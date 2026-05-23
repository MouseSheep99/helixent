import { describe, expect, test } from "bun:test";

import {
  extractImagesFromMessage,
  extractImagesFromEvent,
  renderThumbnailStrip,
  sanitizeImagesForDebugDump,
  summarizeMessageWithImages,
} from "../public/view/images.js";

describe("frontend image view helpers", () => {
  test("I1 extracts images from a user message with text + image_url segments", () => {
    const message = {
      role: "user",
      content: [
        { type: "text", text: "hi" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        { type: "image_url", image_url: { url: "https://cdn.example.com/a.png" } },
      ],
    };
    const images = extractImagesFromMessage(message);
    expect(images).toHaveLength(2);
    expect(images[0]!.url).toBe("data:image/png;base64,AAA");
    expect(images[0]!.mimeType).toBe("image/png");
    expect(images[0]!.source).toBe("user");
    expect(images[1]!.url).toBe("https://cdn.example.com/a.png");
    expect(images[1]!.mimeType).toBeUndefined();
  });

  test("I2 returns [] for assistant messages without images", () => {
    expect(
      extractImagesFromMessage({
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
      }),
    ).toEqual([]);
    expect(extractImagesFromMessage(null)).toEqual([]);
    expect(extractImagesFromMessage({ role: "user" })).toEqual([]);
  });

  test("I3 extracts images from input_context events", () => {
    const event = {
      kind: "input_context",
      data: {
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/AAA" } }],
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "noop" }],
          },
        ],
      },
    };
    const images = extractImagesFromEvent(event);
    expect(images).toHaveLength(1);
    expect(images[0]!.source).toBe("input_context");
    expect(images[0]!.mimeType).toBe("image/jpeg");
  });

  test("I4 summarizes message text and image count", () => {
    const summary = summarizeMessageWithImages({
      role: "user",
      content: [
        { type: "text", text: "hi" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        { type: "image_url", image_url: { url: "data:image/png;base64,BBB" } },
        { type: "image_url", image_url: { url: "data:image/png;base64,CCC" } },
      ],
    });
    expect(summary).toEqual({ text: "hi", imageCount: 3 });
  });

  test("I5 summarizes empty-text message with images", () => {
    const summary = summarizeMessageWithImages({
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        { type: "image_url", image_url: { url: "data:image/png;base64,BBB" } },
      ],
    });
    expect(summary).toEqual({ text: "", imageCount: 2 });
  });

  test("I6 sanitizes nested image_url data URLs into placeholder", () => {
    const value = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "x" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ],
    };
    const cloned = sanitizeImagesForDebugDump(value);
    // Original untouched
    expect(value.messages[0]!.content[1]!.image_url!.url).toBe("data:image/png;base64,AAAA");
    // Clone replaced
    const sanitizedUrl = cloned.messages[0].content[1].image_url.url;
    expect(sanitizedUrl).toContain("[image image/png");
    expect(sanitizedUrl).not.toContain("AAAA");
  });

  test("I7 sanitize leaves https URLs untouched", () => {
    const value = {
      content: [{ type: "image_url", image_url: { url: "https://cdn.example.com/a.png" } }],
    };
    const cloned = sanitizeImagesForDebugDump(value);
    expect(cloned.content[0].image_url.url).toBe("https://cdn.example.com/a.png");
  });

  test("I8 renders thumbnail strip with data attributes per image", () => {
    const html = renderThumbnailStrip(
      [
        { url: "data:image/png;base64,AAA", mimeType: "image/png" },
        { url: "data:image/png;base64,BBB", mimeType: "image/png" },
      ],
      { size: 64, group: "g" },
    );
    expect(html).toContain('class="image-thumb-strip"');
    expect(html).toContain('data-image-group="g"');
    expect(html).toContain('data-image-index="0"');
    expect(html).toContain('data-image-index="1"');
    expect(html).toContain('data-image-url="data:image/png;base64,AAA"');
    expect(html).toContain('data-image-url="data:image/png;base64,BBB"');
  });

  test("renderThumbnailStrip returns empty string for empty inputs", () => {
    expect(renderThumbnailStrip([])).toBe("");
    expect(renderThumbnailStrip(null)).toBe("");
  });
});
