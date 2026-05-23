# 右侧 Timeline 与 Run Metrics 布局优化开发文档

## Summary

本次改造目标是释放右侧栏空间，让 `Hook & Tool Timeline` 从当前屏幕左下/右栏下方被挤压的位置上移，并减少右侧栏常驻模块的重复信息。

执行范围限定在 Web 前端布局和渲染逻辑：

- 删除右侧 `Tasks` 常驻 section。
- 删除右侧 `Prompt Assembly` 常驻 section。
- 将 Prompt Assembly 中有价值的 diff / 全局统计信息合并进 `Run Metrics`。
- 将 `Run Metrics` 改成更紧凑的卡片样式，并加折叠功能。
- 保持 `Hook & Tool Timeline` 的数据来源、筛选能力和渲染逻辑不变，只调整布局位置。

不改后端接口，不改 SSE event，不改 trace 文件结构，不改 agent loop。

## Current State Analysis

### 当前 DOM 布局

相关文件：`web/public/index.html`

右侧栏当前结构在 `aside.timeline-pane` 内：

```html
<aside class="timeline-pane">
  <section class="trace-card todo-card">
    <div class="card-title">Tasks</div>
    <div id="todoPanel" class="task-list empty-state">No tasks yet.</div>
  </section>

  <section class="trace-card run-card">
    <div class="card-title">Run Metrics</div>
    <div id="runMetrics" class="metrics-grid"></div>
  </section>

  <section class="trace-card prompt-diff-card">
    <div class="card-title">Prompt Assembly</div>
    <div id="promptDiffPanel" class="prompt-diff-panel empty-state">No prompt diff yet.</div>
  </section>

  <div class="pane-title">
    <span>Hook & Tool Timeline</span>
    <select id="timelineFilter" class="inline-select sr-only">...</select>
  </div>
  <div class="timeline-tabs">...</div>
  <div id="timeline" class="timeline"></div>
</aside>
```

问题：

- `Tasks`、`Run Metrics`、`Prompt Assembly` 三块都在 Timeline 上方常驻，占用右侧栏垂直空间。
- `Tasks` 在无任务时仍显示一整块空卡片，当前选中的 section 就是这块。
- `Prompt Assembly` 与中间 Request / Prompt Lab 区域的信息重复，常驻右侧收益低。
- `Run Metrics` 的 `.metric-card` 当前是大卡片样式，每个指标 padding 较大，导致卡片整体高度偏高。

### 当前样式

相关文件：`web/public/styles.css`

右侧栏：

```css
.workspace {
  grid-template-columns: 300px minmax(0, 1fr) 360px;
}

.timeline-pane {
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow: hidden;
}

.timeline {
  flex: 1;
  min-height: 0;
}
```

Run Metrics：

```css
.prompt-diff-summary-grid,
.metrics-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.metric-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
}

.metric-value {
  font-size: 18px;
  font-weight: 800;
}
```

问题：

- Timeline 本身 `flex: 1` 是正确的，但前面模块太多，剩余高度不足。
- Metrics 的二维大卡片不适合右侧栏常驻摘要。

### 当前前端数据流

相关文件：`web/public/app.js`

Run Metrics 渲染：

```js
function renderRunState() {
  const status = View.formatProgressStatus(state.progress, state.replaying);
  els.progressStatus.textContent = status;
  els.progressStatus.dataset.status = status.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  els.runMetrics.innerHTML = View.renderMetricsHTML(state.events, state.progress, state.requestMetrics);
}
```

Prompt Assembly 渲染：

```js
function renderRequest() {
  const rendered = View.renderRequestHTML(...);
  state.requestMetrics = rendered.metrics || [];
  els.inputContext.innerHTML = rendered.body;
  renderPromptDiff(rendered.diff);
}

function renderPromptDiff(html) {
  if (!els.promptDiffPanel) return;
  els.promptDiffPanel.innerHTML = html || View.renderPromptDiffPanelHTML();
}
```

Tasks 渲染：

```js
function renderTodoPanel() {
  if (!els.todoPanel) return;
  els.todoPanel.innerHTML = View.renderTasksHTML(state.todos, state.events);
}
```

结论：

- 删除 `promptDiffPanel` DOM 后，`renderPromptDiff()` 已有判空，不会报错。
- 删除 `todoPanel` DOM 后，`renderTodoPanel()` 已有判空，不会报错。
- `todo_update` 事件仍会进入 `state.events` 和 Timeline，不会丢失 trace 数据。
- 不需要改后端。

### 当前 View Helpers

相关文件：`web/public/view.js`

`renderMetricsHTML(events, progress, requestMetrics)` 当前输出：

- Status
- Input tokens
- Output tokens
- Tool calls
- Hooks
- `requestMetrics`

`renderRequestHTML()` 当前返回的 `metrics` 偏 request 状态：

- Prompt
- Version
- Visible tools
- Mode

`renderPromptDiffPanelHTML()` / `renderPromptDiffSummaryItem()` 当前可计算并展示 diff 信息：

- System changed / unchanged
- Messages count
- Tools + / -
- Skill changed / unchanged

用户确认：Run Metrics 合并信息时应偏向展示 diff 和全局统计量；tools 可不用重复强调，因为 Agent Output 下已有 Tools available。

## Proposed Changes

### 1. 删除右侧 `Tasks` section

文件：`web/public/index.html`

删除：

```html
<section class="trace-card todo-card">
  <div class="card-title">Tasks</div>
  <div id="todoPanel" class="task-list empty-state">No tasks yet.</div>
</section>
```

原因：

- 用户确认该区域可以删除。
- 无任务时长期占位。
- todo 数据仍可保留在 `state.events`、Timeline、trace export，不需要右侧常驻卡片。

实现注意：

- `app.js` 中 `els.todoPanel` 可保留为 `$("todoPanel")`，值为 `null`。
- `renderTodoPanel()` 已有 `if (!els.todoPanel) return;`，不需要强行删除函数。
- `renderTodo(todos)` 仍应保留 `state.todos`、`createTodoTraceEvent()`、`renderTimeline()`、`renderRunState()`，避免破坏 timeline/export。

### 2. 删除右侧 `Prompt Assembly` section

文件：`web/public/index.html`

删除：

```html
<section class="trace-card prompt-diff-card">
  <div class="card-title">Prompt Assembly</div>
  <div id="promptDiffPanel" class="prompt-diff-panel empty-state">No prompt diff yet.</div>
</section>
```

原因：

- 该区域与中间 Request / Prompt Lab 的 prompt diff 和 request package 能力重复。
- 常驻右侧占用 Timeline 空间。

实现注意：

- `app.js` 的 `renderPromptDiff(html)` 已有 `if (!els.promptDiffPanel) return;`，删除 DOM 后不会报错。
- 不删除 `renderPromptDiffPanelHTML()`、`renderPromptDiff()`、`splitAssembledPrompt()` 等 helper，因为中间 Prompt Lab / tests / export 仍可能使用。
- 不删除 `.prompt-diff-*` 通用样式，除非确认没有其他调用；第一期只删除右侧 DOM。

### 3. 将 diff 和全局统计合并进 `Run Metrics`

文件：`web/public/view.js`

调整 `renderRequestHTML()` 返回的 `metrics` 内容，让 `state.requestMetrics` 更适合右侧 `Run Metrics`：

当前偏状态：

```js
const metrics = [
  { label: "Prompt", value: ... },
  { label: "Version", value: ... },
  { label: "Visible tools", value: ... },
  { label: "Mode", value: ... },
];
```

改为偏 diff + 全局统计：

```js
const metrics = [
  { label: "Prompt diff", value: "changed" | "unchanged" | "baseline missing" },
  { label: "Messages", value: "0 -> 1" },
  { label: "Tool diff", value: "+0 / -1" },
  { label: "Skill diff", value: "changed" | "unchanged" },
  { label: "Prompt source", value: "Draft" | "Runtime" | "Version" },
  { label: "Mode", value: "Live" | "Replay" },
];
```

建议实现方式：

- 新增纯函数 `buildRequestMetricItems({ current, runtime, activeVersion, promptSource, replaying })`。
- 内部复用已有 `summarizePromptDiff(runtime, current || runtime)`。
- 如果 `runtime` 不存在：
  - `Prompt diff = baseline missing`
  - `Messages = String(messages.length)`
  - `Tool diff = n/a`
  - `Skill diff = n/a`
- 如果有 runtime：
  - `Prompt diff = summary.systemChanged ? "changed" : "unchanged"`
  - `Messages = `${left} -> ${right}``
  - `Tool diff = `+${added} / -${removed}``
  - `Skill diff = summary.skillChanged ? "changed" : "unchanged"`

注意：

- 不再在 Run Metrics 里重复展示 `Visible tools` 作为主指标，因为用户明确提到 tools 已经在 Agent Output 下有 `Tools available`。
- `Tool calls` 仍保留，这是运行时统计，不是 tool inventory。

### 4. 优化 `Run Metrics` 卡片为紧凑样式

文件：`web/public/styles.css`

目标：

- 让 Run Metrics 变成小型 key/value 网格或列表。
- 减少每个指标高度，避免继续挤压 Timeline。

建议 CSS：

```css
.run-card {
  padding: 10px 12px;
}

.run-card .metrics-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}

.run-card .metric-card {
  gap: 2px;
  padding: 7px 8px;
  border-radius: 10px;
}

.run-card .metric-label {
  font-size: 10px;
}

.run-card .metric-value {
  font-size: 13px;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

说明：

- 只作用于 `.run-card` 内的 metrics，不影响其他地方的 `.metric-card`。
- 右侧宽度 360px 下，3 列可以显著压缩高度；如果实际过挤，可在实现时降为 2 列但仍保持小 padding。

### 5. 给 `Run Metrics` 增加折叠功能

文件：`web/public/index.html`

将当前：

```html
<section class="trace-card run-card">
  <div class="card-title">Run Metrics</div>
  <div id="runMetrics" class="metrics-grid"></div>
</section>
```

改成原生 `details`：

```html
<details class="trace-card run-card" open>
  <summary class="card-title run-metrics-summary">
    <span>Run Metrics</span>
    <span class="run-metrics-toggle">Collapse</span>
  </summary>
  <div id="runMetrics" class="metrics-grid"></div>
</details>
```

原因：

- 原生 `details/summary` 不需要额外 JS。
- 默认展开，满足当前可见性；用户可手动折叠释放更多 Timeline 空间。

CSS：

```css
.run-card summary {
  list-style: none;
  cursor: pointer;
}

.run-card summary::-webkit-details-marker {
  display: none;
}

.run-metrics-toggle::before {
  content: "Collapse";
}

.run-card:not([open]) .run-metrics-toggle::before {
  content: "Expand";
}
```

注意：

- 不做 localStorage 持久化，第一期避免过度设计。
- 如果后续用户希望折叠状态跨刷新保留，再加 `toggle` listener。

### 6. Hook & Tool Timeline 上移

文件：`web/public/index.html`

删除 `Tasks` 和 `Prompt Assembly` 后，右侧栏结构变成：

```html
<aside class="timeline-pane">
  <details class="trace-card run-card" open>
    <summary class="card-title run-metrics-summary">
      <span>Run Metrics</span>
      <span class="run-metrics-toggle"></span>
    </summary>
    <div id="runMetrics" class="metrics-grid"></div>
  </details>

  <div class="pane-title timeline-title-row">
    <span>Hook & Tool Timeline</span>
    <select id="timelineFilter" class="inline-select sr-only">...</select>
  </div>
  <div class="timeline-tabs">...</div>
  <div id="timeline" class="timeline"></div>
</aside>
```

效果：

- Timeline 从第三块卡片之后上移到 Run Metrics 之后。
- 当 Run Metrics 折叠时，Timeline 几乎占满整个右侧栏。

### 7. 前端 JS 保持判空兼容

文件：`web/public/app.js`

需要检查并保持：

```js
function renderPromptDiff(html) {
  if (!els.promptDiffPanel) return;
  els.promptDiffPanel.innerHTML = html || View.renderPromptDiffPanelHTML();
}

function renderTodoPanel() {
  if (!els.todoPanel) return;
  els.todoPanel.innerHTML = View.renderTasksHTML(state.todos, state.events);
}
```

如果实现时发现其他地方直接访问 `els.promptDiffPanel` 或 `els.todoPanel`，必须补判空。

不需要删除：

- `state.todos`
- `renderTodoPanel()`
- `renderTodo()`
- `View.renderTasksHTML()`

原因：

- todo 数据仍用于 trace/timeline/export 或未来入口。
- 删除函数会扩大影响面。

### 8. 测试更新

文件：`web/__tests__/frontend-smoke.test.ts`

更新 shell 测试：

- 应不包含 `id="todoPanel"`。
- 应不包含 `id="promptDiffPanel"`。
- 应不包含 `Prompt Assembly` 右侧 section。
- 应包含 `Run Metrics`。
- 应包含 `id="runMetrics"`。
- 应包含 `Hook & Tool Timeline`。

文件：`web/__tests__/frontend-view.test.ts`

更新或新增 Run Metrics 测试：

- `renderMetricsHTML()` 仍显示 Status / Input / Output / Tool calls / Hooks。
- `renderRequestHTML()` 返回的 `metrics` 包含 diff 倾向指标：
  - Prompt diff
  - Messages
  - Tool diff
  - Skill diff
  - Prompt source
  - Mode
- 不再强依赖 `Visible tools` 出现在 Run Metrics。

如果原测试依赖 `renderTasksHTML()`，保留 helper 单测，因为 helper 不删除。

文件：`web/__tests__/frontend-smoke.test.ts`

Replay smoke 中如果仍调用 `renderTasksHTML()` 单独检查 todo，可保留，因为删除的是右侧 DOM，不是 helper。

## Assumptions & Decisions

- 删除右侧 `Tasks` section：已由用户确认。
- 删除右侧 `Prompt Assembly` section：已由用户确认。
- `Prompt Assembly` 有用字段迁入 `Run Metrics`：以 diff 和全局统计为主，不迁移完整详细 diff HTML。
- `Run Metrics` 默认展开，但用户可折叠。
- 不持久化 Run Metrics 折叠状态。
- Timeline 不合并进 Agent Output Graph。
- 不改后端，不改 trace event，不改 SSE。
- 不删除 todo 数据链路，只删除右侧常驻展示。

## Verification

实现后运行：

```bash
bun test web/__tests__/frontend-view.test.ts
bun test web/__tests__/frontend-smoke.test.ts
bun run check
```

手动验证：

1. 启动 Web：`HELIXENT_HOME=/Users/bytedance/Documents/Codex/helixent/.helixent bun run web/server.ts`。
2. 打开 `http://127.0.0.1:4317`。
3. 确认右侧栏不再显示 `Tasks` 和 `Prompt Assembly`。
4. 确认 `Hook & Tool Timeline` 上移到 `Run Metrics` 下方。
5. 确认 `Run Metrics` 显示更紧凑。
6. 点击 `Run Metrics` 标题，确认可折叠/展开。
7. 发起一次 query，确认 Status / token / tool calls / hooks / prompt diff 类指标正常更新。
8. 打开 replay trace，确认 Timeline filter 仍可切换，hook/tool events 正常显示。

## Change Scope

必改：

- `web/public/index.html`
- `web/public/styles.css`
- `web/public/view.js`
- `web/__tests__/frontend-view.test.ts`
- `web/__tests__/frontend-smoke.test.ts`

可能小改：

- `web/public/app.js`，仅在发现 `todoPanel` / `promptDiffPanel` 还有未判空访问时修改。

不应修改：

- `web/server.ts`
- `web/types.ts`
- `web/trace.ts`
- `src/agent/*`
- `src/foundation/*`
- `src/coding/tools/*`

## Execution Order

1. 修改 `web/public/index.html`，删除 `Tasks` 和 `Prompt Assembly`，将 `Run Metrics` 改为 `details`。
2. 修改 `web/public/styles.css`，增加 `.run-card` 紧凑样式和折叠 summary 样式。
3. 修改 `web/public/view.js`，将 `renderRequestHTML()` 返回的 metrics 调整为 diff + 全局统计导向。
4. 检查 `web/public/app.js` 是否需要补判空。
5. 更新 `frontend-view.test.ts`。
6. 更新 `frontend-smoke.test.ts`。
7. 运行测试和 `bun run check`。
8. 手动检查右侧栏布局。
