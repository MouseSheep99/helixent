import { describe, expect, test } from "bun:test";

import { buildTimelineGraph } from "../public/view/timeline.js";
import { extractImagesFromEvent } from "../public/view/images.js";
import { shouldShowTimelineEvent } from "../public/view/timeline-legacy.js";

describe("BF-2 timeline user_message support", () => {
  function userMessageEvent({
    requestId = "req-1",
    text = "hello",
    images = [] as Array<{ url: string; detail?: string }>,
  }: { requestId?: string; text?: string; images?: Array<{ url: string; detail?: string }> } = {}) {
    const content: Array<Record<string, unknown>> = [];
    for (const img of images) {
      content.push({ type: "image_url", image_url: { url: img.url, detail: img.detail } });
    }
    if (text) content.push({ type: "text", text });
    return {
      id: "evt-user-1",
      sessionId: "s",
      requestId,
      kind: "user_message",
      at: "2026-05-23T10:00:00.000Z",
      label: "User message",
      data: { role: "user", content },
    };
  }

  test("T4 extractImagesFromEvent picks up images on user_message events", () => {
    const event = userMessageEvent({
      images: [{ url: "data:image/png;base64,AAA" }, { url: "https://cdn.example.com/b.png" }],
    });
    const images = extractImagesFromEvent(event);
    expect(images).toHaveLength(2);
    expect(images[0]!.url).toBe("data:image/png;base64,AAA");
    expect(images[0]!.mimeType).toBe("image/png");
    expect(images[0]!.source).toBe("user");
    expect(images[1]!.url).toBe("https://cdn.example.com/b.png");
  });

  test("T5 buildTimelineGraph places user_message under user_input phase of its run", () => {
    const events = [
      userMessageEvent({
        requestId: "req-x",
        text: "查 helixent 的 agents.md",
      }),
    ];
    const graph: any = buildTimelineGraph(events);
    const run = graph.roots.find((node: any) => node.type === "run" && node.requestId === "req-x");
    expect(run).toBeTruthy();
    const agent = run.children.find((c: any) => c.type === "agent_execution");
    expect(agent).toBeTruthy();
    const step = agent.children.find((c: any) => c.type === "react_step");
    expect(step).toBeTruthy();
    const userPhase = step.children.find((c: any) => c.type === "user_input");
    expect(userPhase).toBeTruthy();
    expect(userPhase.children).toHaveLength(1);
    expect(userPhase.children[0].kind).toBe("user_message");
    expect(userPhase.children[0].category).toBe("user");
  });

  test("T6 user_input phase is ordered before any other phase in the same step", () => {
    // Construct a step that has both user_message and a hook_triggered (model_call phase)
    const events = [
      userMessageEvent({ requestId: "req-y", text: "ping" }),
      {
        kind: "hook_triggered",
        requestId: "req-y",
        at: "2026-05-23T10:00:01.000Z",
        label: "beforeModel",
        data: { hook: "beforeModel" },
      },
    ];
    const graph: any = buildTimelineGraph(events);
    const run = graph.roots.find((node: any) => node.type === "run" && node.requestId === "req-y");
    const step = run.children
      .find((c: any) => c.type === "agent_execution")
      .children.find((c: any) => c.type === "react_step");
    const phaseTypes = step.children.map((c: any) => c.type);
    const userIdx = phaseTypes.indexOf("user_input");
    const modelIdx = phaseTypes.indexOf("model_call");
    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeLessThan(modelIdx);
  });

  test("T7 filter visibility: 'all' / 'human' show user_message; 'tools' / 'hooks' / 'model' hide it", () => {
    const event = userMessageEvent();
    expect(shouldShowTimelineEvent(event, "all")).toBe(true);
    expect(shouldShowTimelineEvent(event, "human")).toBe(true);
    expect(shouldShowTimelineEvent(event, "tools")).toBe(false);
    expect(shouldShowTimelineEvent(event, "hooks")).toBe(false);
    expect(shouldShowTimelineEvent(event, "model")).toBe(false);
  });
});
