// @ts-nocheck
/**
 * Pure helper that translates `(text, caretOffset, commands, activeIndex)` into
 * the dropdown state for the slash command suggestion popover.
 *
 * Output shape:
 *   {
 *     open: boolean,
 *     query: string,
 *     items: SuggestionItem[],
 *     activeIndex: number,
 *   }
 *
 * SuggestionItem = {
 *   name: string,
 *   type: "builtin" | "skill",
 *   effect: "local" | "prompted",
 *   description: string,
 *   matchHighlight: Array<[start, end]>,
 * }
 *
 * Behaviour:
 * - The popover only opens when the caret sits inside a slash-token in the
 *   current logical line (line-start to caret starts with `/` and contains no
 *   whitespace before caret).
 * - Matching is case-insensitive against `name`. Sort priority:
 *     1. prefix match (score 3)
 *     2. substring match (score 2)
 *     3. description substring (score 1)
 *   Ties broken by lexicographic name order.
 * - Returns at most 10 items.
 * - `activeIndex` is clamped to [0, items.length - 1]; defaults to 0.
 */

const MAX_ITEMS = 10;

export function computeSuggestionState({ text, caretOffset, commands, activeIndex } = {}) {
  const safeText = typeof text === "string" ? text : "";
  const offset = clampInt(caretOffset, 0, safeText.length);
  const safeCommands = Array.isArray(commands) ? commands : [];

  const slashToken = readSlashTokenAtCaret(safeText, offset);
  if (slashToken === null) {
    return { open: false, query: "", items: [], activeIndex: 0 };
  }

  const query = slashToken.toLowerCase();
  const items = rankCommands(safeCommands, query).slice(0, MAX_ITEMS).map((entry) => toSuggestionItem(entry, query));
  const clampedIndex = items.length === 0 ? 0 : clampInt(activeIndex ?? 0, 0, items.length - 1);

  return { open: true, query, items, activeIndex: clampedIndex };
}

function readSlashTokenAtCaret(text, caret) {
  const upToCaret = text.slice(0, caret);
  // 找到 caret 所在的"逻辑行"行首
  const lineStart = upToCaret.lastIndexOf("\n") + 1;
  const line = upToCaret.slice(lineStart);
  if (!line.startsWith("/")) return null;
  // line 中如果包含空白则代表已经在写参数 → 不再触发
  if (/\s/.test(line)) return null;
  return line.slice(1); // 去掉首字符 `/`
}

function rankCommands(commands, query) {
  const scored = [];
  for (const command of commands) {
    if (!command || typeof command.name !== "string") continue;
    const score = scoreCommand(command, query);
    if (query === "" || score > 0) {
      scored.push({ command, score });
    }
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.command.name.localeCompare(b.command.name);
  });
  return scored.map((entry) => entry.command);
}

function scoreCommand(command, query) {
  if (query === "") return 1;
  const name = command.name.toLowerCase();
  const description = (command.description ?? "").toLowerCase();
  if (name.startsWith(query)) return 3;
  if (name.includes(query)) return 2;
  if (description.includes(query)) return 1;
  return 0;
}

function toSuggestionItem(command, query) {
  return {
    name: command.name,
    type: command.type === "builtin" ? "builtin" : "skill",
    effect: command.effect === "local" ? "local" : "prompted",
    description: command.description ?? "",
    matchHighlight: highlightSpans(command.name, query),
  };
}

function highlightSpans(name, query) {
  if (!query) return [];
  const lowerName = name.toLowerCase();
  const idx = lowerName.indexOf(query);
  if (idx === -1) return [];
  return [[idx, idx + query.length]];
}

function clampInt(value, min, max) {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
