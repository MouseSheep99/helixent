# Agent Output 视觉重构方案 v3 — 弱化 Run + 左右联动 + 图片兼容

## 快速导航：需求分层（实施时严格按层推进，避免越界）

> 本文档累计了 v1 → v2 → v3 三次迭代讨论。最终落地按照**两个独立工种**推进，互不耦合：

### 🐛 Part A — Bug Fixes（独立可合并，不依赖任何 UI 改动）

| 编号       | 标题                                                           | 章节   | 影响面                                               |
| -------- | ------------------------------------------------------------ | ---- | ------------------------------------------------- |
| **BF-1** | 空 `todo_update` 在 timeline 刷出 `{"todos":[],"summary":""}` 空行 | §A.1 | server.ts + output.js                             |
| **BF-2** | 右侧 timeline 对**用户上传图片**没有独立入口（图被埋在 `input_context` 深处）       | §A.2 | view/images.js + view/timeline.js + app/output.js |

> 实施要点：BF-1 / BF-2 **必须先修**，并且每条 PR 独立、独立测试，与 Part B 不混合。

### ✨ Part B — UI Optimization（按子任务顺序叠加）

| 编号       | 标题                                                               | 章节            | 依赖          |
| -------- | ---------------------------------------------------------------- | ------------- | ----------- |
| **UI-1** | 弱化 Run，agent output 重构为扁平 chat-thread（业界范式对齐）                    | §B.1（原 §1-§8） | —           |
| **UI-2** | agent output ↔ hook\&tool timeline 双向联动（点哪边对面高亮 + 自动展开）          | §B.2（原 §9.1）  | UI-1 + BF-2 |
| **UI-3** | 右侧面板信息密度微调（sticky 标题 / Run Metrics 默认折叠 / Linked highlight chip） | §B.3（原 §9.2）  | UI-2        |

> 实施要点：Part B 的三条任务**必须按序号顺序**推进，每完成一条跑一次 `bun run check`。**不可跳过 BF-2 直接做 UI-2**，否则联动到 timeline 时图片侧没有锚点。

### 实施总顺序（推荐）

```
BF-1 (5-10 行 + 1 测试)
  ↓
BF-2 (timeline 图片入口) ←──────┐
  ↓                            │
UI-1 (chat-thread v2 主体)      │ 都改 timeline，先 BF-2 再 UI-2 避免冲突
  ↓                            │
UI-2 (双向联动) ─────────────────┘
  ↓
UI-3 (布局微调)
```

***

## Part A — Bug Fixes（独立工种，先修，不依赖 UI）

### A.1 BF-1：空 `todo_update` 在 timeline 刷出空行

#### 现象（用户截图直接证据）

右侧 timeline 出现一行 `Todo panel updated`，pre 展开是 `{"todos":[],"summary":""}`，**信息量为零**。

#### 根因链路（已定位）

1. [web/server.ts#L450-L451](file:///Users/bytedance/Documents/Codex/helixent/web/server.ts#L450-L451)：每次 `message` 事件后**无条件** `emit({ type: "todo_update", todos: latestTodos })`。当 agent 没调过 `todo_write` 时 `latestTodos` 为 `[]`。
2. [web/public/app/session.js#L323-L326](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/session.js#L323-L326)：route 到 `renderTodo(event.todos)`。
3. [web/public/app/output.js#L118-L126](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/output.js#L118-L126)：`renderTodo([])` → `createTodoTraceEvent([])` → push `{data:{todos:[], summary:""}}` 进 `state.events` → 触发 timeline 重渲染并产生空行。
4. [web/server.ts#L699-L700](file:///Users/bytedance/Documents/Codex/helixent/web/server.ts#L699-L700)：`appendTraceLine` 把空 todo\_update 同时落入 `.jsonl` trace 文件 → 回放时再次刷屏。

**性质**：幂等 emit 但没做 dedup 的污染。

#### 修复（两层兜底）

**Layer A — 服务端不发空 todo（止于源头）**

[web/server.ts#L450-L451](file:///Users/bytedance/Documents/Codex/helixent/web/server.ts#L450-L451)：

```ts
if (event.type === "message") {
  emit(session, { type: "message", message: event.message });
  const todoState = buildTodoViewState(session.agent.messages);
  if (todoState.latestTodos.length > 0) {
    emit(session, { type: "todo_update", todos: todoState.latestTodos });
  }
}
```

[web/server.ts#L699-L700](file:///Users/bytedance/Documents/Codex/helixent/web/server.ts#L699-L700) 的 trace 落盘加同一守卫：

```ts
} else if (event.type === "todo_update") {
  if ((event.todos ?? []).length > 0) {
    void appendTraceLine(session.tracePath, trace(session, "todo_update", "Todo panel updated", { todos: event.todos ?? [] }));
  }
}
```

**Layer B — 客户端兜底（旧 trace 文件回放也干净）**

[web/public/app/output.js#L118-L126](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/output.js#L118-L126)：

```js
export function renderTodo(todos) {
  const next = todos || [];
  const prev = state.todos || [];
  state.todos = next;
  // 上一次和这一次都是空 → 不写入 events，避免噪音
  if (next.length === 0 && prev.length === 0) {
    renderRunState();
    renderTodoPanel();
    return;
  }
  const event = View.createTodoTraceEvent(next);
  state.events.push(event);
  appendTraceRow(event);
  renderTimeline();
  renderRunState();
  renderTodoPanel();
}
```

> 为什么必须 Layer B：老 trace 文件里已经存了空 `todo_update`，回放（[web/public/app/traces.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/traces.js)）时仍会触发右侧空行；只在服务端修是不够的。

#### 测试

新增 [web/__tests__/frontend-todo-noise.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-todo-noise.test.ts)：

* **T1**：连续两次 `renderTodo([])` → `state.events` 中 `todo_update` 为 0。

* **T2**：先 `renderTodo([3 条])`，再 `renderTodo([])` → 第二次**保留**为有效"清空"事件。

* **T3**：`renderTodo([3 条])` → `renderTodo([3 条])` → 两条事件都保留（语义有用）。

#### 验证场景

* **场景 J**：发 "你好" → 右侧 timeline **不**出现 `Todo panel updated` 行。

* **场景 K**：让 agent 调 `todo_write` 写 3 条 → 出现一行 `Todo panel updated · 3 todos`，pre 是真实数据。

* **场景 L**：3 条 → 0 条 → 出现 `Todo panel updated · 0 todos`（保留，是有意义的状态变化）。

***

### A.2 BF-2：右侧 timeline 没兼容用户上传图片的独立入口

#### 现象 / 缺口

[web/public/view/images.js#L18-L37](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/images.js#L18-L37) 的 `extractImagesFromEvent` 仅识别两类 event：

* `input_context`（含 `data.messages[*].content[*]` 里的 image\_url）

* `model_output_block`（含 `data.block.type === "image_url"`）

[web/public/view/timeline.js#L411-L414](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/timeline.js#L411-L414) 把图缩略图塞在每个 event node 内的 `<details>` 里。

**结果**：用户上传的图片只会出现在 timeline 的 `input_context` 节点深处（埋在 `prompt_phase`），没有"用户消息"维度的入口；并且只要 BF-1 让 message 事件不再 spam，timeline 上就**没有任何节点**直接展现"这一轮用户传了什么图"。这与左侧 chat-thread 的 user bubble 含图设计完全脱节。

#### 设计目标

* timeline 的事件流里增加一类 first-class 节点：**user\_message**（紧贴在 run / agent 下，与 prompt\_phase 平级），让用户上传的文本/图片在调试视图里可单独定位。

* 不破坏现有 phases 排序，不影响 BF-1 的 dedup 策略。

* 与 UI-2 联动：user\_message 节点带 `data-link-request-id`，点左侧 user-bubble 可以高亮到右侧 user\_message 节点。

#### 数据流改造

##### Step 1 — 在客户端把 user message 翻译成 trace 事件

[web/public/app/session.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/session.js) 在收到 `message` 类型且 `role === "user"` 时，调用一个新的 `createUserMessageTraceEvent`，类似 [web/public/view/human-actions.js#L64-L72](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/human-actions.js#L64-L72) 的 `createTodoTraceEvent`：

```js
// web/public/view/human-actions.js (新增 export)
export function createUserMessageTraceEvent(message, requestId) {
  const text = collectTextFromContent(message.content);
  // 注意：images 在这里就抽出来，避免后续 timeline 重新解析
  const images = extractImagesFromMessage(message, "user");
  return {
    id: crypto.randomUUID(),
    requestId,
    kind: "user_message",
    at: new Date().toISOString(),
    label: "User message",
    data: { text, images, role: "user" },
  };
}
```

##### Step 2 — `extractImagesFromEvent` 增加对 `user_message` 的支持

[web/public/view/images.js#L18](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/images.js#L18)：

```js
export function extractImagesFromEvent(event) {
  if (!event || !event.data) return [];
  const kind = event.kind;
  if (kind === "user_message") {
    return Array.isArray(event.data.images) ? event.data.images : [];
  }
  // ... 已有 input_context / model_output_block 分支保持不变
}
```

##### Step 3 — `phaseForTimelineEvent` / `classifyTimelineEvent` 加分类

[web/public/view/timeline.js#L312-L343](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/timeline.js#L312-L343)：

```js
function classifyTimelineEvent(event) {
  if (event.kind === "user_message") return "user";
  // ...
}

function phaseForTimelineEvent(event) {
  if (event.kind === "user_message") return "user_input"; // 新 phase
  // ...
}
```

新增 phase 顺序：把 `"user_input"` 加到 `TIMELINE_PHASE_ORDER` 最前面（[web/public/view/timeline.js#L12-L24](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/timeline.js#L12-L24)），title `"User Input"`。

##### Step 4 — phase chip / timeline-legacy 兼容

* [web/public/view/timeline.js phaseChip / timelineNodeTone / timelineEventChip](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/timeline.js#L489-L518)：加 `user_input` → `"INPUT"` 与 `"user"` tone (cyan/blue)。

* [web/public/view/timeline-legacy.js shouldShowTimelineEvent / friendlyTimelineKind / timelineBadge](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/timeline-legacy.js)：加 `user_message` 分支（默认 `"all"` filter 显示，filter `"human"` 也显示）。

##### Step 5 — 服务端可选同步（推荐但非阻断）

为了让 trace 文件回放时也有 user\_message 节点，可在 [web/server.ts](file:///Users/bytedance/Documents/Codex/helixent/web/server.ts) 服务端 prompt submit 路径上 emit 一条 trace event（kind 同 `user_message`）。这是 nice-to-have；客户端 Step 1-4 已经能让实时会话 + 实时 timeline 工作。

> 决策：**先只做客户端 Step 1-4**，落盘到 `.jsonl` 留给后续。客户端单独闭环可立即解决用户看到的问题。

#### CSS / 渲染

[web/public/styles/timeline.css](file:///Users/bytedance/Documents/Codex/helixent/web/public/styles/timeline.css) 加：

```css
.timeline-event-node.user > .timeline-node-row .timeline-type-chip {
  background: rgba(122, 200, 255, 0.16);
  color: var(--accent-cyan);
}
.timeline-event-node.user .timeline-event-images {
  margin-top: 6px;
}
```

#### 测试

新增 [web/__tests__/frontend-timeline-user-image.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-timeline-user-image.test.ts)：

* **T4**：含图片的 user message → `createUserMessageTraceEvent` 产生的 event 含 `data.images.length === 1`。

* **T5**：`buildTimelineGraph` 拿到上述 event → 在该 run 下出现 `user_input` phase，phase 下挂 `user_message` event 节点。

* **T6**：`extractImagesFromEvent({kind: "user_message", data: {images: [...]}})` 返回原图数组。

* **T7**：filter `"all"` / `"human"` 都能看到 user\_message 节点；filter `"hooks"` / `"model"` / `"tools"` 看不到。

#### 验证场景

* **场景 M**：发图片 + 文字 → 右侧 timeline 在 Run 下立刻出现一行 `User Input · User message`，展开看到缩略图（点击可放大）。

* **场景 N**：连发 3 条带图 query → 3 个 Run 节点各有自己的 `user_input` phase。

* **场景 O**：BF-1 已生效情况下，timeline 不再 spam todo\_update，且每个 Run 顶部都有清晰的 user\_input 锚点。

***

## Part B — UI Optimization

> 三个子任务（UI-1 / UI-2 / UI-3）按顺序叠加。下面 §0–§8 是 UI-1 的全部内容（与最初批准的 v2 一致），§9-§10 是 UI-2 / UI-3。

### B.1 UI-1 — chat-thread 重构（弱化 Run）

## 0. 背景与定调

用户痛点（来自上一轮反馈 + 截图）：

1. User query 看不清（被压在 run subtitle 里）。
2. Tools 想要折叠（已折叠但展开后视觉过重）。
3. Thinking 不够强化。
4. Final response 不明显。
5. **Run 卡片喧宾夺主，遮蔽了"自然对话"的体感。**

> 用户原话："是否可以弱化 run 的概念，一般聊天更关注自然的交互，现在这种一个 run 一个卡片的设计不太好。"

### 0.1 行业范式调研（2025-Q4 主流方向）

| 产品 / 设计                                                           | 核心模式                                                                               | 关键启示                                     |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------- |
| **Luke Wroblewski "Agentic AI Interface Improvements" (2025-11)** | 完成后 thinking+tool calls **塌缩成一行内联摘要**（"Thought for X · N tools"），点击再展开；results 常驻  | 推理过程 ≠ 一等公民。它是默认折叠的"工作记录"，**结果**才是主舞台    |
| **ChatGPT GPT-5/o3**                                              | 单线对话流；reasoning 表现为 final answer 上方一个折叠的 "Thought for 7s" 单行；最终回答正文常驻、加粗、12px 间距宽松 | "Thought for…" 单行 chip + 大块 answer 是目前标杆 |
| **Claude (Opus 4.5)**                                             | 单线对话；tool use / artifact 为内联紧凑卡片；attachment 用 chip；无 "Run" 概念                      | 工具调用作为消息内嵌的小标签，不打断对话节奏                   |
| **DeepSeek R1**                                                   | thinking 透明展示在 answer 上方，斜体 / 浅边框引用块；最终 answer 用 normal text 紧随其后                  | 思考与回答都在同一气泡列里，时间序自然，无层级容器                |

**最终结论**：业界统一抛弃了"以一次执行（Run）为视觉单元的容器卡片"。新范式是：

* 整个对话是**一条扁平时间线**（thread）。

* 用户消息 = 右对齐气泡。

* Agent 一次回应 = 一个左对齐"Agent turn"，**没有外框 Run 卡片**，依次包含：

  1. **Reasoning trail**（折叠摘要行：用了几步、用了哪些工具）→ 展开看 thinking + tool details；
  2. **Final answer**（突出展示）。

* 多轮就是 thread 上多组（user bubble + agent turn）交替，**不再用 "Run 1 / Run 2" 编号外框**。

## 1. 设计原则

* **对话优先**：thread 是主形式，graph/run 退化为底层数据组织（保留 buildAgentOutputGraph，但渲染时拆解成扁平消息流）。

* **结果为王**：final response 是 turn 内最显眼元素；thinking + tools 默认压缩成单行摘要。

* **可追溯**：摘要行点击展开后，仍能看到 ReAct 步骤序、每个 thinking 段、每个 tool 的 input/result。本次重构**不丢任何信息**。

* **不动数据结构**：题目硬约束。`buildAgentOutputGraph` 输出的 `graph.runs[*]` 形状不变；本次只增加渲染层 + 最小化非破坏 flag（`isFinal`）。

## 2. 新视觉骨架（取代 Run 卡片）

```
┌─────────────────────────────────────────────────────────┐
│ chat-thread                                             │
│                                                         │
│                      ┌─────────────────────────────┐    │
│                      │ 描述一下这张图片              │  ←─ user bubble (right)
│                      │ [📷 thumb]                  │    │
│                      └─────────────────────────────┘    │
│                                                         │
│  ┌────────────────────────────────────────────────┐     │
│  │ ▸ Thought for 1 step · used 0 tools     [ok]  │ ←─ collapsed reasoning summary
│  └────────────────────────────────────────────────┘     │
│  ┌────────────────────────────────────────────────┐     │
│  │ 这是一张高空视下的干旱地貌景观图…             │ ←─ final answer (no card frame, just border-left + bg)
│  │ ### 1. 色彩与土质                              │     │
│  │ 地表以暖色调为主…                              │     │
│  └────────────────────────────────────────────────┘     │
│                                                         │
│                      ┌─────────────────────────────┐    │
│                      │ 查一下 helixent 的 ...      │  ←─ next user bubble
│                      └─────────────────────────────┘    │
│                                                         │
│  ┌────────────────────────────────────────────────┐     │
│  │ ▸ Thought for 7 steps · 6 tools                │     │
│  │   glob_search · list_files · file_info         │     │
│  └────────────────────────────────────────────────┘     │
│  ┌────────────────────────────────────────────────┐     │
│  │ 在当前项目中没有找到名为 agent.md 的文件…    │     │
│  └────────────────────────────────────────────────┘     │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**展开后的 reasoning trail**（步骤列内联展开，不再用 `Run 1 / ReAct 1 / ReAct 2` 大标题嵌套）：

```
┌────────────────────────────────────────────────────────┐
│ ▾ Thought for 7 steps · 6 tools                  [ok] │
│ ────────────────────────────────────────────────────── │
│   ❝ Thinking — 用户现在需要描述这张图片…              │ ←─ thinking (purple italic)
│   ⚙ glob_search   description: 查找文件名包含 agent…  │ ←─ tool row (collapsed by default)
│   ⚙ list_files    path: /Users/…/helixent             │
│   ⚙ list_files    path: /Users/…/helixent/src         │
│   ⚙ glob_search   pattern: **/AGENTS.md               │
│   ⚙ glob_search   pattern: **/*agent*.md              │
│   ⚙ file_info     path: /…/AGENTS.md                  │
│   ❝ Thinking — 现在知道 AGENTS.md 存在…               │
└────────────────────────────────────────────────────────┘
```

每个 `⚙ tool` 自身也是 `<details>`，点击展开看 INPUT / RESULT pre。**两层折叠**：reasoning trail 整体折叠 + 单个 tool 折叠。Thinking 段直接展示文本（不需要再折叠，因为本来就被外层 trail 压缩）。

### 2.1 Run 编号去哪了？

* 编号从视觉上**完全消失**。只在调试模式下（按住 Alt+i 或 dev flag）作为左下角小水印显示。

* Inspect 按钮改为挂在 reasoning trail summary 行右侧，仍可定位到 user message index。

* Status chip（ok / running / error）也挂在 reasoning trail summary 行（因为 turn 整体的成败由 reasoning 流程决定）。

### 2.2 错误如何呈现？

* Agent runtime error（service-side）→ 在对应 turn 的 reasoning trail 里以红色行 `✕ Runtime error — <message>` 显示，且 trail summary 行的 status chip 变 red、自动展开。

* System errors（已通过上一轮 plan 解耦的 `graph.systemErrors`）→ 仍在 thread 顶部的红色 details 卡片，与本次改造正交。

### 2.3 Project context

仍特殊处理：不出 user bubble，仅在对应 turn 上方插入一个 dashed pill `CTX · Bootstrapped guidance from AGENTS.md`，灰色低饱和。

## 3. 改动总览

| 文件                                                                                                                         | 改动类型         | 关键点                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [view/agent-output-graph.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/agent-output-graph.js)       | **重写渲染层**    | 新增 `renderChatThread(graph)` 替代 `renderAgentOutputGraph`；`renderAgentTurn` / `renderReasoningTrail` / `renderToolRow` / `renderFinalAnswer`；`buildAgentOutputGraph` 给最后一个 response 打 `isFinal` |
| [view/output-cards.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/output-cards.js)                   | 接口调整         | `renderOutputHTML` 在有 graph.runs 时调用新的 `renderChatThread`；保留 `renderUserQueryBubble` 不变（legacy path 仍用）                                                                                        |
| [styles/agent-output-graph.css](file:///Users/bytedance/Documents/Codex/helixent/web/public/styles/agent-output-graph.css) | **大改**       | 删除/弱化 `.agent-run` 容器；新增 `.chat-thread` / `.user-bubble` / `.agent-turn` / `.reasoning-trail` / `.tool-row` / `.final-answer` / `.thinking-line`                                               |
| [index.html](file:///Users/bytedance/Documents/Codex/helixent/web/public/index.html)                                       | cache bump   | `v=trace-lens-workbench-64` → `65`（styles + app）                                                                                                                                               |
| 测试                                                                                                                         | 仅扩充 1 个 case | `frontend-error-routing.test.ts` 已覆盖核心；新增 1 case 验证 `isFinal` 标记                                                                                                                               |

## 4. 详细设计

### 4.1 [agent-output-graph.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/agent-output-graph.js)

#### 4.1.1 `buildAgentOutputGraph` 给最终 response 打 flag

在 [`updateRunStatus(run)`](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/agent-output-graph.js#L315-L331) 函数体里追加：

```js
// 标记最终响应：最后一个 step 的最后一个 response（同 plan v1）
const lastStep = run.steps[run.steps.length - 1];
if (lastStep && lastStep.response.length) {
  lastStep.response[lastStep.response.length - 1].isFinal = true;
}
```

#### 4.1.2 新增导出 `renderChatThread(graph, options)`

新建一组顶层渲染函数，直接消费 graph 但**完全扁平化输出**。在文件末尾加入：

```js
export function renderChatThread(graph, options = {}) {
  const turns = [];
  for (const run of graph.runs) {
    turns.push(renderUserTurn(run));
    turns.push(renderAgentTurn(run, options));
  }
  return `<div class="chat-thread">${turns.join("")}</div>`;
}

function renderUserTurn(run) {
  if (!run.user) return "";
  if (run.user.isProjectContext) {
    return `
      <div class="chat-context-pill" data-message-index="${run.user.messageIndex ?? ""}">
        <span class="agent-chip" data-tone="default">CTX</span>
        <span class="chat-context-text">${escapeHtml(summarizeMessageText(run.user.text))}</span>
      </div>`;
  }
  const text = run.user.text || "";
  const images = Array.isArray(run.user.images) ? run.user.images : [];
  if (!text && !images.length) return "";
  const stripHtml = images.length
    ? `<div class="user-bubble-images">${renderThumbnailStrip(images, { size: 80, group: `user-${run.index}` })}</div>`
    : "";
  const textHtml = text ? `<div class="user-bubble-text">${escapeHtml(text)}</div>` : "";
  const idx = run.user.messageIndex !== undefined ? `data-message-index="${run.user.messageIndex}"` : "";
  return `
    <div class="user-bubble" role="button" tabindex="0" ${idx}>
      ${stripHtml}
      ${textHtml}
    </div>`;
}

function renderAgentTurn(run, options) {
  const trail = renderReasoningTrail(run, options);
  const finalHtml = renderFinalAnswer(run);
  if (!trail && !finalHtml) {
    return `<div class="agent-turn empty"><div class="agent-detail-empty">No model output yet.</div></div>`;
  }
  return `
    <div class="agent-turn" data-status="${escapeAttr(run.status)}">
      ${trail}
      ${finalHtml}
    </div>`;
}

function renderReasoningTrail(run, options) {
  // 收集 turn 级 inline 项：每个 step 的 thinking + tools（按时间顺序），但不包含 final response
  const items = [];
  for (let stepIdx = 0; stepIdx < run.steps.length; stepIdx++) {
    const step = run.steps[stepIdx];
    for (const t of step.thinking) items.push({ kind: "thinking", item: t });
    for (const t of step.tools) items.push({ kind: "tool", item: t });
    // 中间 step 的 response 也作为 inline 段（仅 final 排除）
    for (const r of step.response) {
      if (!r.isFinal) items.push({ kind: "response_inline", item: r });
    }
    for (const e of step.errors) items.push({ kind: "error", item: e });
  }
  for (const e of run.errors) items.push({ kind: "error", item: e });

  // 没有 reasoning 内容（比如纯 final response 一句话）→ 不渲染 trail
  if (!items.length) return "";

  const stepCount = run.steps.length;
  const toolCount = items.filter((x) => x.kind === "tool").length;
  const toolNames = [...new Set(items.filter((x) => x.kind === "tool").map((x) => x.item.name))].slice(0, 5);
  const summary = [
    `Thought for ${stepCount} step${stepCount === 1 ? "" : "s"}`,
    toolCount ? `${toolCount} tool${toolCount === 1 ? "" : "s"}` : "",
    toolNames.length ? toolNames.join(" · ") : "",
  ].filter(Boolean).join(" · ");
  const isOpen = run.status === "error" || options.forceOpenReasoning;
  const inspectButton = run.user?.messageIndex !== undefined
    ? `<button class="ghost-button mini-button agent-inspect-button" type="button" data-message-index="${run.user.messageIndex}">Inspect</button>`
    : "";
  const body = items.map((x) => renderTrailItem(x)).join("");
  return `
    <details class="reasoning-trail" ${isOpen ? "open" : ""}>
      <summary class="reasoning-trail-summary">
        <span class="reasoning-trail-icon" aria-hidden="true"></span>
        <span class="reasoning-trail-text">${escapeHtml(summary)}</span>
        <span class="reasoning-trail-meta">
          ${renderAgentStatusChip(run.status)}
          ${inspectButton}
        </span>
      </summary>
      <div class="reasoning-trail-body">${body}</div>
    </details>`;
}

function renderTrailItem({ kind, item }) {
  if (kind === "thinking") {
    const text = item.text || item.content?.thinking || "";
    return `
      <div class="trail-item trail-thinking">
        <span class="trail-thinking-quote" aria-hidden="true">❝</span>
        <div class="trail-thinking-text">${escapeHtml(text)}</div>
      </div>`;
  }
  if (kind === "tool") {
    const subtitle = summarizeToolInput(item.input);
    const inspectButton = item.result?.messageIndex !== undefined
      ? `<button class="ghost-button mini-button agent-inspect-button" type="button" data-message-index="${item.result.messageIndex}">Inspect</button>`
      : "";
    const detail = `
      ${item.request ? renderToolSection("Input", item.input || item.request.content?.input || {}) : ""}
      ${item.detected ? renderToolSection("Detected", item.detected.content || {}) : ""}
      ${item.result ? renderToolSection("Result", item.result.content || {}) : `<div class="agent-detail-empty">Tool result pending.</div>`}
    `;
    return `
      <details class="trail-item trail-tool" data-status="${escapeAttr(item.status)}">
        <summary class="trail-tool-summary">
          <span class="trail-tool-icon" aria-hidden="true">⚙</span>
          <span class="trail-tool-name">${escapeHtml(item.name)}</span>
          <span class="trail-tool-subtitle">${escapeHtml(subtitle)}</span>
          <span class="trail-tool-meta">
            ${renderAgentStatusChip(item.status)}
            ${inspectButton}
          </span>
        </summary>
        <div class="trail-tool-detail">${detail}</div>
      </details>`;
  }
  if (kind === "response_inline") {
    const text = item.text || formatOutputValue(item.content);
    return `
      <div class="trail-item trail-response-inline">
        <div class="trail-response-text">${escapeHtml(text)}</div>
      </div>`;
  }
  if (kind === "error") {
    const text = item.text || item.content?.label || item.content?.data?.message || "Unknown error";
    return `
      <div class="trail-item trail-error">
        <span class="trail-error-icon" aria-hidden="true">✕</span>
        <span class="trail-error-text">${escapeHtml(text)}</span>
      </div>`;
  }
  return "";
}

function renderFinalAnswer(run) {
  // 取最后一个 step 的最后一个 response（其 isFinal 已被 buildAgentOutputGraph 标记）
  const lastStep = run.steps[run.steps.length - 1];
  if (!lastStep) return "";
  const finalItem = lastStep.response.find((r) => r.isFinal);
  if (!finalItem) return "";
  const text = finalItem.text || finalItem.content?.text || "";
  if (!text.trim()) return "";
  return `
    <div class="final-answer">
      <div class="final-answer-text">${escapeHtml(text)}</div>
    </div>`;
}
```

`renderToolSection` / `summarizeToolInput` / `renderAgentStatusChip` / `summarizeMessageText` / `escapeHtml` / `escapeAttr` / `formatOutputValue` 复用现有定义。

#### 4.1.3 `summarizeToolInput` 优先级（同 v1）

```js
function summarizeToolInput(input) {
  if (!input || typeof input !== "object") return "";
  const priorityKeys = ["description", "command", "path", "file_path", "pattern", "url", "query"];
  for (const key of priorityKeys) {
    if (typeof input[key] === "string" && input[key]) return `${key}: ${input[key]}`;
  }
  const entries = Object.entries(input);
  if (!entries.length) return "";
  const [k, v] = entries[0];
  return `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`;
}
```

#### 4.1.4 删除/保留旧函数

* `renderAgentOutputGraph` → **保留**作为 export，但内部改为直接 return `renderChatThread(graph, options)`；这样 [output-cards.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/output-cards.js#L17) 调用点零改动。

* `renderAgentRunNode` / `renderReactStepNode` / `renderToolCallNode` / `renderAgentOutputItem` / `agentOutputItemConfig` / `renderAgentAnchor` / `renderAgentChip` → **删除**（被新 thread 渲染替代）。

* `renderSystemErrorsSection` → **保留**，作为 thread 顶部独立块，由 `renderAgentOutputGraph` 在 `renderChatThread` 之前 prepend 输出。

最终顶层导出：

```js
export function renderAgentOutputGraph(graph, options = {}) {
  const systemErrors = graph.systemErrors || [];
  return `
    ${renderSystemErrorsSection(systemErrors)}
    ${renderChatThread(graph, options)}
  `;
}
```

### 4.2 [output-cards.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/output-cards.js)

无需改动 — `renderOutputHTML` 调用 `renderAgentOutputGraph(graph, outputOptions)`，签名兼容。

### 4.3 [agent-output-graph.css](file:///Users/bytedance/Documents/Codex/helixent/web/public/styles/agent-output-graph.css)

**完全替换**该文件（保留 systemErrors / image-thumb 部分），新内容骨架：

```css
/* ============================================================
   Chat thread — flat conversational layout
   ============================================================ */

.chat-thread {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 4px 2px;
}

/* ---------- User bubble (right-aligned) ---------- */

.user-bubble {
  align-self: flex-end;
  max-width: min(680px, 78%);
  padding: 11px 14px;
  border-radius: 16px 16px 4px 16px;
  border: 1px solid rgba(96, 165, 250, 0.32);
  background: linear-gradient(135deg, rgba(96, 165, 250, 0.18), rgba(96, 165, 250, 0.08));
  color: var(--text-primary);
  font-size: 13px;
  line-height: 1.6;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 8px;
  box-shadow: 0 1px 0 rgba(96, 165, 250, 0.06) inset;
  transition: border-color 120ms ease, background 120ms ease;
}
.user-bubble:hover,
.user-bubble:focus-visible {
  border-color: rgba(96, 165, 250, 0.55);
  background: linear-gradient(135deg, rgba(96, 165, 250, 0.24), rgba(96, 165, 250, 0.12));
  outline: none;
}
.user-bubble-text { white-space: pre-wrap; word-break: break-word; }
.user-bubble-images { display: flex; flex-wrap: wrap; gap: 6px; }

/* ---------- Project context pill ---------- */

.chat-context-pill {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px dashed var(--border-subtle);
  color: var(--text-tertiary);
  background: rgba(255, 255, 255, 0.02);
  font-size: 11px;
}
.chat-context-text {
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 360px;
}

/* ---------- Agent turn (no outer card) ---------- */

.agent-turn {
  align-self: stretch;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.agent-turn[data-status="error"] .reasoning-trail {
  border-color: rgba(255, 110, 120, 0.32);
}

/* ---------- Reasoning trail (collapsed by default) ---------- */

.reasoning-trail {
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.018);
  overflow: hidden;
  transition: border-color 120ms ease, background 120ms ease;
}
.reasoning-trail:hover { border-color: var(--border-soft); }

.reasoning-trail > summary {
  list-style: none;
  cursor: pointer;
  display: grid;
  grid-template-columns: 16px 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  user-select: none;
}
.reasoning-trail > summary::-webkit-details-marker { display: none; }
.reasoning-trail > summary:hover { background: rgba(255, 255, 255, 0.035); }

.reasoning-trail-icon {
  width: 14px; height: 14px;
  display: inline-grid; place-items: center;
  color: var(--text-tertiary);
}
.reasoning-trail-icon::before {
  content: "›"; font-size: 14px; font-weight: 700; line-height: 1;
  display: inline-block;
  transition: transform 150ms ease;
}
.reasoning-trail[open] > summary .reasoning-trail-icon::before {
  transform: rotate(90deg);
}
.reasoning-trail-text {
  color: var(--text-secondary);
  font-size: 12.5px;
  font-style: italic;
  letter-spacing: 0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.reasoning-trail-meta {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 11px; color: var(--text-tertiary);
}

.reasoning-trail-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 4px 12px 12px;
  border-top: 1px solid var(--border-subtle);
}

/* ---------- Trail items ---------- */

.trail-item {
  border-radius: 8px;
  font-size: 12.5px;
  line-height: 1.55;
}

.trail-thinking {
  display: grid;
  grid-template-columns: 18px 1fr;
  gap: 8px;
  padding: 8px 10px;
  border-left: 2px solid var(--accent-purple);
  background: linear-gradient(90deg, rgba(182, 140, 255, 0.10), rgba(182, 140, 255, 0.02) 70%);
  color: var(--text-secondary);
  font-style: italic;
}
.trail-thinking-quote {
  font-family: Georgia, "Times New Roman", serif;
  font-size: 20px; line-height: 1; color: var(--accent-purple);
  opacity: 0.7; user-select: none; font-style: normal;
}
.trail-thinking-text { white-space: pre-wrap; word-break: break-word; }

.trail-tool {
  border: 1px solid rgba(255, 184, 77, 0.18);
  background: rgba(255, 184, 77, 0.04);
}
.trail-tool > summary {
  list-style: none;
  cursor: pointer;
  display: grid;
  grid-template-columns: 18px auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  font-family: var(--font-mono, ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace);
  font-size: 12px;
  user-select: none;
}
.trail-tool > summary::-webkit-details-marker { display: none; }
.trail-tool > summary:hover { background: rgba(255, 184, 77, 0.08); }
.trail-tool-icon { color: var(--accent-amber); font-size: 12px; }
.trail-tool-name { color: var(--text-primary); font-weight: 700; }
.trail-tool-subtitle {
  color: var(--text-tertiary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.trail-tool-meta { display: inline-flex; align-items: center; gap: 6px; }
.trail-tool[data-status="error"] .trail-tool-name { color: var(--accent-red); }

.trail-tool-detail {
  display: flex; flex-direction: column; gap: 8px;
  padding: 8px 10px 10px;
  border-top: 1px solid rgba(255, 184, 77, 0.12);
}
.trail-tool-detail .agent-detail-section { display: grid; gap: 4px; }
.trail-tool-detail .agent-detail-section-title {
  color: var(--accent-amber); opacity: 0.7;
  font-size: 9.5px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase;
}
.trail-tool-detail .agent-detail-pre {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid rgba(255, 184, 77, 0.14);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.32);
  color: var(--text-secondary);
  font-family: var(--font-mono, monospace);
  font-size: 11.5px;
  line-height: 1.55;
  max-height: 360px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.trail-response-inline {
  padding: 8px 10px;
  border-left: 2px solid rgba(99, 216, 141, 0.28);
  background: rgba(99, 216, 141, 0.03);
  color: var(--text-primary);
  white-space: pre-wrap; word-break: break-word;
}

.trail-error {
  display: grid; grid-template-columns: 16px 1fr; gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid rgba(255, 110, 120, 0.36);
  background: rgba(255, 110, 120, 0.08);
  color: var(--accent-red);
}
.trail-error-icon { font-weight: 800; }
.trail-error-text { color: var(--text-primary); white-space: pre-wrap; word-break: break-word; }

/* ---------- Final answer (the star) ---------- */

.final-answer {
  align-self: stretch;
  padding: 16px 18px;
  border: 1px solid rgba(99, 216, 141, 0.32);
  border-left: 4px solid var(--accent-green);
  border-radius: 4px 12px 12px 4px;
  background: linear-gradient(135deg, rgba(99, 216, 141, 0.10), rgba(99, 216, 141, 0.02));
  box-shadow: 0 1px 0 rgba(99, 216, 141, 0.10) inset, 0 8px 22px rgba(99, 216, 141, 0.04);
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.7;
}
.final-answer-text {
  white-space: pre-wrap; word-break: break-word;
}

/* Empty turn fallback */
.agent-turn.empty {
  padding: 8px 12px;
  color: var(--text-tertiary);
  font-size: 12px;
}

/* ---------- Image thumbnail strip (already present, keep) ---------- */
/* ---------- System errors (already present, keep) ---------- */
```

注意：旧的 `.agent-run / .agent-run-summary / .agent-row / .agent-row-summary / .agent-row-anchor / .agent-row-chevron / .agent-row-copy / .agent-row-title / .agent-row-subtitle / .agent-row-meta / .agent-detail-text / .agent-detail-pre`（非 `.trail-tool-detail` 后代的）整体删除。`agent-chip` / `agent-status-chip` / `agent-detail-empty` / `image-thumb-strip` / `image-thumb` / `agent-output-system-errors` / `user-query-bubble` 保留（user-query-bubble 给 legacy `renderUserQueryBubble` 用）。

### 4.4 [index.html](file:///Users/bytedance/Documents/Codex/helixent/web/public/index.html)

cache version v64 → v65（两处：styles.css 与 app.js）。

### 4.5 测试

新增到 [frontend-error-routing.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-error-routing.test.ts) 同目录新文件 [frontend-final-flag.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-final-flag.test.ts)：

* F1：单 step + 单 response → 该 response.isFinal === true。

* F2：3 step，最后 step 有 2 个 response → 仅最后一个 isFinal === true，其它 false/undefined。

* F3：最后 step 没有 response（如以 tool\_use 结尾）→ 不抛错，前面 step 的 response 也不会被错误标 final。

### 4.6 删除范围（避免死代码堆积）

* `renderAgentRunNode` / `renderReactStepNode` / `renderToolCallNode` / `renderAgentOutputItem` / `agentOutputItemConfig` / `renderAgentAnchor` / `renderAgentChip` 整体删除。

* 保留 `renderSystemErrorsSection`（thread 顶部仍用）。

* 保留 `renderAgentStatusChip`（trail summary 与 tool summary 仍用）。

* 保留 `renderToolSection` / `summarizeToolInput` / `formatOutputValue`（tool detail 内部仍用）。

## 5. 假设与决策

1. **Run 概念退到数据层**：buildAgentOutputGraph 的输出形状不变（`graph.runs[*]` 仍存在），但 UI 不再展示 "Run N" 编号。这是"弱化但不删"——便于将来若需调试可一键启用 dev 标签。
2. **不动 timeline / inspect / sent-prompt / human-action**：本次只重构 agent output 主视图。timeline 视图独立保留细粒度 trace event 列表。
3. **不引入 markdown 渲染**：与 v1 一致。final-answer 仍用 escapeHtml + pre-wrap；后续可再加 markdown 模块。
4. **Reasoning trail 展开策略**：默认折叠；遇到 error 自动展开；提供 `forceOpenReasoning` 选项（暂不接通 UI 开关，留给将来）。
5. **Trail 内 thinking 不需要二次折叠**：因为外层 trail 已经折叠；thinking 段在展开后直接显示文本（保持 DeepSeek-style 的"透明推理"质感）。
6. **Tool 仍需二级折叠**：input/result 体积普遍较大，默认收起；与现状保持一致。
7. **No "Run Inspect" 按钮**：Inspect 按钮迁移到 reasoning trail summary 行。指向同一个 user message index，行为不变。
8. **Final answer 选取规则**：取每个 run 最后一个 step 的最后一个 response（与 v1 一致）。如果最后一个 step 无 response（以 tool\_use 结尾且未结束），final-answer 区块直接不渲染，trail 单独展示。

## 6. 验证步骤

1. `bun run check:types` 通过。
2. `bun run lint` 通过。
3. `bun test` 通过（已有测试不变；新增 F1-F3 通过）。
4. 手动验证：

   * **场景 A**（单轮纯文本）：发 "你好" → thread 显示蓝色右气泡 + 折叠 "Thought for 1 step" 行 + 大块绿色 final answer。无 "Run 1" 字样。

   * **场景 B**（多 tool）：发 "查 helixent 的 agents.md" → 蓝气泡 + 折叠 "Thought for 7 steps · 6 tools · glob\_search · list\_files · file\_info" + final answer。点击 trail 展开看到 thinking + 6 个 tool 行；点击 tool 行再展开看 input/result。

   * **场景 C**（含图）：发图片 + "描述一下" → 蓝气泡内含 80px 缩略图 + 文本；下方 trail + final answer。

   * **场景 D**（多轮）：依次发 3 条 query → 上下叠加 3 组（user bubble + agent turn），中间无任何 "Run 1/2/3" 编号外框。

   * **场景 E**（runtime error）：触发服务端 error → trail 自动展开，错误行红色显示，trail summary status chip 变红；final-answer 不渲染。

   * **场景 F**（client UI error，已有解耦）：上传 6 MB 图 → composer 上方红色 banner，thread 完全不动。

   * **场景 G**（project context）：首次启动含 AGENTS.md context → thread 顶部显示一个 dashed `CTX` pill，不是 user 蓝气泡。

## 7. 不在范围内（Out of Scope）

* 不改 buildAgentOutputGraph 的 node 形状（仅加 `isFinal` flag）。

* 不引入 markdown / 代码高亮 / 第三方库。

* 不动 timeline / inspect dialog / sent-prompt / system-errors（systemErrors 渲染区保留现状）。

* 不做主题切换。

* 不实现 dev-mode 的 "Run N" 水印（留给将来）。

## 8. 与 v1 方案差异 changelog

| 维度                | v1（已废弃）                                    | v2（本案）                                        |
| ----------------- | ------------------------------------------ | --------------------------------------------- |
| 顶层容器              | 仍保留 `.agent-run` 卡片                        | **取消**，改用扁平 `.chat-thread`                    |
| Run 标题 / 编号       | 保留 "Run N" + 简化 subtitle                   | **完全移除**                                      |
| User query 位置     | 在 run-children 顶部 bubble                   | **直接挂在 thread 上**，与 turn 同级                   |
| Step 层级           | 保留 ReAct 1/2/3 details 嵌套                  | **拍平**到 reasoning trail 的扁平列表                 |
| Tool 折叠           | 保留 step 嵌套下的 details                       | 取消 step 嵌套，每个 tool 在 trail 下直接折叠              |
| Final answer      | `.agent-detail-response.is-final` 在 step 内 | **提升到 turn 顶级**，独立 `.final-answer` 区块         |
| Reasoning summary | 沿用 step 标题 + chip                          | **新概念**："Thought for X · N tools · names" 一行  |
| 行业范式对齐            | 部分                                         | **完全对齐** ChatGPT / Claude / DeepSeek / Luke W |

***

### B.2 UI-2 — agent output ↔ timeline 双向联动

> 依赖：UI-1 落地（chat-thread 渲染函数已就位）+ BF-2 落地（timeline 已有 `user_message` 锚点）。
>
> 这一段对应用户问题 1：**点左侧 agent output 某个位置，右侧 timeline 对应节点高亮，方便 debug**。

### 9.0 设计意图

* 左侧 [chat-thread](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/agent-output-graph.js) = **对话视图**（结果导向，弱化 Run 概念）。

* 右侧 [Hook & Tool Timeline](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/timeline.js) = **观测视图**（细粒度 hook/tool 事件流，保留 Run / Step 树）。

* 二者是**同一份事件流的两种投影**：左侧给"读"，右侧给"调试"。

* 用 requestId / step / toolId 把两侧绑起来，**不重写任何渲染**，仅在 `<details>` / `<div>` 上注入 `data-link-*` 锚点。

### 9.1 联动方案（左 → 右）

#### 9.1.1 锚点元数据：在左侧渲染节点上挂 data-\* 属性

新增渲染层附带的 4 个标识属性（不动 `graph` 数据形状，仅在 HTML output 上加），由 [renderAgentTurn / renderTrailItem / renderFinalAnswer](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/agent-output-graph.js) 统一注入：

| 节点                                       | 属性                                                                          | 取值来源                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `.user-bubble`                           | `data-link-request-id="<requestId>"`                                        | run.requestId                                              |
| `.agent-turn`                            | `data-link-request-id`, `data-link-agent-id`                                | run.requestId, "lead"（默认 lead；将来 sub-agent 扩展时取实际 agentId） |
| `.reasoning-trail > details`             | 同上                                                                          | —                                                          |
| `.trail-thinking`                        | `data-link-request-id`, `data-link-step="<step.step>"`                      | step.step                                                  |
| `.trail-tool`                            | `data-link-request-id`, `data-link-step`, `data-link-tool-id="<toolUseId>"` | item.item.id（tool\_use 的 id）                               |
| `.trail-response-inline / .final-answer` | `data-link-request-id`, `data-link-step`                                    | step.step                                                  |
| `.trail-error`                           | `data-link-request-id`, `data-link-error-id="<errorId>"`                    | row\.id 或 fallback                                         |

> 注：tool\_use 的 id 服务端已经透传（trace 事件的 `data.toolUse.id` / `data.toolUseId`），timeline 中 tool 相关 event 节点同样带这个 id，可作为唯一桥梁。

#### 9.1.2 右侧 timeline 节点同步加 data-link-\*

[renderTimelineNode / renderTimelineEventNode](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/timeline.js#L389-L426) 在 `<details>` 上额外注入：

* run 节点 → `data-link-request-id`

* agent\_execution → 加 `data-link-agent-id`

* react\_step → 加 `data-link-step`

* 任何 tool 类 event → 加 `data-link-tool-id="<toolUseId>"`

* error event → 加 `data-link-error-id`

这样左右两侧形成**对称的 data-link-\* 命名空间**，后续 JS 只用做选择器匹配。

#### 9.1.3 联动 controller：[link.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/link.js)（新建）

在 `web/public/app/link.js` 新增一个轻量 controller：

```js
// web/public/app/link.js
import { els } from "./state.js";

let activeKey = null;

export function initOutputTimelineLink() {
  const output = els.modelOutput;
  const timeline = els.timeline;
  if (!output || !timeline) return;
  output.addEventListener("click", (e) => onClick(e, "output"));
  timeline.addEventListener("click", (e) => onClick(e, "timeline"));
}

function onClick(e, side) {
  const node = e.target.closest("[data-link-request-id]");
  if (!node) return;
  const key = buildKey(node.dataset);
  if (!key) return;
  applyHighlight(key, side);
}

function buildKey(ds) {
  // 优先级：tool > step > agent > run
  if (ds.linkToolId) return `tool:${ds.linkToolId}`;
  if (ds.linkStep) return `step:${ds.linkRequestId}:${ds.linkStep}`;
  if (ds.linkAgentId) return `agent:${ds.linkRequestId}:${ds.linkAgentId}`;
  if (ds.linkRequestId) return `run:${ds.linkRequestId}`;
  return null;
}

function applyHighlight(key, originSide) {
  if (activeKey === key) return; // toggle off can be added later
  document.querySelectorAll(".is-link-highlight").forEach((el) => el.classList.remove("is-link-highlight"));
  activeKey = key;
  const selector = selectorFor(key);
  document.querySelectorAll(selector).forEach((el) => {
    el.classList.add("is-link-highlight");
    if (originSide === "output") openAncestorDetails(el);
    if (originSide === "timeline") scrollIntoViewSoft(el);
  });
}

function selectorFor(key) {
  const [kind, ...rest] = key.split(":");
  if (kind === "tool") return `[data-link-tool-id="${cssEscape(rest.join(":"))}"]`;
  if (kind === "step") {
    const [reqId, step] = rest;
    return `[data-link-request-id="${cssEscape(reqId)}"][data-link-step="${cssEscape(step)}"]`;
  }
  if (kind === "agent") {
    const [reqId, agentId] = rest;
    return `[data-link-request-id="${cssEscape(reqId)}"][data-link-agent-id="${cssEscape(agentId)}"]`;
  }
  if (kind === "run") return `[data-link-request-id="${cssEscape(rest.join(":"))}"]`;
  return "";
}

function openAncestorDetails(el) {
  let p = el.closest("details");
  while (p) { p.open = true; p = p.parentElement?.closest("details"); }
}

function scrollIntoViewSoft(el) {
  el.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(value);
  return String(value).replace(/["\\]/g, "\\$&");
}
```

挂载点：[app.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app.js) 启动时 `initOutputTimelineLink()` 一次。事件用 delegation，无需在每次重渲染后重绑。

#### 9.1.4 高亮样式（共用类 `.is-link-highlight`）

在 [agent-output-graph.css](file:///Users/bytedance/Documents/Codex/helixent/web/public/styles/agent-output-graph.css) 与 [timeline.css](file:///Users/bytedance/Documents/Codex/helixent/web/public/styles/timeline.css) 各加一段：

```css
/* agent-output-graph.css */
.chat-thread .is-link-highlight {
  outline: 2px solid var(--accent-cyan);
  outline-offset: 2px;
  background: rgba(122, 200, 255, 0.06);
  border-radius: 6px;
  transition: outline-color 200ms ease, background 200ms ease;
}

/* timeline.css */
.timeline-node.is-link-highlight > .timeline-node-row {
  background: rgba(122, 200, 255, 0.10);
  box-shadow: inset 0 0 0 1px rgba(122, 200, 255, 0.45);
}
```

#### 9.1.5 双向 + 退出策略

* 左点 → 右展开父级 `<details>` 并 `scrollIntoView`，左右同时打高亮。

* 右点 → 左侧高亮（左侧因为多数都是 always-open，无需展开，仅 `scrollIntoView`）。

* 点击空白处 / 切换 trace 文件 / 触发 `renderOutput` 替换 innerHTML 时，高亮自然清除（class 没了），无需手动 cleanup。

* 后续可加 `Esc` 清除高亮（不在本次 scope）。

#### 9.1.6 与 BF-2 的 user\_message 联动

BF-2 在 timeline 上加了 `user_message` event 节点；UI-2 同时在该节点的 `<details>` 上注入 `data-link-request-id`，左侧 `.user-bubble` 与右侧 user\_message 节点天然成对，**点用户气泡 → 右侧 user\_message 高亮 + 自动展开**。这就闭合了 "用户输入 → 模型推理 → 工具执行 → 最终回答" 的 4 段联动。

***

### B.3 UI-3 — 右侧面板信息密度微调

> 用户问题 2：**Hook & Tool Timeline 这块的位置/容器**有没有调整空间。

现状（[index.html#L134-L160](file:///Users/bytedance/Documents/Codex/helixent/web/public/index.html#L134-L160)）：

* `.timeline-pane` aside 固定在右侧

* 顶部 Run Metrics（指标） + Hook & Tool Timeline（事件树）

* timeline filter 用 `.filter-pill` 做 tab

#### 决策：保留位置不动，做 3 处微调

**保留位置不动**。Run Metrics + Timeline 的右栏布局在调试时是公认的"主舞台 + 仪表盘"模式（Chrome DevTools / Sentry / Honeycomb 都是同模式）。**不要为追求"更轻"而把它折成抽屉**——一旦折叠，左右联动的视觉收益会折损。

3 个微调让它"更有用"：

1. **顶部 sticky 标题 + filter pills 一行**：现在 `Hook & Tool Timeline` 标题与 filter pills 占了两行。合并为一行 `Hook & Tool Timeline · [All|Hooks|Model|Tools|Human]`，`position: sticky; top: 0`，节省垂直空间。
2. **Run Metrics 默认折叠**：`<details>` 默认 open 改成默认关闭，调试时再点开（大多数时间用户更关注 timeline 流而非 token 计数）。
3. **新增 "Linked highlight" 状态指示**：标题右侧加一个小的 chip：当 `activeKey` 非 null 时，chip 显示 e.g. `🔗 step 4`，点击清除高亮。给联动可见的反馈出口。

#### 不做的事

* 不做"timeline 嵌入到 chat-thread 内联"——会把右侧的"全局可观测性"打散。

* 不做主题切换 / 拖拽分栏 / 浮窗 inspect 等大动作，超出 scope。

* 不动 `.timeline-pane` 的 grid 占比（保持目前左右比例）。

***

## 9.5 Part B 联动 + 布局验证场景（接 §6）

* **场景 H**（左→右联动）：发 "查 helixent 的 agents.md" → 在左侧 reasoning trail 里点击 `glob_search` → 右侧 timeline 自动展开 Run / Step / Tool Execution，定位到对应 `tool_execution_started` 事件并高亮。

* **场景 I**（右→左联动）：右侧 timeline 点击某 `tool_execution_completed` → 左侧 trail 该 tool 行高亮，背景变浅 cyan。

* **场景 P**（user message 联动，依赖 BF-2）：左侧点击 user-bubble → 右侧 timeline 该 Run 下的 `user_input` phase 自动展开并高亮 `User message` 节点。

* **场景 Q**（高亮 chip）：触发联动后，右侧标题旁出现 `🔗 step 4` chip；点击 chip → 高亮清除、chip 消失。

* **场景 R**（Run Metrics 默认折叠）：进入页面右侧 Run Metrics 是 collapsed 状态，单击展开后渲染 metrics-grid。

## 9.6 Out of Scope (Part B)

* 不做 hover preview（左侧 hover 一个 tool → 右侧自动 scroll）——成本高、抖动多，留给 v4。

* 不做 timeline 内 inline filter（按 requestId 只显示当前 run）——目前 chat-thread 与 timeline 都是全量，保持一致。

* 不重写 timeline 渲染——只在 `<details>` 上注入 `data-link-*`。

* 不实现 dev-mode 的 "Run N" 水印（留给将来）。

## 10. 累计 changelog

| 维度              | v1      | v2                | v3（本案，分层）                                  |
| --------------- | ------- | ----------------- | ------------------------------------------ |
| Run 卡片          | 保留 + 微改 | 完全移除（chat-thread） | 同 v2                                       |
| isFinal flag    | —       | 加在 graph 渲染前      | 同 v2                                       |
| 联动              | —       | —                 | **UI-2** 新增双向高亮                            |
| 右侧布局            | —       | —                 | **UI-3** sticky / Run Metrics 折叠 / 高亮 chip |
| 空 todo 噪音       | —       | —                 | **BF-1** 服务端 + 客户端双层 dedup                 |
| timeline 用户图片入口 | —       | —                 | **BF-2** 新 `user_message` event + phase    |
| 测试新增            | —       | F1-F3             | F1-F3 + T1-T3（todo） + T4-T7（user\_message） |

---

## 11. 远期方向（v4 候选，不在本次 scope）

### 11.1 提案：统一 canonical event graph

> 用户问题："agent output 和 timeline 的 graph 结构能不能统一用一个？agent output 是 timeline 的子集？"

**判断：是子集，长期值得统一，但不应纳入 v3。**

#### 现状关系

| 维度 | [buildTimelineGraph](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/timeline.js) | [buildAgentOutputGraph](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/agent-output-graph.js#L15) |
|---|---|---|
| 输入 | `state.events`（同一份） | `state.events`（同一份） |
| 输出层级 | `Run → agent_execution → Step → phase → event` | `Run → Step → {thinking, response, tool, error}` |
| 包含范围 | 全量（hooks / phase boundaries / lifecycle） | 子集（reasoning + tool + response + error） |
| nodeId 命名空间 | `run:*` / `agent:*` / `step:*` / `event:*` | `run:*` / `step:*` / `thinking:*` / `tool:*` / `response:*` / `error:*` |

agent output **本质是** timeline graph 的"语义投影"——同源不同视图。

#### 统一的收益

1. 一份事件解析逻辑，少一处维护成本。
2. UI-2 的 `data-link-*` 命名空间可以塌缩为统一的 `data-node-id`——本次 v3 之所以要发明这套 link 命名空间，**根本原因就是两个 graph 的 nodeId 不同**。
3. `isFinal` / `graph.systemErrors` / `user_message` 这类元数据只挂一处，不分歧。
4. BF-2 这种"两侧都要识别用户图片"的需求，未来天然在 canonical 阶段处理一次。

#### 不放进 v3 的理由

1. 改动面大：两个 builder 都得改写为 "upstream canonical + downstream selector"。
2. 触动 [export.js#isOutputRow](file:///Users/bytedance/Documents/Codex/helixent/web/public/export.js) 等下游 selector 与现有测试断言。
3. v3 已经有 5 个工种（BF-1 / BF-2 / UI-1 / UI-2 / UI-3），再加 v4 graph 重构会让 PR 难审、阻塞当前痛点修复。
4. 违反本文档顶部 "Bug Fix 与 UI Optimization 两层独立可合并" 的分层原则。

#### 推荐 v4 路径（前置准备）

1. 新增 `buildCanonicalEventGraph(state.events)` 作为单一真相源。
2. 现有两个 builder 改为：
   - `buildTimelineGraph(events) = selectTimelineView(buildCanonicalEventGraph(events))`
   - `buildAgentOutputGraph(events) = selectAgentOutputView(buildCanonicalEventGraph(events))`
3. canonical 阶段统一打 `isFinal` / `systemErrors` / `user_message` / `nodeId`。
4. UI-2 的 `data-link-tool-id` / `data-link-step` 平滑切换到 `data-node-id="tool:<id>"` / `data-node-id="step:<id>"`（命名 forward-compat）。
5. 测试：保持 v3 的 F1-F7、T1-T7 全过；新增 canonical-graph 单元测试覆盖 selector。

#### v3 中为 v4 留的接口

- UI-2 的 `data-link-*` 命名设计已经向 nodeId 靠拢（`data-link-tool-id="<id>"` ≈ 未来 `data-node-id="tool:<id>"`），未来切换是字符串拼接级别的改动，不是结构性重写。
- BF-2 选用 `user_message` 作为新 event kind 而非塞在已有 kind，未来 canonical 化时这是一个独立 phase，无需再改语义。

> **结论**：用户的方向感正确，但请先让 v3 闭环。v4 单独立项。

