import { describe, expect, test } from "bun:test";

import { MODEL_PROVIDERS } from "@/cli/model-providers";

import { providerBaseURLFor, providerTypeFor, renderProviderOptions } from "../public/view.js";

describe("web model provider catalog", () => {
  test("exposes the full TUI provider catalog to the Web wizard", () => {
    const ids = MODEL_PROVIDERS.map((provider) => provider.id);

    expect(ids).toEqual([
      "anthropic",
      "openai",
      "volcengine",
      "volcengine_coding_plan",
      "qwen",
      "minimax_cn",
      "minimax_global",
      "glm",
      "kimi",
      "deepseek",
      "other",
    ]);
    expect(MODEL_PROVIDERS).toHaveLength(11);
  });

  test("maps catalog ids to the provider type persisted in config.yaml", () => {
    expect(providerTypeFor("anthropic", MODEL_PROVIDERS)).toBe("anthropic");
    expect(providerTypeFor("deepseek", MODEL_PROVIDERS)).toBe("openai");
    expect(providerBaseURLFor("volcengine_coding_plan", MODEL_PROVIDERS)).toBe("https://ark.cn-beijing.volces.com/api/coding/v3");
  });

  test("renders all provider options instead of only OpenAI and Anthropic", () => {
    const html = renderProviderOptions(MODEL_PROVIDERS);

    expect(html.match(/<option/g)?.length).toBe(MODEL_PROVIDERS.length);
    expect(html).toContain("Kimi");
    expect(html).toContain("GLM");
    expect(html).toContain("Other");
  });
});
