import { chip, contentToText, escapeAttr, escapeHtml, formatTime, formatTokenCount, latestEvent } from "./utils.js";

export function renderRequestHTML(events = [], promptState = null, replaying = false, draftSnapshot = null) {
  const context = latestEvent(events, "input_context");
  const appliedVersionEvent = latestEvent(events, "prompt_version_applied");
  const detected = events.filter((event) => event.kind === "tool_call_detected").length;
  const activeVersion = replaying
    ? null
    : promptState?.activeVersionId
      ? promptState.versions?.find((version) => version.id === promptState.activeVersionId) || null
      : null;
  const snapshot = !replaying && activeVersion
    ? activeVersion
    : !replaying && promptState?.runtime
      ? promptState.runtime
      : !replaying && draftSnapshot
        ? draftSnapshot
        : context?.data?.prompt
          ? context.data
          : null;
  const promptSource = snapshot?.source || appliedVersionEvent?.data?.source || "runtime";
  const promptVersionId = snapshot?.versionId || activeVersion?.id || appliedVersionEvent?.data?.versionId || null;
  const promptVersionName = snapshot?.name || activeVersion?.name || appliedVersionEvent?.data?.versionName || null;
  const messages = snapshot?.messages || context?.data?.messages || [];
  const tools = snapshot?.tools || context?.data?.tools || [];
  // `prompt` here is the **base** system prompt — what the user authors and the agent stores in
  // `session.agent.prompt`. The assembled prompt sent to the model (base + skill_system block) is
  // recorded per-turn in the `input_context` events and surfaced on each assistant card via the
  // ◐ "sent prompt" dialog, so this editor only ever shows the user-editable baseline.
  const prompt = snapshot?.prompt || "";
  const requestedSkillName = snapshot?.requestedSkillName || context?.data?.requestedSkillName || null;
  const userQuery = extractLatestUserQuery(messages);
  const currentSnapshot = { source: promptSource, versionId: promptVersionId, versionName: promptVersionName, prompt, messages, tools, requestedSkillName };
  const chips = [
    chip(`${tools.length} tools`),
    requestedSkillName ? chip(`/${requestedSkillName}`) : "",
    chip(promptSource === "draft" ? "draft" : promptSource === "prompt_version" ? "prompt version" : "runtime"),
    promptVersionName ? chip(promptVersionName) : "",
    chip(`${detected} tool calls`),
    replaying ? chip("replay") : chip("live"),
  ].join("");
  const metrics = buildRequestMetricItems({
    current: snapshot || context ? currentSnapshot : null,
    runtime: promptState?.runtime || null,
    activeVersion,
    promptSource,
    replaying,
  });

  if (!snapshot && !context) {
    return {
      chips,
      metrics,
      diff: renderPromptDiffPanelHTML(),
      package: renderRequestPackagePanelHTML({ prompt: "", messages: [] }),
      body: `
        <div class="request-empty">
          <strong>No model request captured yet.</strong>
          <span>Prompt playground appears after a run reaches beforeModel. Bootstrapped project context such as AGENTS.md will surface in the Model Output column.</span>
        </div>`,
    };
  }

  return {
    chips,
    metrics,
    diff: renderPromptDiffPanelHTML({
      current: currentSnapshot,
      runtime: promptState?.runtime || null,
      activeVersion,
      promptSource,
      replaying,
    }),
    package: renderRequestPackagePanelHTML({ prompt, messages }),
    body: renderPromptPlayground({
      prompt,
      messages,
      tools,
      requestedSkillName,
      promptSource,
      promptVersionId,
      promptVersionName,
      userQuery,
      activeVersion,
      replaying,
      runtime: promptState?.runtime || null,
      versions: replaying ? [] : promptState?.versions || [],
      draftPrompt: replaying ? null : promptState?.draftPrompt ?? null,
      draftUpdatedAt: replaying ? null : promptState?.draftUpdatedAt ?? null,
      detected,
    }),
  };
}

function renderPromptPlayground({
  prompt,
  messages,
  tools,
  requestedSkillName,
  promptSource,
  promptVersionId,
  promptVersionName,
  userQuery,
  activeVersion,
  replaying,
  runtime,
  versions,
  draftPrompt,
  draftUpdatedAt,
}) {
  // Live edit value: draftPrompt overrides everything when present.
  const liveValue = typeof draftPrompt === "string" ? draftPrompt : prompt;
  const hasDraft = typeof draftPrompt === "string" && draftPrompt.length > 0;
  const stats = computePromptStats(liveValue);
  const statusLabel = hasDraft
    ? activeVersion
      ? `Auto-saved draft over version: ${activeVersion.name}`
      : "Auto-saved draft"
    : promptSource === "prompt_version"
      ? `Version: ${promptVersionName || activeVersion?.name || "saved version"}`
      : "Runtime (template + middleware)";
  const statusTone = hasDraft ? "draft" : promptSource === "prompt_version" ? "version" : "runtime";
  return `
    <section class="prompt-playground">
      ${renderPromptToolbar({ promptSource, promptVersionName, activeVersion, versions, replaying, hasDraft, statusLabel, statusTone })}
      ${
        replaying
          ? renderPromptReadOnly({ prompt, messages, tools, requestedSkillName, promptSource, promptVersionId, promptVersionName })
          : `<form class="prompt-editor prompt-editor-primary" data-prompt-editor>
              <label class="system-prompt-field">
                <p class="prompt-editor-hint" data-prompt-sync-status>${escapeHtml(formatDraftSyncStatus(draftUpdatedAt))}</p>
                <div class="prompt-textarea-wrap" data-prompt-line-count="${stats.lines}">
                  <textarea data-prompt-system rows="20" spellcheck="false">${escapeHtml(liveValue)}</textarea>
                </div>
                <footer class="prompt-editor-footer">
                  <span data-prompt-stats>${stats.lines} lines · ${stats.chars} chars · ~${stats.tokens} tokens</span>
                  <span class="prompt-editor-footer-spacer"></span>
                  <span class="prompt-editor-footer-hint" data-prompt-save-hint hidden>Saving…</span>
                </footer>
              </label>
              <div class="prompt-meta-line">
                ${escapeHtml(compactPromptMeta({ messages, tools, requestedSkillName, userQuery }))}
              </div>
              <div class="prompt-validation compact">
                ${renderPromptValidation({ prompt: liveValue, messages, tools, userQuery })}
              </div>
            </form>`
      }
    </section>
  `;
}

function formatDraftSyncStatus(draftUpdatedAt) {
  if (!draftUpdatedAt) return "Auto-save ready. Latest sync: not yet saved.";
  return `Auto-saved draft. Latest sync: ${formatTime(draftUpdatedAt)}`;
}

export function computePromptStats(text = "") {
  const value = typeof text === "string" ? text : "";
  const chars = value.length;
  const lines = value.length === 0 ? 1 : value.split("\n").length;
  const tokens = Math.max(1, Math.ceil(chars / 4));
  return { chars, lines, tokens: formatTokenCount(tokens) };
}

function formatPromptSourceLabel(promptSource, promptVersionName, activeVersion) {
  if (promptSource === "draft") {
    return activeVersion ? `Auto-saved draft over version: ${activeVersion.name}` : "Auto-saved draft";
  }
  if (promptSource === "prompt_version") {
    return `Active version: ${promptVersionName || activeVersion?.name || "saved version"}`;
  }
  return "Runtime generated";
}

function renderPromptToolbar({ promptSource, promptVersionName, activeVersion, versions = [], replaying = false, hasDraft = false, statusLabel = "", statusTone = "runtime" }) {
  return `
    <header class="prompt-toolbar">
      <div class="prompt-toolbar-main">
        <span class="eyebrow">Prompt lab</span>
        <strong>System prompt</strong>
        <span class="prompt-status-pill" data-tone="${escapeAttr(statusTone)}" title="Status only. Your edits are already saved automatically.">${escapeHtml(statusLabel || formatPromptSourceLabel(promptSource, promptVersionName, activeVersion))}</span>
      </div>
      <div class="prompt-toolbar-actions">
        ${
          replaying
            ? `<span class="muted-inline">Replay mode</span>`
            : `<details class="prompt-version-menu">
                <summary>Versions${versions.length ? ` · ${versions.length}` : ""}</summary>
                ${renderPromptVersions(versions, activeVersion)}
              </details>
              <button class="ghost-button mini-button" data-prompt-pin-version type="button" title="Save the current auto-saved draft as a named version snapshot">Save version snapshot</button>
              ${hasDraft ? `<button class="ghost-button mini-button" data-prompt-reset-runtime type="button" title="Discard the current auto-saved draft">Discard draft</button>` : ""}`
        }
      </div>
    </header>`;
}

function compactPromptMeta({ messages, tools, requestedSkillName, userQuery }) {
  const parts = [`${messages.length} messages`, `${tools.length} tools`];
  if (requestedSkillName) parts.push(`/${requestedSkillName}`);
  if (userQuery) parts.push(`query ready`);
  return parts.join(" · ");
}

function renderPromptReadOnly({ prompt }) {
  return `
    <div class="prompt-readonly">
      <pre>${escapeHtml(prompt || "No system prompt captured.")}</pre>
    </div>`;
}

export function renderRequestPackagePanelHTML({ prompt = "", messages = [] } = {}) {
  return `
    <div class="request-package-body">
      <p class="request-package-hint">Snapshot of the actual request that will be sent to the model: system prompt and messages. Tool inventory lives in the bar beneath the Agent Output.</p>
      <details class="prompt-inspect" open>
        <summary>System prompt · ${prompt ? `${prompt.length} chars` : "empty"}</summary>
        <pre class="request-package-pre">${escapeHtml(prompt || "(empty)")}</pre>
      </details>
      <label>
        Messages override JSON
        <textarea data-prompt-messages rows="8" spellcheck="false">${escapeHtml(JSON.stringify(messages, null, 2))}</textarea>
      </label>
    </div>`;
}

export function renderAgentToolsBarHTML(tools = []) {
  const list = Array.isArray(tools) ? tools : [];
  const enabled = list.filter((tool) => tool.enabled !== false);
  const disabled = list.filter((tool) => tool.enabled === false);
  if (!list.length) {
    return `
      <div class="agent-tools-bar-row">
        <span class="agent-tools-bar-label">Tools available · 0</span>
        <span class="muted-inline">No tools registered.</span>
      </div>`;
  }
  return `
    <div class="agent-tools-bar-row">
      <span class="agent-tools-bar-label">Tools available · ${enabled.length}</span>
      ${
        enabled.length
          ? enabled
              .map(
                (tool) => `
                <button type="button" class="chip agent-tool-chip enabled" data-agent-tool-disable="${escapeAttr(tool.name)}" title="Disable ${escapeAttr(tool.name)}">
                  <span>${escapeHtml(tool.name || "tool")}</span>
                  <span class="agent-tool-chip-icon" aria-hidden="true">×</span>
                </button>`,
              )
              .join("")
          : `<span class="muted-inline">No tools enabled.</span>`
      }
      ${
        disabled.length
          ? `<span class="agent-tools-bar-divider" aria-hidden="true">·</span>
             <span class="agent-tools-bar-label muted">Disabled · ${disabled.length}</span>
             ${disabled
               .map(
                 (tool) => `
                 <button type="button" class="chip agent-tool-chip disabled" data-agent-tool-enable="${escapeAttr(tool.name)}" title="Enable ${escapeAttr(tool.name)}">
                   <span class="agent-tool-chip-icon" aria-hidden="true">+</span>
                   <span>${escapeHtml(tool.name || "tool")}</span>
                 </button>`,
               )
               .join("")}`
          : ""
      }
    </div>`;
}

export function renderPromptDiffPanelHTML({ current = null, runtime = null, activeVersion = null, promptSource = "runtime", replaying = false } = {}) {
  if (!current && !runtime) {
    return `<div class="empty-state">No prompt snapshot yet.</div>`;
  }
  if (!runtime) {
    return `
      <div class="prompt-diff-summary">
        <div class="diff-equal">No runtime baseline captured yet.</div>
        <div class="muted-inline">${escapeHtml(replaying ? "Replay snapshot" : "Run once to compare edits against runtime.")}</div>
        ${current ? renderFinalRequestInspect(current) : ""}
      </div>`;
  }
  const summary = summarizePromptDiff(runtime, current || runtime);
  return `
    <div class="prompt-diff-summary">
      <div class="prompt-diff-source">${escapeHtml(diffComparisonLabel(promptSource, runtime, activeVersion))}</div>
      <div class="prompt-diff-summary-grid">
        ${renderPromptDiffSummaryItem("System", summary.systemChanged ? "changed" : "unchanged", summary.systemChanged)}
        ${renderPromptDiffSummaryItem("Messages", `${summary.messageCount.left} → ${summary.messageCount.right}`, summary.messageCount.left !== summary.messageCount.right || summary.queryChanged)}
        ${renderPromptDiffSummaryItem("Tools", `+${summary.tools.added} / -${summary.tools.removed}`, summary.tools.added > 0 || summary.tools.removed > 0)}
        ${renderPromptDiffSummaryItem("Skill", summary.skillChanged ? "changed" : "unchanged", summary.skillChanged)}
      </div>
      <details class="prompt-diff-details">
        <summary>View detailed diff</summary>
        ${renderPromptDiff({ current: current || runtime, runtime })}
      </details>
      ${renderFinalRequestInspect(current || runtime)}
    </div>`;
}

function renderFinalRequestInspect(snapshot = {}) {
  const payload = {
    source: snapshot.source || "runtime",
    versionId: snapshot.versionId ?? null,
    versionName: snapshot.versionName || snapshot.name || null,
    requestedSkillName: snapshot.requestedSkillName ?? null,
    prompt: snapshot.prompt || "",
    messages: snapshot.messages || [],
    tools: snapshot.tools || [],
  };
  return `
    <details class="prompt-inspect">
      <summary>Final request JSON</summary>
      <pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre>
    </details>`;
}

function summarizePromptDiff(left = {}, right = {}) {
  const leftTools = new Set((left.tools || []).map((tool) => tool.name).filter(Boolean));
  const rightTools = new Set((right.tools || []).map((tool) => tool.name).filter(Boolean));
  const added = [...rightTools].filter((name) => !leftTools.has(name)).length;
  const removed = [...leftTools].filter((name) => !rightTools.has(name)).length;
  return {
    systemChanged: (left.prompt || "") !== (right.prompt || ""),
    messageCount: { left: left.messages?.length || 0, right: right.messages?.length || 0 },
    queryChanged: extractLatestUserQuery(left.messages || []) !== extractLatestUserQuery(right.messages || []),
    tools: { added, removed },
    skillChanged: (left.requestedSkillName || null) !== (right.requestedSkillName || null),
  };
}

function buildRequestMetricItems({ current = null, runtime = null, activeVersion = null, promptSource = "runtime", replaying = false } = {}) {
  const metrics = [];
  if (!current && !runtime) {
    return [
      { label: "Prompt diff", value: "no snapshot" },
      { label: "Messages", value: "0" },
      { label: "Tool diff", value: "n/a" },
      { label: "Skill diff", value: "n/a" },
      { label: "Prompt source", value: promptSourceLabel(promptSource) },
      { label: "Mode", value: replaying ? "Replay" : "Live" },
    ];
  }
  if (!runtime) {
    return [
      { label: "Prompt diff", value: "baseline missing" },
      { label: "Messages", value: String(current?.messages?.length || 0) },
      { label: "Tool diff", value: "n/a" },
      { label: "Skill diff", value: "n/a" },
      { label: "Prompt source", value: promptSourceLabel(promptSource) },
      { label: "Mode", value: replaying ? "Replay" : "Live" },
    ];
  }
  const summary = summarizePromptDiff(runtime, current || runtime);
  metrics.push(
    { label: "Prompt diff", value: summary.systemChanged ? "changed" : "unchanged" },
    { label: "Messages", value: `${summary.messageCount.left} -> ${summary.messageCount.right}` },
    { label: "Tool diff", value: `+${summary.tools.added} / -${summary.tools.removed}` },
    { label: "Skill diff", value: summary.skillChanged ? "changed" : "unchanged" },
    { label: "Prompt source", value: promptSourceLabel(promptSource, activeVersion) },
    { label: "Mode", value: replaying ? "Replay" : "Live" },
  );
  return metrics;
}

function promptSourceLabel(promptSource = "runtime", activeVersion = null) {
  if (promptSource === "draft") return "Draft";
  if (promptSource === "prompt_version") return activeVersion?.name || "Version";
  return "Runtime";
}

function renderPromptDiffSummaryItem(label, value, changed = false) {
  return `
    <div class="prompt-diff-summary-item ${changed ? "changed" : ""}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>`;
}

function diffComparisonLabel(promptSource, runtime, activeVersion) {
  if (!runtime) return "no runtime captured";
  if (promptSource === "prompt_version" && activeVersion) {
    return `${activeVersion.name || "version"} vs runtime`;
  }
  return "current edit vs runtime";
}

function renderPromptDiff({ current, runtime }) {
  if (!runtime) {
    return `<div class="empty-state">No runtime snapshot captured yet. Run the agent once to populate the diff baseline.</div>`;
  }
  const left = {
    prompt: runtime.prompt || "",
    messages: runtime.messages || [],
    tools: runtime.tools || [],
    requestedSkillName: runtime.requestedSkillName || null,
  };
  const right = {
    prompt: current.prompt || "",
    messages: current.messages || [],
    tools: current.tools || [],
    requestedSkillName: current.requestedSkillName || null,
  };
  return `
    <div class="diff-grid">
      ${renderDiffRow("System prompt", renderPromptTextDiff(left.prompt, right.prompt))}
      ${renderDiffRow("Messages", renderMessagesDiff(left.messages, right.messages))}
      ${renderDiffRow("Tools", renderToolsDiff(left.tools, right.tools))}
      ${renderDiffRow("Forced skill", renderSkillDiff(left.requestedSkillName, right.requestedSkillName))}
    </div>`;
}

function renderDiffRow(title, body) {
  return `
    <section class="diff-row">
      <div class="diff-row-title">${escapeHtml(title)}</div>
      <div class="diff-row-body">${body}</div>
    </section>`;
}

function renderPromptTextDiff(left = "", right = "") {
  if (left === right) {
    return `<div class="diff-equal">No changes (${countLines(left)} line${countLines(left) === 1 ? "" : "s"}).</div>`;
  }
  const lines = lineLevelDiff(left, right);
  const summary = `${lines.filter((line) => line.kind === "+").length} added · ${lines.filter((line) => line.kind === "-").length} removed`;
  return `
    <div class="diff-summary">${escapeHtml(summary)}</div>
    <pre class="diff-block">${lines
      .slice(0, 80)
      .map((line) => `<span class="diff-line diff-${line.kind === "+" ? "add" : line.kind === "-" ? "del" : "ctx"}">${escapeHtml(`${line.kind} ${line.text}`)}</span>`)
      .join("\n")}${lines.length > 80 ? `\n<span class="diff-line diff-ctx">... (${lines.length - 80} more lines truncated)</span>` : ""}</pre>`;
}

function renderMessagesDiff(left = [], right = []) {
  const leftCount = left.length;
  const rightCount = right.length;
  const leftQuery = extractLatestUserQuery(left);
  const rightQuery = extractLatestUserQuery(right);
  const queryChanged = leftQuery !== rightQuery;
  return `
    <div class="diff-summary">${escapeHtml(`${leftCount} → ${rightCount} message${rightCount === 1 ? "" : "s"}${queryChanged ? " · last user query changed" : ""}`)}</div>
    ${
      queryChanged
        ? `<div class="diff-pair">
            <div class="diff-side diff-runtime"><span class="diff-side-label">runtime</span><pre>${escapeHtml(leftQuery || "(none)")}</pre></div>
            <div class="diff-side diff-current"><span class="diff-side-label">current</span><pre>${escapeHtml(rightQuery || "(none)")}</pre></div>
          </div>`
        : `<div class="diff-equal">Last user query unchanged.</div>`
    }`;
}

function renderToolsDiff(left = [], right = []) {
  const leftNames = new Set((left || []).map((tool) => tool.name).filter(Boolean));
  const rightNames = new Set((right || []).map((tool) => tool.name).filter(Boolean));
  const added = [...rightNames].filter((name) => !leftNames.has(name));
  const removed = [...leftNames].filter((name) => !rightNames.has(name));
  if (!added.length && !removed.length) {
    return `<div class="diff-equal">${escapeHtml(`${rightNames.size} tool${rightNames.size === 1 ? "" : "s"} unchanged.`)}</div>`;
  }
  return `
    <div class="diff-summary">${escapeHtml(`${added.length} added · ${removed.length} removed`)}</div>
    <div class="diff-tool-list">
      ${added.map((name) => `<span class="diff-line diff-add">+ ${escapeHtml(name)}</span>`).join("")}
      ${removed.map((name) => `<span class="diff-line diff-del">- ${escapeHtml(name)}</span>`).join("")}
    </div>`;
}

function renderSkillDiff(left, right) {
  if ((left || null) === (right || null)) {
    return `<div class="diff-equal">${escapeHtml(left ? `/${left}` : "(none)")}</div>`;
  }
  return `
    <div class="diff-pair">
      <div class="diff-side diff-runtime"><span class="diff-side-label">runtime</span><pre>${escapeHtml(left || "(none)")}</pre></div>
      <div class="diff-side diff-current"><span class="diff-side-label">current</span><pre>${escapeHtml(right || "(none)")}</pre></div>
    </div>`;
}

function lineLevelDiff(left = "", right = "") {
  const leftLines = left.split("\n");
  const rightLines = right.split("\n");
  const leftSet = new Set(leftLines);
  const rightSet = new Set(rightLines);
  const merged = [];
  let li = 0;
  let ri = 0;
  while (li < leftLines.length || ri < rightLines.length) {
    const l = leftLines[li];
    const r = rightLines[ri];
    if (li >= leftLines.length) {
      merged.push({ kind: "+", text: r ?? "" });
      ri += 1;
      continue;
    }
    if (ri >= rightLines.length) {
      merged.push({ kind: "-", text: l ?? "" });
      li += 1;
      continue;
    }
    if (l === r) {
      merged.push({ kind: " ", text: l });
      li += 1;
      ri += 1;
      continue;
    }
    if (!rightSet.has(l)) {
      merged.push({ kind: "-", text: l });
      li += 1;
      continue;
    }
    if (!leftSet.has(r)) {
      merged.push({ kind: "+", text: r });
      ri += 1;
      continue;
    }
    merged.push({ kind: "-", text: l });
    merged.push({ kind: "+", text: r });
    li += 1;
    ri += 1;
  }
  return merged.filter((line) => line.kind !== " " || merged.some((other) => other.kind !== " "));
}

function countLines(value = "") {
  if (!value) return 0;
  return value.split("\n").length;
}

function renderPromptSummaryLines({ prompt, userQuery, tools, messages, activeVersion }) {
  const lines = [];
  lines.push(`<div class="summary-line">Messages sent to model: ${messages.length}</div>`);
  lines.push(`<div class="summary-line">Visible tools: ${tools.length}${tools.length ? ` · ${tools.slice(0, 8).map((tool) => escapeHtml(tool.name || "tool")).join(", ")}${tools.length > 8 ? ", ..." : ""}` : ""}</div>`);
  lines.push(`<div class="summary-line">Active version: ${activeVersion ? escapeHtml(activeVersion.name || activeVersion.id) : "Runtime generated"}</div>`);
  if (userQuery) {
    lines.push(`<div class="summary-line">User query: ${escapeHtml(userQuery)}</div>`);
  }
  const summary = summarizeSystemPrompt(prompt);
  if (summary.length) {
    summary.slice(0, 6).forEach((line) => {
      lines.push(`<div class="summary-line">${escapeHtml(line)}</div>`);
    });
  }
  return lines;
}

function renderPromptValidation({ prompt, messages, tools, userQuery }) {
  const checks = [
    prompt?.trim() ? "System prompt ready" : "System prompt is empty",
    Array.isArray(messages) ? `${messages.length} message(s)` : "Messages JSON must be an array",
    userQuery ? "User query detected" : "No user query detected",
    `${tools.length} visible tool(s)`,
  ];
  return checks.map((check) => `<span class="chip">${escapeHtml(check)}</span>`).join("");
}

function renderPromptToolToggles(tools = []) {
  if (!tools.length) return `<div class="empty-state">No tools visible in this snapshot.</div>`;
  return tools
    .map(
      (tool, index) => `
        <label class="prompt-tool-toggle">
          <input type="checkbox" data-prompt-tool-index="${index}" checked />
          <span>${escapeHtml(tool.name || `tool-${index + 1}`)}</span>
        </label>`,
    )
    .join("");
}

function nextPromptVersionName(versions = []) {
  return `Version ${Math.max(1, versions.length + 1)}`;
}

function renderPromptVersions(versions = [], activeVersion = null) {
  if (!versions.length) return `<div class="empty-state">No saved prompt versions yet.</div>`;
  return `
    <div class="request-version-list">
      ${versions
        .map(
          (version) => `
          <div class="list-item prompt-version-item ${activeVersion?.id === version.id ? "active" : ""}">
            <button class="prompt-version-main" type="button" data-prompt-activate-version="${escapeAttr(version.id)}">
              <span class="list-item-title">
                <span>${escapeHtml(version.name || version.id)}</span>
                ${activeVersion?.id === version.id ? `<span class="chip">active</span>` : ""}
              </span>
              <span class="list-item-detail">${escapeHtml(formatPromptVersionDetail(version))}</span>
            </button>
            <button class="ghost-button mini-button" type="button" data-prompt-delete-version="${escapeAttr(version.id)}">Delete</button>
          </div>`,
        )
        .join("")}
    </div>`;
}

function formatPromptVersionDetail(version) {
  const messageCount = version.messages?.length || 0;
  const toolCount = version.tools?.length || 0;
  const source = version.source === "prompt_version" ? "saved version" : "runtime";
  return `${source} · ${messageCount} messages · ${toolCount} tools`;
}

function summarizeSystemPrompt(prompt = "", requestedSkillName) {
  const lines = prompt
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("<") && !line.startsWith("</"))
    .slice(0, 6);
  if (requestedSkillName) {
    lines.unshift(`Forced skill: /${requestedSkillName}`);
  }
  return lines.length ? lines : ["System prompt captured. Open raw view for full content."];
}

function extractLatestUserQuery(messages = []) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    return (message.content || []).map(contentToText).join("\n\n");
  }
  return "";
}
