import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// 折叠交互单测：mock 完整 DOM + localStorage 后 import session.js，
// 验证 toggleSidebar / toggleTimeline / restoreTimelineState 的副作用。

type StubClassList = {
  _set: Set<string>;
  toggle: (name: string, force?: boolean) => boolean;
  contains: (name: string) => boolean;
  add: (name: string) => void;
  remove: (name: string) => void;
};

type StubElement = {
  textContent: string;
  value: string;
  title: string;
  attrs: Record<string, string>;
  style: Record<string, string>;
  classList: StubClassList;
  parent: StubElement | null;
  children: StubElement[];
  setAttribute: (name: string, value: string) => void;
  getAttribute: (name: string) => string | null;
  addEventListener: (..._args: unknown[]) => void;
  removeEventListener: (..._args: unknown[]) => void;
  appendChild: (child: StubElement) => StubElement;
  remove: () => void;
  click: () => void;
  select: () => void;
};

function makeClassList(): StubClassList {
  const set = new Set<string>();
  return {
    _set: set,
    toggle(name, force) {
      const want = force === undefined ? !set.has(name) : force;
      if (want) set.add(name);
      else set.delete(name);
      return want;
    },
    contains(name) {
      return set.has(name);
    },
    add(name) {
      set.add(name);
    },
    remove(name) {
      set.delete(name);
    },
  };
}

function makeEl(): StubElement {
  const el: StubElement = {
    textContent: "",
    value: "",
    title: "",
    attrs: {},
    style: {},
    classList: makeClassList(),
    parent: null,
    children: [],
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    getAttribute(name) {
      const v = this.attrs[name];
      return v === undefined ? null : v;
    },
    addEventListener() {
      /* noop */
    },
    removeEventListener() {
      /* noop */
    },
    appendChild(child) {
      child.parent = this;
      this.children.push(child);
      return child;
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
    select() {
      /* noop */
    },
  };
  return el;
}

const body = makeEl();
const elementsById = new Map<string, StubElement>();
function ensureEl(id: string): StubElement {
  let el = elementsById.get(id);
  if (!el) {
    el = makeEl();
    elementsById.set(id, el);
  }
  return el;
}

const localStorageStore = new Map<string, string>();

function installDom() {
  const documentStub = {
    body,
    hasFocus: () => true,
    getElementById: (id: string) => ensureEl(id),
    createElement: (_tag: string) => makeEl(),
    querySelectorAll: (_sel: string) => [],
    execCommand: (_cmd: string) => true,
  };
  (globalThis as Record<string, unknown>).document = documentStub;
  (globalThis as Record<string, unknown>).window = {
    setTimeout: (fn: () => void, _ms?: number) => globalThis.setTimeout(fn, 0),
  };
  (globalThis as Record<string, unknown>).navigator = {
    clipboard: { writeText: async () => {} },
  };
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => (localStorageStore.has(k) ? localStorageStore.get(k)! : null),
    setItem: (k: string, v: string) => {
      localStorageStore.set(k, String(v));
    },
    removeItem: (k: string) => {
      localStorageStore.delete(k);
    },
    clear: () => localStorageStore.clear(),
  };
}

installDom();

const session = await import("../public/app/session.js");
const { els } = await import("../public/app/state.js");

beforeEach(() => {
  body.classList._set.clear();
  localStorageStore.clear();
  for (const el of elementsById.values()) {
    el.attrs = {};
    el.title = "";
  }
  // session.js's els references were captured at import time; reset their attrs too
  if (els.toggleSidebar) {
    (els.toggleSidebar as unknown as StubElement).attrs = {};
    (els.toggleSidebar as unknown as StubElement).title = "";
  }
  if (els.toggleTimeline) {
    (els.toggleTimeline as unknown as StubElement).attrs = {};
    (els.toggleTimeline as unknown as StubElement).title = "";
  }
});

afterEach(() => {
  body.classList._set.clear();
  localStorageStore.clear();
});

describe("collapse interactions", () => {
  test("C1: default state has neither sidebar nor timeline collapsed", () => {
    session.restoreSidebarState();
    session.restoreTimelineState();
    expect(body.classList.contains("sidebar-collapsed")).toBe(false);
    expect(body.classList.contains("timeline-collapsed")).toBe(false);
  });

  test("C2: toggleSidebar collapses sidebar and persists state", () => {
    session.toggleSidebar();
    expect(body.classList.contains("sidebar-collapsed")).toBe(true);
    expect(localStorageStore.get("helixent.sidebarCollapsed")).toBe("true");
    expect((els.toggleSidebar as unknown as StubElement).attrs["aria-pressed"]).toBe("true");
    expect((els.toggleSidebar as unknown as StubElement).attrs["aria-label"]).toBe("Expand sidebar");
  });

  test("C3: toggleTimeline collapses timeline and persists state", () => {
    session.toggleTimeline();
    expect(body.classList.contains("timeline-collapsed")).toBe(true);
    expect(localStorageStore.get("helixent.timelineCollapsed")).toBe("true");
    expect((els.toggleTimeline as unknown as StubElement).attrs["aria-pressed"]).toBe("true");
    expect((els.toggleTimeline as unknown as StubElement).attrs["aria-label"]).toBe("Expand timeline");
  });

  test("C4: sidebar and timeline collapse independently (orthogonal)", () => {
    session.toggleSidebar();
    session.toggleTimeline();
    expect(body.classList.contains("sidebar-collapsed")).toBe(true);
    expect(body.classList.contains("timeline-collapsed")).toBe(true);
    // Toggle each back independently
    session.toggleSidebar();
    expect(body.classList.contains("sidebar-collapsed")).toBe(false);
    expect(body.classList.contains("timeline-collapsed")).toBe(true);
    session.toggleTimeline();
    expect(body.classList.contains("sidebar-collapsed")).toBe(false);
    expect(body.classList.contains("timeline-collapsed")).toBe(false);
  });
});
