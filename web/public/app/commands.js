// @ts-nocheck
import { state, els } from "./state.js";
import * as View from "../view.js";
import { renderTimeline } from "./output.js";

export function renderCommands() {
  els.commandPicker.innerHTML = View.renderCommandsHTML(state.commands);
}

export function insertCommand(name) {
  els.promptInput.value = `/${name} `;
  els.promptInput.focus();
}

export function setTimelineFilter(filter) {
  els.timelineFilter.value = filter;
  els.timelineFilterButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.timelineFilter === filter);
  });
  renderTimeline();
}
