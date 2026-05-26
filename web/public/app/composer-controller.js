// @ts-nocheck
import { state, els } from "./state.js";
import { computeSuggestionState } from "../view/slash-suggestion.js";
import { renderSuggestionPopoverHTML } from "../view/render-suggestion.js";
import { renderCommandChipHTML } from "../view/command-chip.js";
import { parseSlashInputClient } from "./session.js";

/**
 * Wire up the slash command suggestion popover + command chip hint to the
 * existing `<textarea id="promptInput">`. Idempotent — safe to call once at
 * boot.
 */
export function mountComposerController() {
  if (!els.promptInput || !els.slashSuggestionPopover || !els.composerCommandChip) {
    return;
  }
  if (els.promptInput.dataset.composerControllerMounted === "1") return;
  els.promptInput.dataset.composerControllerMounted = "1";

  const ctx = {
    activeIndex: 0,
    open: false,
    composing: false,
  };

  const recompute = () => {
    if (ctx.composing) return; // 处于中文输入法 composition 期间不算 slash
    const text = els.promptInput.value ?? "";
    const caret = typeof els.promptInput.selectionStart === "number"
      ? els.promptInput.selectionStart
      : text.length;

    const popoverState = computeSuggestionState({
      text,
      caretOffset: caret,
      commands: state.commands,
      activeIndex: ctx.activeIndex,
    });
    ctx.open = popoverState.open;
    ctx.activeIndex = popoverState.activeIndex;
    renderPopover(popoverState);

    const parseResult = parseSlashInputClient(text, state.commands);
    const chipParseResult = enrichWithEffect(parseResult, state.commands);
    renderChip(chipParseResult);
  };

  const renderPopover = (popoverState) => {
    if (!popoverState.open) {
      els.slashSuggestionPopover.hidden = true;
      els.slashSuggestionPopover.innerHTML = "";
      els.promptInput.setAttribute("aria-expanded", "false");
      els.promptInput.removeAttribute("aria-activedescendant");
      return;
    }
    const html = renderSuggestionPopoverHTML(popoverState);
    els.slashSuggestionPopover.innerHTML = html;
    els.slashSuggestionPopover.hidden = false;
    els.promptInput.setAttribute("aria-expanded", "true");
    if (popoverState.items.length > 0) {
      els.promptInput.setAttribute("aria-activedescendant", `slash-opt-${popoverState.activeIndex}`);
    } else {
      els.promptInput.removeAttribute("aria-activedescendant");
    }
  };

  const renderChip = (parseResult) => {
    const html = renderCommandChipHTML(parseResult);
    if (!html) {
      els.composerCommandChip.hidden = true;
      els.composerCommandChip.innerHTML = "";
      return;
    }
    els.composerCommandChip.innerHTML = html;
    els.composerCommandChip.hidden = false;
  };

  const closePopover = () => {
    ctx.open = false;
    ctx.activeIndex = 0;
    els.slashSuggestionPopover.hidden = true;
    els.slashSuggestionPopover.innerHTML = "";
    els.promptInput.setAttribute("aria-expanded", "false");
    els.promptInput.removeAttribute("aria-activedescendant");
  };

  const replaceSlashTokenWith = (commandName) => {
    const text = els.promptInput.value ?? "";
    const caret = typeof els.promptInput.selectionStart === "number"
      ? els.promptInput.selectionStart
      : text.length;
    const upToCaret = text.slice(0, caret);
    const lineStart = upToCaret.lastIndexOf("\n") + 1;
    const tail = text.slice(caret);
    const replaced = `${text.slice(0, lineStart)}/${commandName} ${tail}`;
    els.promptInput.value = replaced;
    const newCaret = lineStart + 1 + commandName.length + 1;
    els.promptInput.setSelectionRange(newCaret, newCaret);
    closePopover();
    recompute();
  };

  els.promptInput.addEventListener("compositionstart", () => {
    ctx.composing = true;
    closePopover();
  });
  els.promptInput.addEventListener("compositionend", () => {
    ctx.composing = false;
    recompute();
  });
  els.promptInput.addEventListener("input", recompute);
  els.promptInput.addEventListener("click", recompute);
  els.promptInput.addEventListener("keyup", (event) => {
    // 仅在方向键移动光标时也触发，input 事件已覆盖编辑场景
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      recompute();
    }
  });

  els.promptInput.addEventListener("keydown", (event) => {
    if (!ctx.open) return;
    const popoverState = computeSuggestionState({
      text: els.promptInput.value ?? "",
      caretOffset: els.promptInput.selectionStart ?? 0,
      commands: state.commands,
      activeIndex: ctx.activeIndex,
    });
    if (!popoverState.open || popoverState.items.length === 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      ctx.activeIndex = (ctx.activeIndex + 1) % popoverState.items.length;
      renderPopover({ ...popoverState, activeIndex: ctx.activeIndex });
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      ctx.activeIndex = (ctx.activeIndex - 1 + popoverState.items.length) % popoverState.items.length;
      renderPopover({ ...popoverState, activeIndex: ctx.activeIndex });
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      const chosen = popoverState.items[ctx.activeIndex];
      if (chosen) replaceSlashTokenWith(chosen.name);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closePopover();
    }
  });

  els.promptInput.addEventListener("blur", () => {
    // 延迟关闭，让 click 事件能先冒泡到候选项
    setTimeout(() => closePopover(), 80);
  });

  els.slashSuggestionPopover.addEventListener("mousedown", (event) => {
    // 防止 textarea blur 抢先关掉浮层
    event.preventDefault();
  });
  els.slashSuggestionPopover.addEventListener("click", (event) => {
    const target = event.target.closest("[data-cmd]");
    if (!target) return;
    const cmd = target.getAttribute("data-cmd");
    if (cmd) replaceSlashTokenWith(cmd);
  });

  els.composerCommandChip.addEventListener("click", (event) => {
    const removeButton = event.target.closest(".composer-chip-remove");
    if (!removeButton) return;
    const text = els.promptInput.value ?? "";
    const stripped = text.replace(/^\/[^\s]+\s?/, "");
    els.promptInput.value = stripped;
    els.promptInput.setSelectionRange(0, 0);
    els.promptInput.focus();
    recompute();
  });

  // 初次渲染
  recompute();
}

function enrichWithEffect(parseResult, commands) {
  if (!parseResult || parseResult.kind !== "builtin") return parseResult;
  const match = (commands || []).find((c) => c.name === parseResult.name);
  if (!match) return parseResult;
  return { ...parseResult, effect: match.effect };
}
