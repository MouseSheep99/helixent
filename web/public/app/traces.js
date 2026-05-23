// @ts-nocheck
import { state, els } from "./state.js";
import * as View from "../view.js";
import { api } from "./api.js";
import { renderRequest } from "./prompt.js";
import { renderOutput, renderTimeline, renderRunState, renderTodoPanel } from "./output.js";

export async function loadTraces() {
  const result = await api("/api/traces");
  state.traces = result.traces || [];
  renderTraces();
}

export function renderTraces() {
  els.traceList.innerHTML = View.renderTracesHTML(state.traces, els.traceSearch.value);
  els.traceList.querySelectorAll("[data-trace]").forEach((button) => {
    button.addEventListener("click", () => openTrace(button.dataset.trace));
  });
  els.traceList.querySelectorAll("[data-delete-trace]").forEach((button) => {
    button.addEventListener("click", () => deleteTrace(button.dataset.deleteTrace));
  });
}

export async function openTrace(traceId) {
  const replay = await api(`/api/traces/${encodeURIComponent(traceId)}`);
  state.replaying = true;
  state.currentTraceId = traceId;
  state.traceRows = replay.events || [];
  const replayState = View.replayEventsToState(replay.events || []);
  state.events = replayState.events;
  state.messages = replayState.messages;
  state.progress = View.latestProgressFromEvents(state.events);
  state.todos = View.latestTodosFromEvents(state.events);
  state.pendingApproval = null;
  state.pendingQuestion = null;
  els.sessionMeta.textContent = `Replay · ${traceId}`;
  renderRequest();
  renderOutput();
  renderTimeline();
  renderRunState();
  renderTodoPanel();
}

export async function deleteTrace(traceId) {
  if (!traceId) return;
  const ok = window.confirm(`Delete trace ${traceId}?`);
  if (!ok) return;
  await api(`/api/traces/${encodeURIComponent(traceId)}`, { method: "DELETE", body: {} });
  if (state.currentTraceId === traceId && state.replaying) {
    state.replaying = false;
    state.currentTraceId = state.session?.sessionId || null;
    state.traceRows = [];
    state.events = [];
    state.messages = state.session?.messages || [];
    state.progress = null;
    state.todos = [];
    state.pendingApproval = null;
    state.pendingQuestion = null;
    els.sessionMeta.textContent = state.session ? `${state.session.model} · ${state.session.cwd}` : "No session";
    els.workspaceCwd.textContent = state.session?.cwd || "—";
    renderRequest();
    renderOutput();
    renderTimeline();
    renderRunState();
  }
  await loadTraces();
}
