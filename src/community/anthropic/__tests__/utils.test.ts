import { describe, expect, test } from "bun:test";

import type { Message } from "@/foundation";

import { convertToAnthropicMessages, parseImageDataUrl } from "../utils";

describe("parseImageDataUrl", () => {
  test("returns mediaType + raw base64 for png data URL", () => {
    expect(parseImageDataUrl("data:image/png;base64,iVBORw0KGgo")).toEqual({
      mediaType: "image/png",
      data: "iVBORw0KGgo",
    });
  });

  test("supports webp / jpeg / gif", () => {
    expect(parseImageDataUrl("data:image/webp;base64,UklGRg==")?.mediaType).toBe("image/webp");
    expect(parseImageDataUrl("data:image/jpeg;base64,/9j/4A")?.mediaType).toBe("image/jpeg");
    expect(parseImageDataUrl("data:image/gif;base64,R0lGODlh")?.mediaType).toBe("image/gif");
  });

  test("rejects non-image mime", () => {
    expect(parseImageDataUrl("data:application/pdf;base64,JVBER")).toBeNull();
  });

  test("rejects http/https URLs", () => {
    expect(parseImageDataUrl("https://example.com/a.png")).toBeNull();
    expect(parseImageDataUrl("http://example.com/a.jpg")).toBeNull();
  });

  test("rejects malformed strings", () => {
    expect(parseImageDataUrl("data:image/png;UTF-8;base64,abc")).toBeNull();
    expect(parseImageDataUrl("data:image/svg+xml;base64,abc")).toBeNull();
    expect(parseImageDataUrl("")).toBeNull();
  });
});

describe("convertToAnthropicMessages — image_url branch", () => {
  test("T1 https URL → source.type=url", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }],
      },
    ];
    const out = convertToAnthropicMessages(messages);
    expect(out).toEqual([
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "url", url: "https://example.com/a.png" },
          },
        ],
      },
    ]);
  });

  test("T2 png data URL → source.type=base64 (data without `data:` prefix)", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,iVBORw0KGgo" },
          },
        ],
      },
    ];
    const out = convertToAnthropicMessages(messages);
    expect(out[0]!.content).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo" },
      },
    ]);
  });

  test("T3/T4 webp / jpeg media_type are preserved", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/webp;base64,UklGRg==" } },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4A" } },
        ],
      },
    ];
    const out = convertToAnthropicMessages(messages);
    const blocks = out[0]!.content as Array<{
      type: string;
      source: { type: string; media_type?: string };
    }>;
    expect(blocks[0]!.source.media_type).toBe("image/webp");
    expect(blocks[1]!.source.media_type).toBe("image/jpeg");
  });

  test("T5 unsupported data URL (pdf) falls back to url channel", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:application/pdf;base64,JVBER" } },
        ],
      },
    ];
    const out = convertToAnthropicMessages(messages);
    expect(out[0]!.content).toEqual([
      {
        type: "image",
        source: { type: "url", url: "data:application/pdf;base64,JVBER" },
      },
    ]);
  });

  test("T6 mixed https + data URL → each lands on the correct source channel, order preserved", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "https://example.com/a.png" } },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        ],
      },
    ];
    const out = convertToAnthropicMessages(messages);
    const blocks = out[0]!.content as Array<{ source: { type: string } }>;
    expect(blocks[0]!.source.type).toBe("url");
    expect(blocks[1]!.source.type).toBe("base64");
  });

  test("T7 text + image + text mixed → order preserved", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "before" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
          { type: "text", text: "after" },
        ],
      },
    ];
    const out = convertToAnthropicMessages(messages);
    const types = (out[0]!.content as Array<{ type: string }>).map((b) => b.type);
    expect(types).toEqual(["text", "image", "text"]);
  });
});
