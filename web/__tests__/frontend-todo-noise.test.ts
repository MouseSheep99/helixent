import { describe, expect, test } from "bun:test";

import { shouldRecordTodoUpdate } from "../public/view/human-actions.js";

describe("BF-1 todo_update dedup", () => {
  test("T1 prev empty + next empty → not recorded (noise)", () => {
    expect(shouldRecordTodoUpdate([], [])).toBe(false);
  });

  test("T2 prev non-empty + next empty → recorded (meaningful 'clear' transition)", () => {
    const prev = [
      { id: "1", content: "a", status: "in_progress" },
      { id: "2", content: "b", status: "pending" },
    ];
    expect(shouldRecordTodoUpdate(prev, [])).toBe(true);
  });

  test("T3 prev empty + next non-empty → recorded (first todos)", () => {
    const next = [{ id: "1", content: "a", status: "pending" }];
    expect(shouldRecordTodoUpdate([], next)).toBe(true);
  });

  test("T4 both non-empty → recorded (regular update)", () => {
    const prev = [{ id: "1", content: "a", status: "pending" }];
    const next = [{ id: "1", content: "a", status: "in_progress" }];
    expect(shouldRecordTodoUpdate(prev, next)).toBe(true);
  });

  test("T5 nullish inputs treated as empty (defensive)", () => {
    expect(shouldRecordTodoUpdate(undefined, undefined)).toBe(false);
    expect(shouldRecordTodoUpdate(null as any, null as any)).toBe(false);
  });
});
