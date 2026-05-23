# Graph 数据结构统一化 — 技术开发文档

> 目的：把 chat-thread（左栏 agent output）与 timeline（右栏 hook & tool）所依赖的两套独立 graph 数据结构，收敛为单一 canonical event graph + 两个下游 selector；同时把 link.js 双向联动从 4 个分散 `data-link-*` 属性降级为单一 `data-node-id` 锚点。
>
> 落地路径：用户已确认"完整一次到位（推荐）"+"data-node-id 单一锚点（推荐）"。

---

## 1. 文档元信息

| 字段 | 内容 |
|---|---|
| 关联背景 | plan v3 §11.1 已预言「未来塌缩为 data-node-id」的远期方向；本次把它落地。 |
| 触发场景 | 用户截图反馈：点 user-bubble 时整个 run 全部高亮（无聚焦感）；点 timeline phase 节点完全无反应（phase 没 data-link-* 属性）。 |
| 涉及栈 | 前端：`web/public/view/*`、`web/public/app/link.js`、`web/public/styles/*`、`web/public/index.html`。 |
| **后端涉及** | **无。**`state.events` / `state.traceRows` 形状不变，SSE 协议不变，server 端零改动。 |
| 兼容性目标 | 192 条现有测试除 1 个文件需迁移外，其余形状断言全部保持绿。 |

---

## 2. 现状分析

### 2.1 前端模块拓扑

```
state.events  ─┐
               ├─► [buildAgentOutputGraph]  ──► renderAgentOutputGraph  ──► chat-thread
state.traceRows┤      （web/public/view/agent-output-graph.js）           ▲
               │                                                          │
               └─► [buildTimelineGraph]     ──► renderTimelineHTML    ──► timeline
                      （web/public/view/timeline.js）                     ▲
                                                                          │
                                              [link.js controller] ◄──────┘
                                              （web/public/app/link.js）
```

### 2.2 两套 builder 数据结构对比

| 维度 | [buildTimelineGraph](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/timeline.js#L42) | [buildAgentOutputGraph](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/agent-output-graph.js#L15) |
|---|---|---|
| 输入 | `state.events`（TraceEvent[]） | `state.traceRows`（events ∪ message rows） |
| 顶层 | `roots: [session, run...]` | `runs: [run...]` + `systemErrors[]` |
| 中间层 | `run → agent_execution → react_step → phase → event` | `run → react_step → {thinking, tools, response, errors}` |
| nodeId 命名 | `run:<reqId>` / `agent:<reqId>:<agentId>` / `step:<reqId>:<agentId>:<n>` / `event:<eventId>` | `run:<runIndex>` / `step:<runIndex>:<stepIndex>` / `tool:<toolUseId>` / `item:<rowIndex>:<...>` |
| 下游消费者 | [renderTimelineHTML](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/timeline.js#L398) | [renderAgentOutputGraph](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/agent-output-graph.js#L372) + [renderOutputHTML](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/output-cards.js#L8) |
| 测试断言 | `graph.roots`、`run.title`、`step.step`、`phaseTypes` | `graph.runs`、`graph.systemErrors`、`graph.nodeById["tool:call_1"]`、`run.errors`、`step.tools[0].status` |

**根因**：两套 builder 各算各的 nodeId、各自命名运行单位（一边叫 `runIndex`，一边叫 `requestId`）；导致 link.js 不得不维护 4 个 `data-link-*` 属性 + 复杂 `buildKey` / `selectorFor` 优先级匹配，无法稳定双向联动。

### 2.3 link.js 现有痛点（用户截图触发）

[link.js#L30-L36](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/link.js#L30-L36) 的 `buildKey` 优先级是 `tool > step > agent > run`，但只用第一条命中规则生成 1 个 key：

1. **痛点 A — 全 run 高亮**：用户点 `.user-bubble`（只挂 `data-link-request-id`）→ 生成 `run:<reqId>`，selector `[data-link-request-id="..."]` 把右栏所有该 run 下的 run/agent/step 节点都选中——**视觉上不聚焦**。
2. **痛点 B — phase 不响应**：timeline 的容器层级 `phase` 节点完全没注入 `data-link-*`（仅 event 子节点在数据携带 toolUseId 时才注入 `data-link-tool-id`）→ 用户在 timeline 点 `Tool Execution` phase 完全没反应。

### 2.4 下游消费者解耦情况

- [output-cards.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/output-cards.js)、[output.js#L36-L42](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/output.js#L36-L42)、[export.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/export.js)：均直接消费 `state.traceRows`，**不读 graph 内部 nodeId**。
- export 用 `row.kind / row.requestId` 自行过滤（`isOutputRow` / `shouldExportTimeline`），与 graph 解耦。
- **结论**：nodeId 命名变更对 export / inspect / sent-prompt / TUI 完全无副作用。

### 2.5 现有测试覆盖（必须保持绿）

| 测试文件 | 关键断言 | 本次影响 |
|---|---|---|
| [frontend-view.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-view.test.ts) | `graph.runs[0].steps[0].tools[0].name`、`graph.nodeById["tool:call_1"]`、`run.title === "Run 1"`、`step.step === 1`、`phaseTypes` 顺序 | 不变（selector 形状投影保留） |
| [frontend-error-routing.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-error-routing.test.ts) | `graph.runs.length`、`graph.systemErrors.length`、`run.errors.length` | 不变 |
| [frontend-timeline-user-image.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-timeline-user-image.test.ts) T5/T6 | user_message 落在 user_input phase | 不变 |
| [frontend-link-anchors.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-link-anchors.test.ts) L1-L6 | `data-link-*` 各项 | **整体迁移到 `data-node-id`**（唯一一处期望要改写） |
| `frontend-todo-noise.test.ts` / `frontend-images.test.ts` / `frontend-export.test.ts` / `frontend-smoke.test.ts` | 不读 graph 内部 | 不变 |

---

## 3. 改造方案

### 3.1 前端改造点

#### 3.1.1 [新增] `web/public/view/canonical-graph.js`

唯一真相源。输入 `traceRows`（events ∪ message rows），输出 canonical 树 + 两个 selector。

**节点形状**：

```js
{ type, nodeId, parentId, scopeId, children, ...类型特定字段 }
```

**节点类型**：`root | session | run | agent | step | phase | thinking | tool | response | error | event | message`

**nodeId 命名规则**（稳定、可读、selector 友好）：

| 类型 | nodeId 格式 | 备注 |
|---|---|---|
| run | `run:<requestId>` | requestId 缺失时回退 `run:synthetic-N` |
| agent | `agent:<requestId>:<agentId>` | agentId 默认 `lead` |
| step | `step:<requestId>:<agentId>:<n>` | n 为 1-based ReAct step |
| phase | `phase:<requestId>:<agentId>:<n>:<phase>` | timeline 专属（user_input / thinking / tool_execution / response 等） |
| tool | `tool:<toolUseId>` | **跨视图同一节点**（output 与 timeline 都指它） |
| thinking | `thinking:<runIdx>:<stepIdx>:<k>` | output 专属 |
| response | `response:<runIdx>:<stepIdx>:<k>` | output 专属，最后一条会被打 `isFinal` |
| error | `error:<rowId>` | 跨视图共享 |
| event | `event:<eventId>` | timeline 专属，phase 下细粒度 event |
| message | `message:<requestId>:<role>:<seq>` | user / tool message，跨视图共享 |

**导出 API**：

```js
export function buildCanonicalEventGraph(rows = []) { /* ... */ }
export function selectAgentOutputView(canonical) { /* 投影 → 现有 buildAgentOutputGraph shape */ }
export function selectTimelineView(canonical) { /* 投影 → 现有 buildTimelineGraph shape */ }
```

**职责边界**：
- canonical 阶段：节点装配 + nodeId 计算 + 索引（`byNodeId`）+ run.systemErrors / step.isFinal 标记。
- selector 阶段：形状投影 + 视图特定截断（如 timeline 的 `compactTimelineEvents` / `slice(-160)`）。
- 渲染层零计算：`node.nodeId` / `node.scopeId` 直接拼字符串。

#### 3.1.2 [修改] `web/public/view/agent-output-graph.js`

**a. builder 改为 selector wrapper**：

```js
import { buildCanonicalEventGraph, selectAgentOutputView } from "./canonical-graph.js";

export function buildAgentOutputGraph(rows = [], _options = {}) {
  return selectAgentOutputView(buildCanonicalEventGraph(rows));
}
```

> 保留 `isAgentOutputRow` 导出与全部 render 函数。selector 内部沿用现有装配规则，`graph.runs / graph.systemErrors / graph.nodeById["tool:call_1"]` 等下游断言形状 100% 不变。

**b. 渲染层 attr 切换**（`renderUserTurn / renderAgentTurn / renderTrailItem / renderFinalAnswer`）：

| 节点 | 旧 attr | 新 attr |
|---|---|---|
| `.user-bubble` | `data-link-request-id` | `data-node-id="message:<reqId>:user:<seq>"` + `data-node-scope="run:<reqId>"` |
| `.chat-context-pill` | `data-link-request-id` | 同上（视为 user message 的一种） |
| `.agent-turn` | `data-link-request-id` + `data-link-agent-id` | `data-node-id="agent:<reqId>:lead"` + `data-node-scope="run:<reqId>"` |
| `.reasoning-trail`(details) | `data-link-request-id` | 继承父级 scope，无需自己 `data-node-id`（避免点 summary 区域整段被选） |
| `.trail-thinking` | `data-link-request-id` + `data-link-step` | `data-node-id="thinking:<runIdx>:<stepIdx>:<k>"` + `data-node-scope="step:<reqId>:lead:<n>"` |
| `.trail-tool` | `data-link-request-id` + `data-link-step` + `data-link-tool-id` | `data-node-id="tool:<toolUseId>"` + `data-node-scope="step:<reqId>:lead:<n>"` |
| `.trail-response-inline` | `data-link-request-id` + `data-link-step` | `data-node-id="response:<runIdx>:<stepIdx>:<k>"` + `data-node-scope="step:..."` |
| `.trail-error` | `data-link-request-id` | `data-node-id="error:<rowId>"` + `data-node-scope="run:<reqId>"` |
| `.final-answer` | `data-link-request-id` + `data-link-step` | `data-node-id="response:<runIdx>:<stepIdx>:<k>"`（被标 isFinal 的 response） |

#### 3.1.3 [修改] `web/public/view/timeline.js`

**a. builder 改为 selector wrapper**：

```js
import { buildCanonicalEventGraph, selectTimelineView } from "./canonical-graph.js";

export function buildTimelineGraph(events = []) {
  return selectTimelineView(buildCanonicalEventGraph(events));
}
```

> 保持 `renderTimelineHTML` 签名与所有 helper 不动。frontend-view.test.ts 与 frontend-timeline-user-image.test.ts 的断言（`run.title === "Run 1"` / `step.step === 1` / `phaseTypes`）形状投影后照常 work。

**b. 渲染层 attr 切换**：[timeline.js#L444-L465](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/timeline.js#L444-L465) 的 `timelineLinkAttrs / timelineEventLinkAttrs` 整段替换为：

```js
function timelineLinkAttrs(node) {
  const parts = [];
  if (node.nodeId) parts.push(` data-node-id="${escapeAttr(node.nodeId)}"`);
  if (node.scopeId) parts.push(` data-node-scope="${escapeAttr(node.scopeId)}"`);
  return parts.join("");
}
function timelineEventLinkAttrs(node) {
  return timelineLinkAttrs(node);
}
```

> phase 节点 `nodeId = "phase:<reqId>:<agentId>:<n>:<phaseType>"` + `scopeId = "step:<reqId>:<agentId>:<n>"` —— 修复痛点 B。

#### 3.1.4 [修改] `web/public/app/link.js` — 简化

```js
import { els } from "./state.js";

let activeKey = null;
let chipEl = null;

export function initOutputTimelineLink() {
  if (!els.modelOutput || !els.timeline) return;
  els.modelOutput.addEventListener("click", (e) => onClick(e, "output"));
  els.timeline.addEventListener("click", (e) => onClick(e, "timeline"));
  chipEl = document.getElementById("linkHighlightChip");
  chipEl?.addEventListener("click", () => clearHighlight());
}

function onClick(e, side) {
  const node = e.target.closest("[data-node-id]");
  if (!node) return;
  applyHighlight(node.dataset.nodeId, side);
}

function applyHighlight(nodeId, side) {
  if (activeKey === nodeId) { clearHighlight(); return; }
  document.querySelectorAll(".is-link-highlight, .is-link-scope")
    .forEach(el => el.classList.remove("is-link-highlight", "is-link-scope"));
  activeKey = nodeId;
  updateChip();
  // 强高亮：所有 data-node-id === nodeId 的元素（跨左右栏）
  document.querySelectorAll(`[data-node-id="${cssEscape(nodeId)}"]`).forEach(el => {
    el.classList.add("is-link-highlight");
    if (side === "output") openAncestorDetails(el);
    scrollIntoViewSoft(el);
  });
  // 二级高亮：所有 data-node-scope === nodeId 的元素（该节点 scope 内子节点轻微高亮）
  document.querySelectorAll(`[data-node-scope="${cssEscape(nodeId)}"]`).forEach(el => {
    el.classList.add("is-link-scope");
  });
}
// chip / clearHighlight / cssEscape / openAncestorDetails / scrollIntoViewSoft 保持原样
```

**收益**：
1. controller 复杂度降一半，`buildKey` / `selectorFor` 整段删除。
2. 自动支持新增节点类型（phase / message / error）—— 只要 selector 注入 `data-node-id` 就联动，**不动 controller**。
3. 修复痛点 A / B：点 user-bubble 强高亮只锁该 bubble，二级 scope 微亮该 run；点 phase 强高亮 phase + scope 微亮该 step 内 trail-*。

#### 3.1.5 [修改] CSS

[styles/agent-output-graph.css](file:///Users/bytedance/Documents/Codex/helixent/web/public/styles/agent-output-graph.css) 与 [styles/timeline.css](file:///Users/bytedance/Documents/Codex/helixent/web/public/styles/timeline.css) 各加：

```css
/* 强高亮（已存在，保留） */
.is-link-highlight { outline: 2px solid var(--accent-cyan, #7ac8ff); outline-offset: 2px; }
/* 二级 scope 高亮（新增，淡） */
.is-link-scope { background: rgba(122, 200, 255, 0.04); }
```

#### 3.1.6 [修改] cache busting

[index.html](file:///Users/bytedance/Documents/Codex/helixent/web/public/index.html)：`v=trace-lens-workbench-68 → 69`（CSS + JS 各一处）。

### 3.2 后端改造点

**无。** 本次改动完全在前端 view 层与控制器，不动：
- `state.events` / `state.traceRows` 形状
- SSE 协议 / `handleServerEvent` 逻辑
- TraceKind / TraceEvent 类型定义
- server 端任何文件

### 3.3 数据契约变更摘要

| 契约 | 变化 |
|---|---|
| `buildAgentOutputGraph` 返回 shape | **不变**（selector 投影保留 runs / nodeById / systemErrors） |
| `buildTimelineGraph` 返回 shape | **不变**（selector 投影保留 roots / diagnostics） |
| HTML 节点 dataset | `data-link-request-id / agent-id / step / tool-id` → 单一 `data-node-id` + 可选 `data-node-scope` |
| CSS class 名 | `.is-link-highlight` 保留；新增 `.is-link-scope` |
| 模块导出 | `canonical-graph.js` 新增 3 个导出；其他模块导出不变 |

---

## 4. 功能升级清单

| 编号 | 功能 | 类型 |
|---|---|---|
| F1 | 双向联动从"全 run 全亮"升级为"目标节点强亮 + scope 内微亮"，视觉聚焦 | 体验升级（修 bug） |
| F2 | timeline phase 节点（user_input / thinking / tool_execution / response）支持点击联动 | 新增能力（修 bug） |
| F3 | tool / message / error 类节点跨左右栏共享同一 nodeId，点 output 的 trail-tool 与点 timeline 的对应 event 联动一致 | 一致性升级 |
| F4 | 引入 canonical event graph 作为单一真相源，未来加新视图（如时序图、聚合面板）只需新写 selector | 架构升级 |
| F5 | link.js controller 复杂度降一半（删除 `buildKey` / `selectorFor`） | 可维护性升级 |

---

## 5. 影响范围

### 5.1 文件清单（共 9 个）

| 操作 | 文件 |
|---|---|
| 新增 | `web/public/view/canonical-graph.js` |
| 新增 | `web/__tests__/frontend-canonical-graph.test.ts` |
| 修改 | [agent-output-graph.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/agent-output-graph.js) |
| 修改 | [timeline.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/timeline.js) |
| 修改 | [link.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/link.js) |
| 修改 | [styles/agent-output-graph.css](file:///Users/bytedance/Documents/Codex/helixent/web/public/styles/agent-output-graph.css) |
| 修改 | [styles/timeline.css](file:///Users/bytedance/Documents/Codex/helixent/web/public/styles/timeline.css) |
| 修改 | [index.html](file:///Users/bytedance/Documents/Codex/helixent/web/public/index.html) |
| 修改 | [frontend-link-anchors.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-link-anchors.test.ts) |

### 5.2 接口契约影响

| 对象 | 影响 |
|---|---|
| `buildAgentOutputGraph` / `buildTimelineGraph` 公开 shape | **零影响**（selector 投影保形） |
| `renderOutputHTML(rowsOrEvents, legacyMessagesOrOptions, options)` 签名 | 保留（含 legacy `mergeLegacyOutputRows` 兼容路径） |
| `state.events / state.traceRows` 形状 | 零影响 |
| SSE 事件 / TraceKind | 零影响 |
| export.js / inspect dialog / sent-prompt / TUI | 零影响（不读 graph nodeId） |

### 5.3 用户可见行为影响

| 行为 | 变化 |
|---|---|
| 现有视觉（卡片样式、运行符号、最终答案布局等 plan v3 所有内容） | 不变 |
| 双向联动效果 | 改进（聚焦更精确，phase 节点可点） |
| chip 行为（`🔗 ... ✕`） | 保留，仅 chip 文本依赖的 nodeId 内部改名（用户不可见差异） |
| trace 文件切换时高亮重置 | 不变（innerHTML 重渲染天然清除） |
| 任何 export / inspect / TUI 行为 | 不变 |

### 5.4 测试影响

| 测试 | 影响 |
|---|---|
| `frontend-view.test.ts`（含 `graph.nodeById["tool:call_1"]` / phaseTypes 等） | **零修改**（selector 形状一致） |
| `frontend-error-routing.test.ts` E1-E4 | 零修改 |
| `frontend-timeline-user-image.test.ts` T1-T7 | 零修改 |
| `frontend-todo-noise.test.ts` / `frontend-images.test.ts` / `frontend-export.test.ts` / `frontend-smoke.test.ts` | 零修改 |
| `frontend-link-anchors.test.ts` L1-L6 | **整体迁移**（断言 attr 名换成 `data-node-id` / `data-node-scope`） |
| 新增 `frontend-canonical-graph.test.ts` | **新建 6 条** |

---

## 6. 测试方案

### 6.1 新增单测 — `web/__tests__/frontend-canonical-graph.test.ts`

| 编号 | 用例 |
|---|---|
| C1 | `buildCanonicalEventGraph` 对 run/agent/step/tool 输出稳定 nodeId（多次构建结果一致） |
| C2 | `selectAgentOutputView` 输出的 `graph.runs / graph.nodeById["tool:<id>"] / graph.systemErrors` 与现有契约形状一致 |
| C3 | `selectTimelineView` 输出的 `graph.roots`（含 run/agent/step/phase）与现有契约形状一致 |
| C4 | 同一 `toolUseId` 在 output view 与 timeline view 共享同一 nodeId（核心：`tool:<toolUseId>`），保证联动 |
| C5 | user_message event 在 timeline `phase=user_input` 下，与 output 的 `message:<reqId>:user:<seq>` 同 nodeId（验证 message 节点跨视图共享） |
| C6 | phase 节点带 `nodeId="phase:..."` 与 `scopeId="step:..."`（修复点 phase 不亮的回归断言） |

### 6.2 迁移单测 — `frontend-link-anchors.test.ts`

| 旧断言 | 新断言 |
|---|---|
| `data-link-request-id="req-1"` on `.user-bubble` | `data-node-id` 以 `message:req-1:user:` 开头 + `data-node-scope="run:req-1"` |
| `data-link-agent-id="lead"` on `.agent-turn` | `data-node-id="agent:req-2:lead"` |
| `data-link-tool-id="tu-abc"` on `.trail-tool` | `data-node-id="tool:tu-abc"` |
| `data-link-step="1"` on `.final-answer` | `data-node-id` 以 `response:` 开头 + `data-node-scope="step:req-4:lead:1"` |
| timeline `data-link-request-id="req-5"` 等 | timeline 节点 `data-node-id` / `data-node-scope` 对称 |

### 6.3 回归测试（保持绿）

- `frontend-view.test.ts`：`builds an agent output graph from ReAct rows` / `builds a structured timeline graph` —— 形状投影后断言全过。
- `frontend-error-routing.test.ts`：4 条 case 验证 systemErrors 路由不退化。
- `frontend-timeline-user-image.test.ts`：7 条 case 验证 user_message 落 phase 不退化。
- `frontend-todo-noise.test.ts` / `frontend-images.test.ts` / `frontend-export.test.ts` / `frontend-smoke.test.ts`：与 graph 内部命名解耦，理论零影响。

### 6.4 手动验证

启动 `bun run dev`，目标 trace：

| 场景 | 预期 |
|---|---|
| 发条"你好" → 点左栏 user-bubble | 右栏对应 user_message event 强高亮；同 run 的 run/agent/step/phase 节点 scope 微亮 |
| 多 tool 场景 → 点左栏 trail-tool | 右栏对应 `tool_execution_started/completed` event 强高亮；**同 run 其他 step 不再被全亮**（修复痛点 A） |
| 点右栏 phase 节点（如 Tool Execution） | 左栏对应 step 内的 trail-tool 微亮（scope 命中）（修复痛点 B） |
| 点 chip `✕` | 高亮全清 |
| 切换 trace 文件 | 高亮自动清除 |

### 6.5 质量 gate（一次性跑全）

```bash
bun run check:types       # tsc --noEmit
bun run lint              # ESLint
bun test web              # 192 条 + 新增 6 条 = 198 条全过
bun run check             # 综合 gate（types + lint + test）
```

---

## 7. 假设与决策

| 编号 | 决策 | 理由 |
|---|---|---|
| D1 | 用 `data-node-id`（不用 `data-node-key`） | 与 plan v3 §11.1 forward-compat 表述一致 |
| D2 | scope 高亮深度只取一级（被点节点的 nodeId 作 scope，不递归祖先） | 避免点 step 时整 run 全亮，回到痛点 A |
| D3 | canonical 不落 state | builder 内部即用即弃，避免 state 复杂度 |
| D4 | export.js 不用 canonical | 已与 graph 解耦，保留现状降低范围 |
| D5 | `renderOutputHTML` 签名完全保留（含 legacy `mergeLegacyOutputRows` 兼容路径） | 兼容 |
| D6 | `compactTimelineEvents` 与 `slice(-160)` 放 `selectTimelineView` 阶段，不放 canonical | agent output 不需要这个截断 |
| D7 | `run.index` 取值保持"按 chat-thread 顺序 1..N"，与 `requestId` 解耦 | synthetic 场景兜底 |
| D8 | 缺 requestId 的 event 走 `run:synthetic-N` fallback nodeId | 与现有 timeline synthetic-N 一致 |

---

## 8. Out of Scope

- 不引入新的服务端事件 / TraceKind。
- 不改 `state.events` / `state.traceRows` 形状。
- 不动 export.js / inspect dialog / sent-prompt / system-errors / TUI。
- 不改 plan v3 BF-1 / BF-2 / UI-1 / UI-2 / UI-3 已落地的视觉。
- 不引入 markdown / 代码高亮 / 主题切换 / 拖拽分栏。

---

## 9. 风险评估与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| canonical 投影后某条 graph 形状细微差异 | 中 | selector 内部完全沿用现有 builder 装配逻辑（仅迁移阶段）；192 条回归测试是网；按 §10 顺序逐步切换，每步跑测试 |
| nodeId 命名冲突（如 thinking 与 event） | 低 | 类型前缀 + 多段 id 保证唯一；C1 单独覆盖 |
| 现有 link.js chip UX 切换后引入回归 | 低 | 保留 chip / clearHighlight 完整 UX；只换 selector / data attr |
| 外部代码（dev tools / 用户脚本）依赖 `data-link-*` | 低 | 项目内仅 link.js + 6 条测试引用；无对外公开 API 承诺 |
| canonical 增加额外 traversal 性能损耗 | 低 | 输入规模 < 200 events，单次 O(n)，无可观测影响 |
| 测试数量增加 / 排查链路变长 | 低 | 新增 6 条测试 + 迁移 6 条，总 198 条，CI 时间增量秒级 |

---

## 10. 实施顺序与里程碑

| 步骤 | 动作 | 验证 |
|---|---|---|
| S1 | 写 `canonical-graph.js`（含 buildCanonicalEventGraph + selectAgentOutputView + selectTimelineView） | — |
| S2 | 新增 `frontend-canonical-graph.test.ts`（C1-C6） | C1-C6 全过 |
| S3 | `buildAgentOutputGraph` 改为 selector wrapper | frontend-view + frontend-error-routing 全过 |
| S4 | `buildTimelineGraph` 改为 selector wrapper | frontend-view + frontend-timeline-user-image 全过 |
| S5 | 切渲染层 attr：agent-output-graph.js + timeline.js 两处 `*LinkAttrs` 函数同步改为读 `node.nodeId / node.scopeId` | 视觉/lint 通过 |
| S6 | 迁移 `frontend-link-anchors.test.ts` 6 条期望 | L1-L6 全过 |
| S7 | 简化 link.js + 加 `.is-link-scope` CSS | 单元 + 手动验证联动 |
| S8 | cache version bump v68 → v69 | — |
| S9 | 跑 `bun run check` 综合 gate | 全绿 → 完成 |

---

## 11. 验收标准

1. `bun run check` 全绿（types + lint + 198 条测试）。
2. 痛点 A 修复：点 user-bubble 不再触发整 run 全高亮，强高亮只锁该 bubble，二级 scope 微亮该 run 内子节点。
3. 痛点 B 修复：点右栏 timeline phase 节点（user_input / thinking / tool_execution / response）能正确触发左栏对应 step 内 trail-* 微亮。
4. 跨视图节点（tool / message / error）联动方向对称：点 output 的 trail-tool 与点 timeline 的对应 event 触发同一组高亮。
5. 切换 trace 文件后高亮自动清除，chip 隐藏。
6. plan v3 已落地的所有视觉（卡片样式、运行符号、最终答案布局等）零回归。
