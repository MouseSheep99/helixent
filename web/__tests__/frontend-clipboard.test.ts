import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// Minimal DOM stub: state.js calls document.getElementById at import time.
type StubElement = {
  textContent: string;
  value: string;
  attrs: Record<string, string>;
  style: Record<string, string>;
  parent: StubElement | null;
  children: StubElement[];
  setAttribute: (name: string, value: string) => void;
  select: () => void;
  remove: () => void;
  click: () => void;
};

function makeEl(): StubElement {
  const el: StubElement = {
    textContent: "",
    value: "",
    attrs: {},
    style: {},
    parent: null,
    children: [],
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    select() {
      /* noop */
    },
    remove() {
      if (this.parent) {
        this.parent.children = this.parent.children.filter((c) => c !== this);
        this.parent = null;
      }
    },
    click() {
      /* noop */
    },
  };
  return el;
}

const body: StubElement = makeEl();
const createdTextareas: StubElement[] = [];
let hasFocusValue = true;
let execCommandResult = true;
let execCommandThrow = false;
let writeTextImpl: (text: string) => Promise<void> = async () => {
  /* default success */
};
let lastWritten: string | null = null;

function installDom() {
  const documentStub = {
    body,
    hasFocus: () => hasFocusValue,
    getElementById: (_id: string) => makeEl(),
    createElement: (_tag: string) => {
      const el = makeEl();
      if (_tag === "textarea") createdTextareas.push(el);
      return el;
    },
    execCommand: (_cmd: string) => {
      if (execCommandThrow) throw new Error("execCommand failed");
      return execCommandResult;
    },
    querySelectorAll: (_sel: string) => [],
  };
  // attach helpers used by .body.appendChild via Object.assign chain
  (body as unknown as { appendChild: (c: StubElement) => StubElement }).appendChild = (
    child: StubElement,
  ) => {
    child.parent = body;
    body.children.push(child);
    return child;
  };
  (globalThis as Record<string, unknown>).document = documentStub;
  (globalThis as Record<string, unknown>).window = {
    setTimeout: (fn: () => void, _ms?: number) => globalThis.setTimeout(fn, 0),
  };
  (globalThis as Record<string, unknown>).navigator = {
    clipboard: {
      writeText: async (text: string) => {
        lastWritten = text;
        await writeTextImpl(text);
      },
    },
  };
}

installDom();

// Import after DOM is installed so state.js module init succeeds.
const { copyTextWithFallback } = await import("../public/app/trace-export.js");

beforeEach(() => {
  hasFocusValue = true;
  execCommandResult = true;
  execCommandThrow = false;
  writeTextImpl = async () => {
    /* success */
  };
  lastWritten = null;
  body.children.length = 0;
  createdTextareas.length = 0;
});

afterEach(() => {
  body.children.length = 0;
  createdTextareas.length = 0;
});

describe("copyTextWithFallback", () => {
  test("C1: skips clipboard when document is unfocused, falls back to execCommand", async () => {
    hasFocusValue = false;
    execCommandResult = true;
    let clipboardCalled = false;
    writeTextImpl = async () => {
      clipboardCalled = true;
    };

    const result = await copyTextWithFallback("hello");

    expect(result).toEqual({ ok: true, via: "execCommand" });
    expect(clipboardCalled).toBe(false);
    expect(createdTextareas.length).toBe(1);
    expect(createdTextareas[0]?.value).toBe("hello");
    // textarea should be removed after copy
    expect(body.children.length).toBe(0);
  });

  test("C2: clipboard.writeText throws → degrades to execCommand", async () => {
    hasFocusValue = true;
    execCommandResult = true;
    writeTextImpl = async () => {
      throw new Error("NotAllowedError: Document is not focused");
    };

    const result = await copyTextWithFallback("payload");

    expect(result).toEqual({ ok: true, via: "execCommand" });
    expect(createdTextareas.length).toBe(1);
    expect(body.children.length).toBe(0);
  });

  test("C3: both stages fail → returns { ok: false }", async () => {
    hasFocusValue = true;
    writeTextImpl = async () => {
      throw new Error("clipboard rejected");
    };
    execCommandResult = false;

    const result = await copyTextWithFallback("nope");

    expect(result).toEqual({ ok: false });
    // textarea must still be cleaned up
    expect(body.children.length).toBe(0);
  });

  test("C4: 3 successful calls leave no textarea residue", async () => {
    hasFocusValue = false; // force execCommand path so textarea is created each call
    execCommandResult = true;

    for (let i = 0; i < 3; i += 1) {
      const r = await copyTextWithFallback(`call-${i}`);
      expect(r.ok).toBe(true);
    }

    expect(createdTextareas.length).toBe(3);
    // No textarea should remain attached to body.
    const remaining = body.children.filter((c) => createdTextareas.includes(c));
    expect(remaining.length).toBe(0);
    expect(lastWritten).toBeNull();
  });
});
