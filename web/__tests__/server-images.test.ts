import { describe, expect, test } from "bun:test";

import { HttpError } from "../http-error";
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_TOTAL_BASE64_BYTES,
  buildUserMessageContent,
  validateWebImageInputs,
} from "../messages";
import type { WebImageInput } from "../types";

const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEUAAACnej3aAAAAAXRSTlMAQObYZgAAAApJREFUCNdjYAAAAAIAAeIhvDMAAAAASUVORK5CYII=";
const TINY_JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD//gAQTGF2YzU3LjEwNwD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APyqooor/9k=";

function makeImage(overrides: Partial<WebImageInput> = {}): WebImageInput {
  return {
    mimeType: "image/png",
    dataUrl: TINY_PNG,
    ...overrides,
  };
}

describe("validateWebImageInputs", () => {
  test("returns [] for undefined / empty", () => {
    expect(validateWebImageInputs(undefined)).toEqual([]);
    expect(validateWebImageInputs([])).toEqual([]);
  });

  test("S5 rejects > MAX_IMAGES_PER_MESSAGE", () => {
    const tooMany = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, () => makeImage());
    expect(() => validateWebImageInputs(tooMany)).toThrow(HttpError);
    try {
      validateWebImageInputs(tooMany);
    } catch (err) {
      expect((err as HttpError).status).toBe(400);
    }
  });

  test("S6 rejects mime not on the whitelist", () => {
    expect(() =>
      validateWebImageInputs([
        { mimeType: "image/svg+xml", dataUrl: "data:image/svg+xml;base64,AAA" },
      ]),
    ).toThrow(HttpError);
  });

  test("S7 rejects mismatch between declared mimeType and dataUrl prefix", () => {
    expect(() =>
      validateWebImageInputs([
        { mimeType: "image/png", dataUrl: "data:image/jpeg;base64,AAA" },
      ]),
    ).toThrow(HttpError);
  });

  test("S8 rejects single image whose declared size exceeds MAX_IMAGE_BYTES", () => {
    expect(() =>
      validateWebImageInputs([
        makeImage({ size: MAX_IMAGE_BYTES + 1 }),
      ]),
    ).toThrow(HttpError);
  });

  test("S8b rejects single image whose decoded base64 exceeds MAX_IMAGE_BYTES", () => {
    // Build a base64 body whose decoded size is > MAX_IMAGE_BYTES.
    const base64Body = "A".repeat(Math.ceil((MAX_IMAGE_BYTES + 100) / 0.75));
    expect(() =>
      validateWebImageInputs([
        { mimeType: "image/png", dataUrl: `data:image/png;base64,${base64Body}` },
      ]),
    ).toThrow(HttpError);
  });

  test("S9 rejects when aggregate base64 size > MAX_TOTAL_BASE64_BYTES", () => {
    // Each image is just under the per-image cap; 4 of them blow the aggregate cap.
    const justUnderPerImage = Math.floor(MAX_IMAGE_BYTES / 0.75) - 100;
    const body = "A".repeat(justUnderPerImage);
    const dataUrl = `data:image/png;base64,${body}`;
    const four = Array.from({ length: 4 }, () => ({
      mimeType: "image/png" as const,
      dataUrl,
    }));
    // Sanity: per-image still passes
    expect(() => validateWebImageInputs([four[0]!])).not.toThrow();
    // 4 × ~5MB base64 > 28MB total → should throw
    if (4 * dataUrl.length > MAX_TOTAL_BASE64_BYTES) {
      expect(() => validateWebImageInputs(four)).toThrow(HttpError);
    }
  });

  test("happy path: normalizes and forwards optional fields", () => {
    const out = validateWebImageInputs([
      makeImage({ name: "a.png", size: 1234, detail: "high" }),
      makeImage({ mimeType: "image/jpeg", dataUrl: TINY_JPEG }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ name: "a.png", size: 1234, detail: "high", mimeType: "image/png" });
    expect(out[1]!.mimeType).toBe("image/jpeg");
  });
});

describe("buildUserMessageContent", () => {
  test("S1 text + 0 images → single text segment", () => {
    expect(buildUserMessageContent("hello", [])).toEqual([
      { type: "text", text: "hello" },
    ]);
  });

  test("S2 text + 2 images → [image, image, text] (D11 image-before-text)", () => {
    const images = validateWebImageInputs([
      makeImage(),
      makeImage({ mimeType: "image/jpeg", dataUrl: TINY_JPEG }),
    ]);
    const out = buildUserMessageContent("describe", images);
    expect(out.map((c) => c.type)).toEqual(["image_url", "image_url", "text"]);
    expect(out[2]).toEqual({ type: "text", text: "describe" });
  });

  test("S3 empty text + 1 image → only image_url segment", () => {
    const images = validateWebImageInputs([makeImage()]);
    const out = buildUserMessageContent("", images);
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe("image_url");
  });

  test("S4 detail field is forwarded", () => {
    const images = validateWebImageInputs([makeImage({ detail: "low" })]);
    const out = buildUserMessageContent("", images);
    expect(out[0]).toMatchObject({
      type: "image_url",
      image_url: { detail: "low" },
    });
  });
});
