# Copy 修复 + Timeline Export · 技术开发文档

| 项 | 值 |
|---|---|
| 文档类型 | 技术开发文档（TDD） |
| 状态 | 待评审 |
| 范围 | 前端（web/public + web/__tests__） |
| 后端改造 | 无 |
| 缓存版本 | `trace-lens-workbench-69 → 70` |
| 关联文档 | `canonical-graph-unification-plan.md`（已完成） |

---

## 一、需求与现状分析

### 1.1 用户报告问题

> "在 output 区域 Copy 按钮位置进行多次导出操作后，copy 功能似乎不生效。另外，需要在 timeline 区域也新增一个 export 功能。"

### 1.2 现状代码

**Copy 现状** [trace-export.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/trace-export.js#L5-L18)

```js
export async function copyTraceExport() {
  const text = buildSelectedTraceExport();
  if (!text.trim()) { setExportStatus("Nothing to copy"); return; }
  try {
    await navigator.clipboard.writeText(text);
    setExportStatus("Copied");
  } catch {
    downloadText(text, exportFileName());            // ← 静默吞错
    setExportStatus("Clipboard blocked, downloaded");
  }
}
```

DOM：[index.html:104](file:///Users/bytedance/Documents/Codex/helixent/web/public/index.html#L104) `<button id="copyTrace">`，[index.html:95-102](file:///Users/bytedance/Documents/Codex/helixent/web/public/index.html#L95-L102) `<select id="exportRange">`。

绑定：[session.js:48-49](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/session.js#L48-L49)。

**Timeline 现状** [index.html:134-164](file:///Users/bytedance/Documents/Codex/helixent/web/public/index.html#L134-L164)

`aside.timeline-pane` 仅含 Run Metrics + filter-pills + `<div id="timeline">`，**无任何 copy/export 入口**。

可识别组件类型来自 [timeline.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/timeline.js)：
- 容器：`session / run / agent_execution / react_step / phase`
- Phase：`user_input / prompt_phase / skills / memory / model_call / tool_planning / tool_execution / mcp / human_gate / todo / errors / unscoped`
- Event 类别：`user / hook / model / tool / human / skill / prompt / todo / error / memory / mcp / session`

**可复用资产** [export.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/export.js)
- `selectRowsForRange(rows, range)`、`buildRawJsonl(rows)`、`renderTimelineRow(row, idx)`、`shouldExportTimeline(row)`

### 1.3 Bug 根因分析（"多次导出后 copy 失效"）

| # | 根因 | 触发链 |
|---|------|--------|
| R-1 | **document focus 丢失** | 点 Export → `<a download>.click()` → Firefox/Safari/严格隐私模式让 document 失焦 → 紧接着点 Copy → `clipboard.writeText` 抛 `NotAllowedError: Document is not focused` |
| R-2 | **catch 静默 fallback 到下载** | 用户感受是"我点 Copy 但什么都没复制" |
| R-3 | **`setExportStatus` timer 串扰** | 多次点击产生多个 setTimeout，回调以 `textContent === message` 比对清空，旧 timer 可能误清新状态 |
| R-4 | **select 失焦** | 操作 `<select id="exportRange">` 后立即点 Copy 同样可能失焦 |
| R-5 | **零测试覆盖** | 现有 [frontend-export.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-export.test.ts) 仅覆盖纯 builder，无 copy 路径 |

---

## 二、升级点（Feature Upgrades）

| ID | 升级 | 说明 |
|----|------|------|
| **U-1** | Timeline 区新增 Copy/Export 入口 | 与 output 区视觉对齐，但维度更丰富 |
| **U-2** | Timeline 导出三维：Range × Format × Filter | 对应 timeline 自身组件多样性 |
| **U-3** | Timeline 三种 Format | `markdown`（树形层级）/ `csv`（扁平分析）/ `jsonl`（原始事件） |
| **U-4** | Timeline 导出与现有 filter-pill 联动 | 切到 Tools pill → 导出 ⊂ 当前可见 |
| **U-5** | 文件名规则统一 | `helixent-timeline-<traceId>-<range>.<ext>` |

---

## 三、修复点（Bug Fixes）

| ID | 修复 | 对应根因 |
|----|------|----------|
| **B-1** | 三段 fallback：`async clipboard` → `execCommand("copy")` → 下载 | R-1, R-2 |
| **B-2** | 主路径前先 `document.hasFocus?.()` 短路检查 | R-1 |
| **B-3** | `setExportStatus` 用 module-scope token 替代 `textContent` 比对，解决 timer 串扰 | R-3 |
| **B-4** | catch 不再静默吞错，区分 `Copied` / `Clipboard blocked, downloaded` 两种 status | R-2 |
| **B-5** | 新增 [frontend-clipboard.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-clipboard.test.ts) C1-C4 覆盖三段 fallback | R-5 |

---

## 四、改造范围（Impact Scope）

### 4.1 文件清单

| 文件 | 类型 | 变更概要 |
|------|------|----------|
| [web/public/app/trace-export.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/trace-export.js) | 修改 | 抽出 `copyTextWithFallback` / `setStatusOn` / `downloadText` 为命名导出；改写 `copyTraceExport` |
| [web/public/app/timeline-export.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/timeline-export.js) | 新建 | timeline 区 controller |
| [web/public/timeline-export-builder.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/timeline-export-builder.js) | 新建 | 纯函数 markdown/csv/jsonl builder |
| [web/public/index.html](file:///Users/bytedance/Documents/Codex/helixent/web/public/index.html) | 修改 | 新增 `.timeline-export-row` DOM + cache v70 |
| [web/public/app/state.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/state.js) | 修改 | `els` 新增 5 个 DOM 引用 |
| [web/public/app/session.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/session.js) | 修改 | bindEvents 追加 2 行 + import |
| [web/public/styles/timeline.css](file:///Users/bytedance/Documents/Codex/helixent/web/public/styles/timeline.css) | 修改 | `.timeline-export-row` 样式 |
| [web/__tests__/frontend-clipboard.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-clipboard.test.ts) | 新建 | C1-C4 |
| [web/__tests__/frontend-timeline-export.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-timeline-export.test.ts) | 新建 | T1-T6 |

### 4.2 接口契约

**保持不变**（向后兼容）：
- `buildTraceExport / selectRowsForRange / buildRawJsonl / buildTraceMarkdown` — 现有 5 条 [frontend-export.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-export.test.ts) 全部保形
- `copyTraceExport / downloadTraceExport` 对外签名不变
- `els` 仅追加，不删除

**新增对外 API**：
```ts
// trace-export.js（新增 named exports）
export function copyTextWithFallback(text: string):
  Promise<{ ok: boolean; via?: "clipboard" | "execCommand" }>;
export function setStatusOn(el: HTMLElement, message: string): void;
// downloadText 已是 named export，保留

// timeline-export-builder.js（新建）
export function buildTimelineExport(rows: any[], options: {
  range?: "last-1" | "last-3" | "full";
  format?: "markdown" | "csv" | "jsonl";
  filter?: "all" | "hooks" | "model" | "tools" | "human";
  session?: { sessionId?: string; cwd?: string; model?: string };
  traceId?: string;
  generatedAt?: string;
}): string;
export function timelineExportFileName(
  format: "markdown" | "csv" | "jsonl",
  ctx: { traceId?: string; range?: string }
): string;
```

### 4.3 用户行为变化

| 区域 | 变化 |
|------|------|
| Output Copy | 失败率显著下降；失败时 status 仍提示并下载 |
| Timeline | 新增 5 个控件（2 select + 2 button + 1 status span），不影响既有 filter-pill |
| 缓存 | 用户首次刷新会重新拉 v70 资源 |

### 4.4 不在范围（Out of Scope）

- 服务端导出 API
- 多 trace 批量导出
- timeline export 实时 SSE 增量
- 导出加密 / 签名

---

## 五、前端变更（Frontend Changes）

### 5.1 [trace-export.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/trace-export.js) — 三段 fallback + 复用工具

```js
// 三段 fallback：async clipboard → execCommand → 失败
export async function copyTextWithFallback(text) {
  if (typeof document !== "undefined"
      && document.hasFocus?.()
      && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return { ok: true, via: "clipboard" };
    } catch { /* fall through */ }
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    Object.assign(ta.style, { position: "fixed", top: "-9999px", opacity: "0" });
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand?.("copy") === true;
    ta.remove();
    if (ok) return { ok: true, via: "execCommand" };
  } catch { /* fall through */ }
  return { ok: false };
}

// status 改为 token 化，避免多次点击 timer 串扰
const statusTokens = new WeakMap();
export function setStatusOn(el, message) {
  if (!el) return;
  const token = (statusTokens.get(el) || 0) + 1;
  statusTokens.set(el, token);
  el.textContent = message;
  window.setTimeout(() => {
    if (statusTokens.get(el) === token) el.textContent = "";
  }, 2500);
}

export async function copyTraceExport() {
  const text = buildSelectedTraceExport();
  if (!text.trim()) return setStatusOn(els.exportStatus, "Nothing to copy");
  const r = await copyTextWithFallback(text);
  if (r.ok) return setStatusOn(els.exportStatus, "Copied");
  downloadText(text, exportFileName());
  setStatusOn(els.exportStatus, "Clipboard blocked, downloaded");
}

// setExportStatus 改为 setStatusOn(els.exportStatus, msg) 的薄包装（兼容现有调用）
export function setExportStatus(message) {
  setStatusOn(els.exportStatus, message);
}
```

### 5.2 [timeline-export-builder.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/timeline-export-builder.js) — 纯函数 builder（新建）

```js
import { selectRowsForRange, buildRawJsonl } from "./export.js";
import { buildTimelineGraph } from "./view/timeline.js";
import { compactTimelineEvents, shouldShowTimelineEvent } from "./view/timeline-legacy.js";

export function buildTimelineExport(rows = [], options = {}) {
  const range = options.range || "last-1";
  const format = options.format || "markdown";
  const filter = options.filter || "all";

  const scoped = selectRowsForRange(rows, range);
  const events = scoped.filter((r) => r?.kind);
  const compacted = compactTimelineEvents(events);
  const visible = compacted.filter((e) => shouldShowTimelineEvent(e, filter));

  if (format === "jsonl") return buildRawJsonl(visible);
  if (format === "csv")   return renderTimelineCSV(visible, options);
  return renderTimelineMarkdown(visible, { ...options, range, filter });
}

export function timelineExportFileName(format, { traceId, range } = {}) {
  const id = (traceId || "trace").replace(/[^a-z0-9_-]/gi, "-");
  const r  = (range   || "last-1").replace(/[^a-z0-9_-]/gi, "-");
  const ext = format === "csv" ? "csv" : format === "jsonl" ? "jsonl" : "md";
  return `helixent-timeline-${id}-${r}.${ext}`;
}
```

**Markdown** — 走 `buildTimelineGraph(visible)` 拿到 `roots`，递归输出 run/agent/step/phase/event 树形：

```
# Helixent Timeline Export
- Range: Last 1 run · Format: Markdown · Filter: all
- Generated: 2026-05-23T10:00:00Z

## Run 1 (req-A) — success · 12.4s
  ### Lead agent — success · 11.2s
    #### Step 1 — success
      ##### [user_input]
        - user_message — "hello" @ 10:00:00
      ##### [model_call]
        - hook_triggered (beforeModel) @ 10:00:01
      ##### [tool_planning]
        - tool_call_detected (bash, tu-shared) @ 10:00:02
      ##### [tool_execution]
        - tool_execution_started (bash) @ 10:00:03
```

**CSV** — 扁平 event 行：

```
at,kind,category,agentId,step,phase,label,detail
2026-05-23T10:00:00Z,user_message,user,lead,1,user_input,"User message","hello"
2026-05-23T10:00:01Z,hook_triggered,hook,lead,1,model_call,beforeModel,
```

CSV escape 规则：含 `,` / `"` / `\n` 字段加双引号；`"` 转 `""`；单字段超 500 字符截断为 `…(truncated)`（R-3 的字段防爆）。

**JSONL** — 直接 `buildRawJsonl(visible)`。

### 5.3 [timeline-export.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/timeline-export.js) — controller（新建）

```js
import { state, els } from "./state.js";
import {
  buildTimelineExport, timelineExportFileName,
} from "../timeline-export-builder.js";
import {
  copyTextWithFallback, downloadText, setStatusOn,
} from "./trace-export.js";

function buildSelected() {
  return buildTimelineExport(state.traceRows, {
    range: els.timelineExportRange.value || "last-1",
    format: els.timelineExportFormat.value || "markdown",
    filter: els.timelineFilter.value || "all",
    session: state.session,
    traceId: state.currentTraceId,
  });
}
const fmt = () => els.timelineExportFormat.value || "markdown";
const rng = () => els.timelineExportRange.value || "last-1";

export async function copyTimelineExport() {
  const text = buildSelected();
  if (!text.trim()) return setStatusOn(els.timelineExportStatus, "Nothing to copy");
  const r = await copyTextWithFallback(text);
  if (r.ok) return setStatusOn(els.timelineExportStatus, "Copied");
  downloadText(text, timelineExportFileName(fmt(), { traceId: state.currentTraceId, range: rng() }));
  setStatusOn(els.timelineExportStatus, "Clipboard blocked, downloaded");
}

export function downloadTimelineExport() {
  const text = buildSelected();
  downloadText(text, timelineExportFileName(fmt(), { traceId: state.currentTraceId, range: rng() }));
  setStatusOn(els.timelineExportStatus, "Exported");
}
```

### 5.4 [index.html](file:///Users/bytedance/Documents/Codex/helixent/web/public/index.html) — DOM + cache

在 `timeline-header` `<div class="timeline-header-row">` 之后追加：

```html
<div class="timeline-export-row">
  <select id="timelineExportRange" class="inline-select" title="Timeline export range">
    <option value="last-1">Last 1 run</option>
    <option value="last-3">Last 3 runs</option>
    <option value="full">Full session</option>
  </select>
  <select id="timelineExportFormat" class="inline-select" title="Timeline export format">
    <option value="markdown">Markdown (tree)</option>
    <option value="csv">CSV (flat)</option>
    <option value="jsonl">Raw JSONL</option>
  </select>
  <button id="copyTimeline" class="ghost-button mini-button" type="button">Copy</button>
  <button id="exportTimeline" class="ghost-button mini-button" type="button">Export</button>
  <span id="timelineExportStatus" class="export-status" aria-live="polite"></span>
</div>
```

CSS / JS cache：`v=trace-lens-workbench-69` → `v=trace-lens-workbench-70`（两处）。

### 5.5 [state.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/state.js) — els 注册

```js
copyTimeline:           $("copyTimeline"),
exportTimeline:         $("exportTimeline"),
timelineExportRange:    $("timelineExportRange"),
timelineExportFormat:   $("timelineExportFormat"),
timelineExportStatus:   $("timelineExportStatus"),
```

### 5.6 [session.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/session.js) — 事件绑定

`bindEvents()` 末尾追加：

```js
els.copyTimeline.addEventListener("click", copyTimelineExport);
els.exportTimeline.addEventListener("click", downloadTimelineExport);
```

import：

```js
import { copyTimelineExport, downloadTimelineExport } from "./timeline-export.js";
```

### 5.7 [timeline.css](file:///Users/bytedance/Documents/Codex/helixent/web/public/styles/timeline.css) — UI

```css
.timeline-export-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px 8px;
  flex-wrap: wrap;
}
.timeline-export-row .inline-select { min-width: 110px; }
.timeline-export-row .export-status { font-size: 12px; opacity: 0.7; }
```

---

## 六、后端变更（Backend Changes）

**无后端改动。** 所有逻辑纯前端，复用现有 `state.traceRows`（已包含 SSE 实时流）。

---

## 七、测试方案（Test Plan）

### 7.1 新增 [frontend-clipboard.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-clipboard.test.ts)

| ID | 用例 | mock |
|----|------|------|
| C1 | document 失焦时跳过 navigator.clipboard，走 execCommand 成功 | `document.hasFocus = () => false` + `execCommand` spy 返回 true |
| C2 | clipboard.writeText 抛 NotAllowedError 时降级 execCommand | `clipboard.writeText` reject + `execCommand` spy true |
| C3 | 两条都失败时返回 `{ ok: false }` | 两条都失败 |
| C4 | 连续 3 次成功调用，textarea DOM 不残留（断言 `document.querySelectorAll("textarea").length === 0`） | 全 mock 成功 |

### 7.2 新增 [frontend-timeline-export.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-timeline-export.test.ts)

| ID | 用例 |
|----|------|
| T1 | markdown format 包含 `## Run`、`### Lead agent`、`#### Step`、`##### [phase]` 树形且 phase 顺序固定 |
| T2 | csv format 第一行 `at,kind,category,agentId,step,phase,label,detail`；正确转义 `,` `"` `\n` |
| T3 | jsonl format 与 `buildRawJsonl(visible)` 完全等价 |
| T4 | range=last-1 截到最后一个 user run（与 selectRowsForRange 一致） |
| T5 | filter=tools 仅保留 tool 类 events（hook/model 被滤掉） |
| T6 | timelineExportFileName 含 traceId + range，扩展名按 format 切换 (md/csv/jsonl) |

### 7.3 回归（不动测试，全部保形）

- [frontend-export.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-export.test.ts) 5 条
- [frontend-link-anchors.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-link-anchors.test.ts) 6 条
- [frontend-canonical-graph.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-canonical-graph.test.ts) 6 条
- [frontend-view.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-view.test.ts) 全部
- 其余 trace/skills/server/anthropic 测试

### 7.4 手动验证

1. `bun run dev`，发起 1 个 user query → 让 agent 触发 ≥1 个 tool_use
2. **output Copy**：连续 5 次 Export → Copy → Export → Copy → Copy，每次都应显示 `Copied` 且粘贴内容正确
3. **output Copy 失焦场景**：Firefox 下重复步骤 2，验证 execCommand fallback 生效
4. **timeline markdown**：last-1 + markdown + filter=all → Copy → 粘贴看树形
5. **timeline csv**：format=csv → Export → Numbers/Excel 打开，列正确
6. **timeline jsonl**：format=jsonl → Copy → JSON.parse 每行通过
7. **filter 联动**：切到 Tools pill → Export markdown → 仅 tool 类 events
8. **空 traceRows**：开新 session 立刻 Copy → status `Nothing to copy`

### 7.5 自动化质量 gate

```bash
bun run check    # types + lint + tests，目标 ≥208 条全过
```

预期：现有 198 + 新增 ≥10（C1-C4 + T1-T6）= ≥208。

### 7.6 测试覆盖矩阵

| 维度 | 单测 | 手动 |
|------|------|------|
| Copy 三段 fallback | C1-C4 | 步骤 2-3 |
| Markdown 树形 | T1 | 步骤 4 |
| CSV 转义 | T2 | 步骤 5 |
| JSONL | T3 | 步骤 6 |
| Range 截取 | T4 | — |
| Filter 联动 | T5 | 步骤 7 |
| 文件名规则 | T6 | 步骤 5/6 |
| 空数据 | — | 步骤 8 |

---

## 八、决策记录

| ID | 决策 | 备选 | 理由 |
|----|------|------|------|
| D-1 | Copy 三段 fallback | 仅修 status timer | 用户选；R-1/R-2 都需要解决 |
| D-2 | Timeline 三维（Range × Format × Filter） | 单按钮 raw jsonl | 用户要求"复杂一点"，对应组件多样性 |
| D-3 | Format 三选一（md/csv/jsonl） | md+jsonl 二选 | csv 服务于离线分析场景 |
| D-4 | Filter 沿用 timelineFilter | 单独 select | 避免与 filter-pill 行为冲突 |
| D-5 | builder 放 web/public/ 同 export.js | 放 view/ | 与 export.js 同为纯前端 view 工具 |
| D-6 | copyTextWithFallback 在 trace-export.js 导出 | 单独建 clipboard.js | 减少模块数；trace-export 已是 copy 路径源头 |
| D-7 | csv 仅扁平 event 行 | 含容器层级 | markdown 已覆盖容器；csv 服务分析 |
| D-8 | 字段超 500 字符截断 | 不截断 | 避免单 event detail 撑爆 csv |
| D-9 | cache v69 → v70 | 不动 | CSS+JS 同步刷新 |

---

## 九、风险与缓解

| ID | 风险 | 影响 | 缓解 |
|----|------|------|------|
| Risk-1 | `document.execCommand("copy")` 已 deprecated | Chromium 未来移除 | 仅作 fallback；主路径 async clipboard；监控 console warn |
| Risk-2 | jsdom 不实现 `document.execCommand` | C1-C2 无法直接跑 | 测试中 spy 注入 `document.execCommand = mock` |
| Risk-3 | csv 字段含图片 dataURL | csv 巨大 | D-8 单字段截断 |
| Risk-4 | timelineExportRange="full" 在 1k+ rows session 卡顿 | 阻塞主线程 | 后续如有报告再加 worker；当前不在 scope |
| Risk-5 | 用户切 filter-pill 后期望立刻看到 export 预览 | 当前实现是点 Copy 才生成 | 文档说明；不做实时 preview |

---

## 十、实施顺序（S1-S9）

| 步骤 | 内容 | 依赖 |
|------|------|------|
| S1 | 改 [trace-export.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/trace-export.js)：抽 `copyTextWithFallback` / `setStatusOn`，改写 `copyTraceExport` | — |
| S2 | 新增 [frontend-clipboard.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-clipboard.test.ts) C1-C4 | S1 |
| S3 | 新增 [timeline-export-builder.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/timeline-export-builder.js) | — |
| S4 | 新增 [frontend-timeline-export.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-timeline-export.test.ts) T1-T6 | S3 |
| S5 | 新增 [timeline-export.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/timeline-export.js) controller | S1, S3 |
| S6 | 改 [index.html](file:///Users/bytedance/Documents/Codex/helixent/web/public/index.html) 加 DOM + cache v70 | — |
| S7 | 改 [state.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/state.js) + [session.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/session.js) 注册 + 绑事件 | S5, S6 |
| S8 | 改 [timeline.css](file:///Users/bytedance/Documents/Codex/helixent/web/public/styles/timeline.css) `.timeline-export-row` | S6 |
| S9 | `bun run check` 全绿 | 所有 |

---

## 十一、验收标准

| ID | 标准 | 验证方式 |
|----|------|----------|
| A-1 | output 区连续点 Export+Copy 5 次仍能复制成功 | 手动 7.4 步骤 2 |
| A-2 | Copy 失败时 status 显示 `Clipboard blocked, downloaded` 且文件下载 | C3 + 手动模拟失败 |
| A-3 | timeline 三种 format 都能产出可用文本 | T1-T3 + 手动 4-6 |
| A-4 | filter=tools 时导出仅含 tool 类 events | T5 + 手动 7 |
| A-5 | 文件名规则正确（`helixent-timeline-<id>-<range>.<ext>`） | T6 |
| A-6 | `bun run check` ≥208 条全过 | S9 |
