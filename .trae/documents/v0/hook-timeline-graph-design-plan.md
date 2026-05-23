# Hook & Tool Timeline Graph 设计开发文档

## Summary

本设计文档用于梳理当前 `Hook & Tool Timeline` 的事件类型、前后端交互链路、可推导层级关系，以及未来适合扩展的 Graph 数据结构。

目标不是立即改代码，而是先把 Timeline Graph 的设计边界想清楚：

* 当前 Timeline 有哪些卡片类型。

* 每种卡片来自后端哪里。

* 当前数据能推导出哪些层级。

* 当前数据无法可靠表达哪些层级。

* 第一版如何基于现有事件做前端派生 Graph。

* 未来如果后端继续新增 event，应该如何设计通用结构，避免每加一种事件都改一堆特殊逻辑。

对齐的长期框架方向：

* ReAct：已有 agent loop，对应 `ReAct Step`。

* Tools / MCP：已有 tools，未来 MCP 作为外部工具/资源系统接入，对应 `tool_execution` 或 `mcp` phase。

* Skills：已有 skills middleware，对应 `skills` phase。

* Memory：未来新增，对应预留 `memory` phase。

* Lead / Sub Agent：未来新增，对应 `Agent Execution` 层，当前默认只有 `lead`。

* Trace：建设中，对应本文件设计的 Timeline Graph。

参考图：`docs/20260519-173619.jpeg` 左侧的树状 Graph 结构。它的关键特征是：顶层 Graph / Run 节点，下面按执行阶段、模型调用、prompt、tool/function 子调用缩进，每个节点有类型 chip、耗时、token / item count 等摘要，详情默认折叠。

## Current State Analysis

### 前端入口

相关文件：`web/public/index.html`

Timeline 的 DOM 入口：

```html
<div class="pane-title timeline-title-row">
  <span>Hook & Tool Timeline</span>
  <select id="timelineFilter" class="inline-select sr-only">...</select>
</div>
<div class="timeline-tabs">...</div>
<div id="timeline" class="timeline"></div>
```

相关文件：`web/public/app.js`

状态来源：

```js
const state = {
  events: [],
  traceRows: [],
  messages: [],
  progress: null,
  streaming: false,
  ...
};
```

实时事件处理：

```js
if (event.type === "trace" || event.type === "hook") {
  state.events.push(event.event);
  appendTraceRow(event.event);
  renderTimeline();
  ...
}
```

历史 replay：

```js
state.traceRows = replay.events || [];
const replayState = View.replayEventsToState(replay.events || []);
state.events = replayState.events;
state.messages = replayState.messages;
renderTimeline();
```

结论：

* Timeline 第一版 Graph 可以继续只消费 `state.events`。

* 如果需要把用户 query 或 assistant/tool message 纳入分组标题，可额外读取 `state.traceRows` 或 replay events 中的 `{ type: "message" }`，但这会扩大接口，需要明确设计。

* 当前 Timeline 与 Agent Output 已分离：Agent Output 基于 `state.traceRows` 派生 ReAct 输出；Timeline 应基于 trace/hook 事件派生执行审计 Graph。

### 当前渲染函数

相关文件：`web/public/view.js`

当前渲染入口：

```js
export function renderTimelineHTML(events = [], filter = "all") {
  const visible = compactTimelineEvents(events.filter((event) => shouldShowTimelineEvent(event, filter)));
  if (!visible.length) return `<div class="empty-state">No hook or tool timeline yet.</div>`;
  return `<div class="timeline-stack">${visible.slice(-160).map(renderTimelineItem).join("")}</div>`;
}
```

当前每张卡片：

```js
function renderTimelineItem(event) {
  return `
    <details class="timeline-item ${event.kind}">
      <summary>
        <span class="timeline-icon">...</span>
        <span class="timeline-summary-copy">
          <span class="timeline-summary-topline">
            <span class="timeline-title">${event.label}</span>
            <span class="timeline-badge">...</span>
          </span>
          <span class="timeline-meta">${friendlyTimelineKind(event.kind)} · time</span>
        </span>
      </summary>
      <pre>${JSON.stringify(event.data)}</pre>
    </details>`;
}
```

当前问题：

* 所有事件都是同级扁平卡片。

* `hook_triggered`、`input_context`、`model_output_block`、`tool_execution_*`、human action、session event 之间没有父子关系。

* 有 filter，但 filter 只是按类型筛选，不组织层级。

* 当前只对连续 `agent_progress` 做压缩，没有对 run/step/tool/prompt/model 做结构化归组。

### 当前 filter 规则

相关文件：`web/public/view.js`

```js
if (filter === "all") return !["input_context", "model_output_block"].includes(event.kind);
if (filter === "hooks") return event.kind === "hook_triggered";
if (filter === "model") return ["input_context", "model_output_block", "token_usage", "agent_progress", "prompt_version_applied"].includes(event.kind);
if (filter === "tools") return ["skill_loaded", "tool_call_detected", "tool_execution_started", "tool_execution_completed", "tool_disabled", "agent_progress"].includes(event.kind);
if (filter === "human") return ["approval_requested", "approval_resolved", "question_requested", "question_resolved"].includes(event.kind);
if (filter === "session") return ["session_created", "session_cleared", "session_aborted", "prompt_version_saved", "prompt_version_activated", "prompt_version_deleted", "tool_enabled_updated", "skills_inventory", "skill_system_injected", "skill_loaded", "todo_update", "error"].includes(event.kind);
```

结论：

* `input_context` 和 `model_output_block` 现在在 `all` 里隐藏，但 Graph 设计中它们非常适合作为 Model Call 子节点。

* 第一版 Graph 的 filter 应先作用于 Graph 输入还是输出节点，需要设计清楚。推荐：先完整建 Graph，再按 filter 控制可见类别，避免父节点被过滤后子节点失去归属。

### 后端事件类型

相关文件：`web/types.ts`

当前 `TraceKind`：

```ts
export type TraceKind =
  | "input_context"
  | "prompt_version_applied"
  | "model_output_block"
  | "tool_call_detected"
  | "hook_triggered"
  | "tool_execution_started"
  | "tool_execution_completed"
  | "approval_requested"
  | "approval_resolved"
  | "question_requested"
  | "question_resolved"
  | "skills_inventory"
  | "skill_system_injected"
  | "skill_loaded"
  | "session_created"
  | "session_cleared"
  | "session_aborted"
  | "prompt_version_saved"
  | "prompt_version_activated"
  | "prompt_version_deleted"
  | "tool_enabled_updated"
  | "tool_disabled"
  | "token_usage"
  | "todo_update"
  | "agent_progress"
  | "error";
```

每个 trace event 的基础结构：

```ts
export interface TraceEvent {
  id: string;
  sessionId: string;
  requestId?: string;
  kind: TraceKind;
  at: string;
  label: string;
  data?: Record<string, unknown>;
}
```

结论：

* `requestId` 是当前最重要的 run 分组字段。

* 当前没有通用 `parentId`、`spanId`、`step`、`phase`、`category`、`status` 字段。

* 当前 `step` 只存在于部分 `hook_triggered.data.step`，不是所有同 step 事件都有。

### 后端事件来源

相关文件：`web/server.ts`

会写入 trace 文件：

```ts
function emit(session, event) {
  if (event.type === "trace" || event.type === "hook") appendTraceLine(session.tracePath, event.event);
  else if (event.type === "message") appendTraceLine(session.tracePath, event);
  else if (event.type === "todo_update") appendTraceLine(session.tracePath, trace(session, "todo_update", ...));
  else if (event.type === "error") appendTraceLine(session.tracePath, trace(session, "error", ...));
}
```

用户提交 query 时：

```ts
const requestId = crypto.randomUUID();
session.currentRequestId = requestId;
emit(session, { type: "streaming_state", streaming: true });
emit(session, { type: "message", message: userMessage });
for await (const event of session.agent.stream(userMessage)) {
  emit(session, { type: "agent", event });
  if (event.type === "progress") emit(trace("agent_progress", ...));
  if (event.type === "message") emit({ type: "message", message: event.message });
}
```

tool wrapper：

```ts
emit(trace("tool_execution_started", `Tool started: ${tool.name}`, { toolUse }));
const result = await tool.invoke(input, signal);
emit(trace("tool_execution_completed", `Tool completed: ${tool.name}`, { toolUse, resultSummary }));
```

human action：

```ts
emit(trace("approval_requested", `Approval requested: ${req.toolUse.name}`, { toolUse: req.toolUse }));
emit(trace("approval_resolved", `Approval resolved: ${decision}`, { decision, request }));
emit(trace("question_requested", "Agent asked user a question", { params: req.params }));
emit(trace("question_resolved", "Question answered", { result }));
```

prompt / session / tools：

```ts
trace("session_created")
trace("session_cleared")
trace("session_aborted")
trace("prompt_version_saved")
trace("prompt_version_activated")
trace("prompt_version_deleted")
trace("tool_enabled_updated")
trace("tool_disabled")
trace("prompt_version_applied")
```

结论：

* `session.currentRequestId` 在 run 期间存在，因此大多数 run 内 trace event 有 `requestId`。

* `session_created`、prompt version 管理、tool enabled 更新等可能没有 `requestId`，应该归入 `Workspace / Session Events` bucket。

* `streaming_state` 不持久化到 trace，目前不能作为 replay Graph 的节点。

### Trace middleware 事件来源

相关文件：`web/trace.ts`

hook：

```ts
hook("beforeAgentRun", { messageCount, requestedSkillName })
hook("afterAgentRun", { messageCount })
hook("beforeAgentStep", { step })
hook("afterAgentStep", { step })
hook("beforeModel", { messageCount, toolCount, skills })
hook("afterModel", { blockCount, toolUseCount, usage })
hook("beforeToolUse", { toolUse })
hook("afterToolUse", { toolUse, resultSummary })
```

model：

```ts
input_context
skills_inventory
skill_system_injected
token_usage
model_output_block
tool_call_detected
```

结论：

* Hook 顺序天然表达 Agent lifecycle，可作为 Timeline Graph 的骨架。

* `beforeAgentStep` / `afterAgentStep` 带 `step`，可以推导 ReAct Step。

* `beforeModel` / `input_context` / `model_output_block` / `token_usage` / `afterModel` 可以组织成 Model Call 节点。

* `beforeToolUse` / `tool_execution_started` / `tool_execution_completed` / `afterToolUse` 可以组织成 Tool Execution 节点。

### Agent loop 顺序

相关文件：`src/agent/agent.ts`

```ts
_beforeAgentRun()
for step:
  _beforeAgentStep(step)
  _think()
    _beforeModel()
    model.stream()
    progress events
  _afterModel()
  yield assistant message
  if no tool uses:
    _afterAgentRun()
    return
  _act(toolUses)
    beforeToolUse
    tool.invoke
    afterToolUse
    yield tool message
  _afterAgentStep(step)
```

结论：

* Timeline Graph 固定层级是 `Workspace / Session Events -> Run -> Agent Execution -> ReAct Step -> Phase -> Event`。

* Agent loop 提供 Run 和 ReAct Step 的主骨架，当前默认 Agent Execution 为 `lead`，middleware/tool/server event 填充到固定 Phase。

* 这和 Agent Output Graph 不同：Agent Output 关注模型输出；Timeline Graph 关注系统执行审计。

### 后端组件查漏补缺

当前不只有 `web/trace.ts` 的 hook 会进入 Timeline。以下组件都可能直接或间接产生 Timeline Graph 节点：

| 组件 | 文件 | 当前是否有 trace | Graph 归属 |
|------|------|------------------|------------|
| Agent lifecycle | `src/agent/agent.ts` | 通过 `createTraceMiddleware()` 记录 `hook_triggered` | `Run` / `Agent Execution` / `ReAct Step` |
| Trace middleware | `web/trace.ts` | 是，记录 hook/model/token/skills/model output/tool call detected | `Run -> Agent Execution -> ReAct Step -> Phase -> Event` |
| Skills middleware | `src/agent/skills/skills-middleware.ts` | 间接由 `web/trace.ts` 记录 `skills_inventory`、`skill_system_injected` | `skills` phase |
| Todo system | `src/agent/todos/todos.ts` | tool 调用后由 `web/server.ts` 记录 `todo_update` | `todo` phase |
| Approval middleware | `src/coding/permissions/coding-approval-middleware.ts` | 由 `web/server.ts` approval subscription 记录 request/resolve | `human_gate` phase |
| Ask user question | `src/coding/tools/ask-user-question-manager.ts` | 由 `web/server.ts` question subscription 记录 request/resolve | `human_gate` phase |
| Prompt middleware | `web/server.ts` `installPromptMiddleware()` | 是，记录 `prompt_version_applied` | `prompt_phase` |
| Tool filter middleware | `web/server.ts` `installToolFilter()` | 是，记录 `tool_disabled` | `tool_execution` phase |
| Tool wrapper | `web/server.ts` `wrapSessionTools()` | 是，记录 `tool_execution_started/completed`、`skill_loaded` | `tool_execution` / `skills` phase |
| Session API | `web/server.ts` `createSession()`、`clear`、`abort` | 是，记录 session lifecycle | `Workspace / Session Events` 或当前 `Run` |
| Prompt version API | `web/server.ts` prompt routes | 是，记录 saved/activated/deleted | `Workspace / Session Events` |
| Tool settings API | `web/server.ts` `tools/enabled` | 是，记录 `tool_enabled_updated` | `Workspace / Session Events` |
| Model provider | `src/foundation/models/*`、`src/community/*` | 当前没有独立 provider trace，只通过 before/after model、token usage、progress 间接体现 | `model_call` phase |
| MCP / Memory | 当前代码未发现内置实现 | 当前无 trace | 未来按扩展契约归入既有 Phase，必要时新增 ReAct Step 下的 Phase |

当前 `AgentMiddleware` 只有 8 个 hook：

```ts
beforeAgentRun
afterAgentRun
beforeAgentStep
afterAgentStep
beforeModel
afterModel
beforeToolUse
afterToolUse
```

设计要求：

* Graph builder 不能只识别 `hook_triggered`，还必须覆盖 server 侧产生的 trace event。

* 新增组件时优先映射到既有 Phase；只有组件语义无法归类时才新增 Phase。

* Provider、MCP、Memory、Sub Agent 这类未来组件不应破坏 `Run -> Agent Execution -> ReAct Step -> Phase -> Event` 的主层级。

## Current Timeline Card Types

| Kind                       | 来源                               | 当前 filter      | 当前 badge                    | 可归属层级                         |
| -------------------------- | -------------------------------- | -------------- | --------------------------- | ----------------------------- |
| `hook_triggered`           | `web/trace.ts` middleware hook   | hooks          | 无                           | Run / Agent Execution / ReAct Step / Model / Tool |
| `agent_progress`           | `web/server.ts` agent progress   | model, tools   | progress name/subtype/count | Run / ReAct Step / Model stream |
| `input_context`            | `beforeModel`                    | model，all 默认隐藏 | 无                           | Model Call / Prompt           |
| `model_output_block`       | `afterModel` per block           | model，all 默认隐藏 | 无                           | Model Call / Output block     |
| `token_usage`              | `afterModel`                     | model          | 无                           | Model Call                    |
| `tool_call_detected`       | `afterModel` for tool\_use block | tools          | tool name                   | Model Call / Tool Planning    |
| `tool_execution_started`   | wrapped tool invoke              | tools          | tool                        | Tool Execution                |
| `tool_execution_completed` | wrapped tool invoke success/fail | tools          | tool                        | Tool Execution                |
| `tool_disabled`            | tool filter middleware           | tools          | tool                        | Tool Execution / Policy       |
| `approval_requested`       | approval manager                 | human          | approval                    | Human Gate                    |
| `approval_resolved`        | approval manager                 | human          | 无                           | Human Gate                    |
| `question_requested`       | ask user question manager        | human          | question count              | Human Gate                    |
| `question_resolved`        | ask user question manager        | human          | 无                           | Human Gate                    |
| `skills_inventory`         | `beforeModel`                    | session        | 无                           | Prompt & Skills / Model Call  |
| `skill_system_injected`    | `beforeModel`                    | session        | 无                           | Prompt & Skills / Model Call  |
| `skill_loaded`             | read\_file skill path detected   | tools, session | 无                           | Tool Execution / Skills       |
| `prompt_version_applied`   | prompt middleware                | model          | 无                           | Run / Prompt                  |
| `prompt_version_saved`     | prompt API                       | session        | 无                           | Session / Prompt Management   |
| `prompt_version_activated` | prompt API                       | session        | 无                           | Session / Prompt Management   |
| `prompt_version_deleted`   | prompt API                       | session        | 无                           | Session / Prompt Management   |
| `tool_enabled_updated`     | tools API                        | session        | 无                           | Session / Tool Settings       |
| `todo_update`              | server emit on todo messages     | session        | todo count                  | Run / Todo                    |
| `session_created`          | session creation                 | session        | 无                           | Session                       |
| `session_cleared`          | clear action                     | session        | 无                           | Session                       |
| `session_aborted`          | abort action                     | session        | 无                           | Run / Session                 |
| `error`                    | server error emit                | session        | 无                           | Run / Error 或 Session / Error |

## Existing Data Gaps

### 1. 缺通用父子关系

当前 `TraceEvent` 没有：

* `parentId`

* `spanId`

* `rootId`

* `phase`

* `category`

因此第一版只能用时间顺序、`requestId`、hook 名称和少数字段推导层级。

### 2. Tool execution 不能稳定关联 tool\_use id

`tool_call_detected` 里有模型产生的 `toolUse`，通常可能包含 `id`。

但 `wrapSessionTools()` 里构造的是：

```ts
const toolUse = { name: tool.name, input };
```

这里不包含原始 `toolUse.id`，因此：

* 如果同一 step 内并行调用两个同名同 input tool，前端无法稳定区分。

* 第一版只能按 tool name + input + 时间顺序匹配。

* 未来建议后端把 `toolUse.id` 贯穿 `tool_execution_started/completed`。

### 3. Step 字段只在部分 hook 上

`beforeAgentStep` / `afterAgentStep` 有 `data.step`。

但以下事件没有直接 step：

* `beforeModel`

* `input_context`

* `model_output_block`

* `tool_call_detected`

* `tool_execution_started`

* `tool_execution_completed`

* `token_usage`

第一版只能通过当前 active step 归属。

### 4. Run 边界缺显式 start/end event

当前 run 可以用：

* 用户 message 之后产生新的 `requestId`

* `hook_triggered: beforeAgentRun`

* `hook_triggered: afterAgentRun`

* `session_aborted`

* `error`

推导出来，但没有专门的 `run_started` / `run_completed` trace kind。

未来建议新增 span 化事件而不是继续靠 hook 名称推断。

## Final Graph Direction

文档收敛为一套方案：`Hook & Tool Timeline` 使用前端派生的 `TimelineGraph`，固定层级为：

```text
TimelineGraph
├── Workspace / Session Events
│   └── Event
└── Run
    └── Agent Execution
        └── ReAct Step
            └── Phase
                └── Event
```

这套层级是第一版和后续扩展都沿用的唯一结构。第一版不改后端接口，不改 trace 文件结构；未来如果后端补 graph metadata，也必须映射回这套层级，而不是引入第二套 UI graph。

设计意图：

* `Workspace / Session Events` 表示 WebSession / workspace 级事件，不是一轮用户 query。

* `Run` 表示一轮用户 query。

* `Agent Execution` 表示某个 agent 的执行实例，当前默认只有 `lead`，未来可自然增加 `sub-agent`。

* `ReAct Step` 表示 agent loop 内的一次 think/act/observe step。

* `Phase` 表示 step 内的功能阶段。

* `Event` 保留原始 trace 详情。

### 完整树状结构

执行者应按下面这棵树实现和测试。所有当前 TraceKind 都必须落到某个叶子 `Event`，不能在树外额外渲染散卡片。

```text
TimelineGraph
├── Workspace / Session Events
│   ├── Event: session_created
│   ├── Event: session_cleared
│   ├── Event: prompt_version_saved
│   ├── Event: prompt_version_activated
│   ├── Event: prompt_version_deleted
│   ├── Event: tool_enabled_updated
│   └── Event: error                    # only when event.requestId is missing
│
└── Run: requestId
    ├── Agent Execution: lead
    │   ├── Event: hook_triggered(beforeAgentRun)
    │   ├── ReAct Step: step=1
    │   │   ├── Phase: prompt_phase
    │   │   │   ├── Event: prompt_version_applied
    │   │   │   └── Event: input_context
    │   │   │
    │   │   ├── Phase: skills
    │   │   │   ├── Event: skills_inventory
    │   │   │   ├── Event: skill_system_injected
    │   │   │   └── Event: skill_loaded
    │   │   │
    │   │   ├── Phase: memory            # reserved; no current event yet
    │   │   │   └── Event: memory_read / memory_write
    │   │   │
    │   │   ├── Phase: model_call
    │   │   │   ├── Event: hook_triggered(beforeModel)
    │   │   │   ├── Event: agent_progress(thinking/tool)
    │   │   │   ├── Event: model_output_block(thinking/text/tool_use/other)
    │   │   │   ├── Event: token_usage
    │   │   │   └── Event: hook_triggered(afterModel)
    │   │   │
    │   │   ├── Phase: tool_planning
    │   │   │   └── Event: tool_call_detected
    │   │   │
    │   │   ├── Phase: tool_execution
    │   │   │   ├── Event: hook_triggered(beforeToolUse)
    │   │   │   ├── Event: tool_execution_started
    │   │   │   ├── Event: tool_disabled
    │   │   │   ├── Event: tool_execution_completed
    │   │   │   └── Event: hook_triggered(afterToolUse)
    │   │   │
    │   │   ├── Phase: mcp               # reserved; MCP tool/resource events
    │   │   │   └── Event: mcp_call / mcp_resource
    │   │   │
    │   │   ├── Phase: human_gate
    │   │   │   ├── Event: approval_requested
    │   │   │   ├── Event: approval_resolved
    │   │   │   ├── Event: question_requested
    │   │   │   └── Event: question_resolved
    │   │   │
    │   │   ├── Phase: todo
    │   │   │   └── Event: todo_update
    │   │   │
    │   │   ├── Phase: errors
    │   │   │   └── Event: error         # only when event.requestId belongs to this run
    │   │   │
    │   │   └── Phase: unscoped
    │   │       └── Event: unknown/future event with requestId
    │   │
    │   ├── ReAct Step: step=2
    │   └── ...
    │
    ├── Agent Execution: sub-agent:<id>  # future
    │   └── ReAct Step
    │       └── Phase
    │           └── Event
    │
    ├── Event: hook_triggered(afterAgentRun)
    └── Event: session_aborted           # if abort belongs to this requestId
```

树状结构约束：

* `Run`、`Agent Execution` 和 `ReAct Step` 是结构节点，不直接承载 JSON detail，detail 放在叶子 `Event`。

* `Phase` 是固定分组节点，按固定顺序渲染，空 Phase 不渲染。

* `beforeAgentRun` / `afterAgentRun` 是当前 `Agent Execution` 级 event，不放入 ReAct Step。

* `beforeAgentStep` / `afterAgentStep` 是 `ReAct Step` 的边界事件，可作为 ReAct Step summary 的时间锚点，也可以在 ReAct Step 下 `unscoped` 中作为叶子 detail 展示。

* 所有未来事件如果带 `requestId` 但无法分类，先进入当前 `Agent Execution` 的当前 ReAct Step 的 `unscoped`；没有 `requestId` 则进入 `Workspace / Session Events`。

### 固定层级定义

#### 1. `TimelineGraph`

Graph 是整个 Timeline 的 ViewModel 容器。

职责：

* 保存所有 root 节点。

* 保存 `nodeById`，便于渲染、测试、后续定位节点。

* 保存 `diagnostics`，记录无法精确归属的事件，例如缺 `requestId`、缺 `toolUseId`、step 推导失败。

不直接渲染业务内容，只提供树。

#### 2. `Workspace / Session Events`

所有没有 `requestId`、或者明确属于 WebSession / workspace 配置和生命周期的事件，都进入 `Workspace / Session Events`。

包含：

* `session_created`

* `session_cleared`

* `prompt_version_saved`

* `prompt_version_activated`

* `prompt_version_deleted`

* `tool_enabled_updated`

* 无 `requestId` 的 `error`

职责：

* 表达“不是某一轮 query 内部执行”的系统事件。

* 避免这些事件被硬塞进某个 Run 里造成误导。

展示：

* 作为一个 root 节点。

* 默认折叠。

* 有 error 时默认展开一级。

#### 3. `Run`

Run 表示一轮用户 query 触发的 agent 执行。

第一版主键：

```ts
requestId
```

Run 的来源：

* 有 `requestId` 的 trace/hook event。

* 如果后续 `renderTimelineHTML()` 输入扩展到 `traceRows`，可以把同轮 user message 作为 Run 标题来源，但不改变 Run 的主分组规则。

Run 标题：

* 第一版只使用 `Run ${index}` + request id 短码。

* 后续可增强为 `Run ${index} · ${userQueryPreview}`。

Run 状态：

* 有当前 request 的 `error`：`error`

* 有当前 request 的 `session_aborted`：`aborted`

* 有 `hook_triggered.data.hook === "afterAgentRun"`：`success`

* 否则：`running`

展示：

* 最新/current Run 默认展开。

* 历史 Run 默认折叠。

* summary 展示 agent count、step count、tool count、hook count、duration、status。

#### 4. `Agent Execution`

Agent Execution 表示一次具体 agent 执行。

当前状态：

* 现在只有一个默认 agent，即 `lead`。

* 第一版 builder 可以为每个 Run 自动创建 `Agent Execution: lead`。

未来扩展：

* lead agent 调用 sub-agent 时，第一版建议为每个 sub-agent 创建同一 Run 下的 sibling `Agent Execution`；如果未来要表达调用链，可用 `parentAgentId` 扩展。

* `agentId` / `agentName` / `agentRole` 未来可来自 `TraceEvent.graph.refs` 或 event data。

* 如果没有 agent metadata，一律归入默认 `lead`，不能丢事件。

展示：

* 作为 Run 的直接子节点。

* 默认展开当前/latest lead execution。

* summary 展示 agent role、step count、tool count、duration、status。

#### 5. `ReAct Step`

ReAct Step 表示某个 Agent Execution 里的单轮 think/act/observe step。

Step 的锚点：

* `hook_triggered.data.hook === "beforeAgentStep"` + `data.step`

* `hook_triggered.data.hook === "afterAgentStep"` + `data.step`

归属规则：

* 遇到 `beforeAgentStep(step)` 后，该 request 内后续事件归入当前 Agent Execution 的这个 Step。

* 遇到下一个 `beforeAgentStep(nextStep)` 后切换当前 ReAct Step。

* 遇到 `afterAgentStep(step)` 后标记该 Step 完成，但不要立即关闭 Run，因为后续可能还有 `afterAgentRun`。

* 最后一轮无 tool use 时，agent loop 会直接 `afterAgentRun()`，不一定有 `afterAgentStep()`，因此 Step 成功不能只靠 `afterAgentStep()` 判断。

Step 状态：

* 子事件有 error / failed tool：`error`

* 有 `afterAgentStep(step)` 或 Run 已 `afterAgentRun` 且这是最后一个 Step：`success`

* 否则：`running`

展示：

* ReAct Step 作为 Agent Execution 的直接子节点。

* 默认折叠内容，但 summary 可见。

* summary 展示 model count、tool count、human gate count、duration。

#### 6. `Phase`

Phase 是 ReAct Step 下的固定功能分组，不再继续发散出多套方案。

固定 Phase 类型：

```ts
type TimelinePhaseType =
  | "prompt_phase"
  | "skills"
  | "memory"
  | "model_call"
  | "tool_planning"
  | "tool_execution"
  | "mcp"
  | "human_gate"
  | "todo"
  | "errors"
  | "unscoped";
```

每个 Step 最多出现这些 Phase。没有事件的 Phase 不渲染。

Phase 归属：

* `prompt_phase`：`prompt_version_applied`、`input_context`

* `skills`：`skills_inventory`、`skill_system_injected`、`skill_loaded`

* `memory`：未来 `memory_read`、`memory_write`、`memory_search` 等事件

* `model_call`：`beforeModel`、`agent_progress`、`model_output_block`、`token_usage`、`afterModel`

* `tool_planning`：`tool_call_detected`

* `tool_execution`：`beforeToolUse`、`tool_execution_started`、`tool_execution_completed`、`afterToolUse`、`tool_disabled`

* `mcp`：未来 MCP server/resource lifecycle、MCP resource read、MCP call 等事件；如果 MCP 只是普通工具执行，也可以继续归入 `tool_execution`

* `human_gate`：`approval_requested`、`approval_resolved`、`question_requested`、`question_resolved`

* `todo`：`todo_update`

* `errors`：`error`

* `unscoped`：有 `requestId` 但无法归入当前 ReAct Step 或固定 Phase 的事件，包括未来未知组件事件

展示：

* Phase 作为 Step 的直接子节点。

* Phase summary 显示类型、事件数量、关键 badge。

* 默认展开 Phase summary，Event detail 默认折叠。

扩展规则：

* `memory` 未来如果表示检索/写入上下文，优先新增 `memory` Phase，位置建议在 `prompt_phase` 之后、`model_call` 之前。

* `mcp` 未来如果表现为外部工具调用，优先归入 `tool_execution`；如果 MCP 有连接/资源发现/会话级能力，则无 `requestId` 的事件归入 `Workspace / Session Events`。

* `retrieval` / `knowledge` / `context_pack` 这类组件优先归入 `prompt_phase` 或未来 `memory` Phase。

* `provider` 级事件优先归入 `model_call`，不要新增平行于 Run / Agent Execution / ReAct Step 的层级。

* 新增 Phase 必须只发生在 ReAct Step 下，不能改变 `Workspace / Session Events -> Run -> Agent Execution -> ReAct Step -> Phase -> Event`。

#### 7. `Event`

Event 是现有 `TraceEvent` 的叶子节点。

职责：

* 保留原始 event data。

* 提供当前卡片的标题、kind、badge、time、status。

* 展开后展示 JSON detail。

展示：

* 默认折叠。

* `error`、failed `tool_execution_completed`、`approval_requested`、`question_requested` 可默认展开一级。

### 唯一推荐实现策略

第一版只实现这套前端派生 Graph：

```ts
TraceEvent[] -> buildTimelineGraph(events) -> filterTimelineGraph(graph, filter) -> renderTimelineGraphHTML(graph)
```

原因：

* 当前核心问题是 UI 缺少层级，现有 `TraceEvent[]` 已足够构建 `Run -> Agent Execution -> ReAct Step -> Phase -> Event`。

* 不改后端可以兼容实时和 replay。

* 后端未来增强只补充归属精度，不改变前端 graph 层级。

未来后端增强的定位：

* 不是另一套方案。

* 不是第二套 graph。

* 只是在 `TraceEvent` 上提供更可靠的归属字段，让同一套 `TimelineGraph` 少做推断。

## Proposed Timeline Graph Data Structure

### ViewModel

文件建议：`web/public/view.js`

```ts
type TimelineGraph = {
  roots: TimelineNode[];
  nodeById: Record<string, TimelineNode>;
  diagnostics: TimelineGraphDiagnostic[];
};

type TimelineNode =
  | TimelineSessionNode
  | TimelineRunNode
  | TimelineAgentExecutionNode
  | TimelineStepNode
  | TimelinePhaseNode
  | TimelineEventNode;

type TimelineSessionNode = {
  id: "session";
  type: "session";
  title: "Workspace / Session Events";
  status: "running" | "success" | "error";
  children: TimelineNode[];
};

type TimelineRunNode = {
  id: `run:${string}`; // requestId or synthetic index
  type: "run";
  requestId?: string;
  runIndex: number;
  title: string; // Run 1 / user query preview if available
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  status: "running" | "success" | "error" | "aborted";
  children: TimelineNode[];
  events: TraceEvent[];
};

type TimelineAgentExecutionNode = {
  id: `agent:${string}:${string}`; // requestId + agent key
  type: "agent_execution";
  requestId?: string;
  agentId: string; // "lead" for current implementation
  parentAgentId?: string;
  agentRole: "lead" | "sub" | "unknown";
  title: string; // Lead agent / Sub-agent: planner
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  status: "running" | "success" | "error" | "aborted";
  children: TimelineNode[];
  events: TraceEvent[];
};

type TimelineStepNode = {
  id: `step:${string}:${number}`;
  type: "react_step";
  requestId?: string;
  agentId: string;
  step: number;
  title: string; // Step 1
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  status: "running" | "success" | "error";
  children: TimelineNode[];
  events: TraceEvent[];
};

type TimelinePhaseNode = {
  id: string;
  type: TimelinePhaseType;
  title: string;
  badge?: string;
  status?: "running" | "success" | "error" | "skipped";
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  children: TimelineNode[];
  events: TraceEvent[];
};

type TimelinePhaseType =
  | "prompt_phase"
  | "skills"
  | "memory"
  | "model_call"
  | "tool_planning"
  | "tool_execution"
  | "mcp"
  | "human_gate"
  | "todo"
  | "errors"
  | "unscoped";

type TimelineEventNode = {
  id: string; // event.id or synthetic
  type: "event";
  kind: TraceKind;
  category: "hook" | "model" | "tool" | "mcp" | "memory" | "human" | "skill" | "prompt" | "session" | "todo" | "error" | "progress";
  title: string;
  subtitle?: string;
  badge?: string;
  at?: string;
  status?: "success" | "error" | "running" | "skipped";
  event: TraceEvent;
};
```

### 分类规则

```ts
function classifyTimelineEvent(event): TimelineCategory {
  if (event.kind === "hook_triggered") return "hook";
  if (["input_context", "model_output_block", "token_usage", "agent_progress"].includes(event.kind)) return "model";
  if (["tool_call_detected", "tool_execution_started", "tool_execution_completed", "tool_disabled"].includes(event.kind)) return "tool";
  if (["approval_requested", "approval_resolved", "question_requested", "question_resolved"].includes(event.kind)) return "human";
  if (["skills_inventory", "skill_system_injected", "skill_loaded"].includes(event.kind)) return "skill";
  if (event.kind.startsWith("prompt_version_")) return "prompt";
  if (event.kind === "todo_update") return "todo";
  if (event.kind === "error") return "error";
  return "session";
}
```

### 构建规则

#### 1. Root 层

Root 分两类：

* `Workspace / Session Events`：无 `requestId` 的 session、prompt 管理、tool settings、error。

* `Run`：有 `requestId` 的事件。

规则：

```ts
if (event.requestId) {
  run = getOrCreateRun(event.requestId);
} else {
  session.children.push(createSessionEventNode(event));
}
```

#### 2. Run 层

Run 使用 `requestId` 分组。

标题：

* 优先使用同 request 附近的 user message preview，若第一版只输入 `events`，则使用 `Run ${index}`。

* 如果后续输入扩展到 `traceRows`，可从 `{ type: "message", role: "user" }` 生成 `Run 1 · 用户 query 预览`。

状态：

* 有 `error`：`error`

* 有 `session_aborted`：`aborted`

* 有 `afterAgentRun`：`success`

* 否则：`running`

#### 3. Step 层

实际构建时先在 Run 下创建 `Agent Execution`：

* 当前所有事件默认归入 `Agent Execution: lead`。

* 未来如果 event data 或 `TraceEvent.graph.refs.agentId` 存在，则按 agent id 创建对应的 `Agent Execution`。

* 缺 agent id 时不能丢事件，必须落到 `lead`。

#### 4. ReAct Step 层

ReAct Step 通过 hook 推导：

* `hook_triggered` + `data.hook === "beforeAgentStep"` + `data.step`

* `hook_triggered` + `data.hook === "afterAgentStep"` + `data.step`

`currentStep` 规则：

* 遇到 `beforeAgentStep(step)`：打开/切换当前 step。

* 后续同 request + 同 agent execution 的事件默认归到 current step，直到 `afterAgentStep(step)`。

* 没有 step 的事件归到当前 agent execution 的 `unscoped` phase。

注意：

* 最后一轮没有 tool use 时，agent loop 会直接 `afterAgentRun()`，不会调用 `afterAgentStep()`。

* 因此 final model response 所在 step 可能没有 `afterAgentStep`，不能仅靠 `afterAgentStep` 判断 step 成功。

#### 5. Phase 层

每个 ReAct Step 下固定使用这些 Phase，顺序也固定：

1. `prompt_phase`

2. `skills`

3. `memory`

4. `model_call`

5. `tool_planning`

6. `tool_execution`

7. `mcp`

8. `human_gate`

9. `todo`

10. `errors`

11. `unscoped`

Phase 不一定全部显示。只有有子事件时才渲染。

#### 6. Tool Execution Phase 细节

第一版关联规则：

1. 优先用 `event.data.toolUse.id` / `event.data.toolUse.tool_use_id`。
2. 没有 id 时，用 `toolUse.name + stableJson(input)` 作为弱 key。
3. 如果同 key 并行冲突，用时间顺序挂到最近未完成 tool execution。
4. 无法匹配时挂到当前 ReAct Step 的 `tool_execution` phase。

状态：

* `tool_execution_started` 后无 completed：`running`

* `tool_execution_completed` 且 `data.error`：`error`

* `tool_execution_completed` 无 error：`success`

* `tool_disabled`：`skipped`

#### 7. Model Call Phase 细节

Model Call 包含：

* `hook_triggered: beforeModel`

* `input_context`

* `skills_inventory`

* `skill_system_injected`

* `agent_progress`

* `model_output_block`

* `tool_call_detected`

* `token_usage`

* `hook_triggered: afterModel`

`input_context` 和 `model_output_block` 虽然当前 `all` 隐藏，但 Graph 展示中可以作为默认折叠 detail，或者只在 filter=model 时显示。

#### 8. Human Gate Phase 细节

Human Gate 包含：

* `approval_requested`

* `approval_resolved`

* `question_requested`

* `question_resolved`

关联规则：

* approval 用 `data.request.id` 或 `toolUse.name + time` 弱关联。

* question 用 `params.questions` / result 弱关联。

第一版可先同一 phase 下按时间顺序展示，不强行配对。

## UI 展示设计

### 设计原则

Timeline Graph 不再使用厚重卡片。推荐改成“薄行节点 + 树状连线”：

* 每个节点是一行，默认高度 28-36px。

* 左侧用树状竖线/折线表达层级，不靠大块卡片区分层级。

* 同一类型使用同一种颜色，不同层级靠缩进和连线表达。

* 行内只放最关键摘要：类型 chip、标题、状态、耗时/时间。

* 详情 JSON 不直接铺开，放到每个 leaf event 的折叠区域。

* Phase 可以是轻量 group row，不需要像卡片一样有完整边框。

### 整体结构

```html
<div class="timeline-graph">
  <details class="timeline-node timeline-run-node" open>
    <summary class="timeline-node-row" style="--depth: 0">
      <span class="timeline-tree-line"></span>
      <span class="timeline-type-chip run">RUN</span>
      <span class="timeline-node-title">Run 1</span>
      <span class="timeline-node-meta">1 agent · 3 steps · 4 tools · 2.3s</span>
    </summary>

    <div class="timeline-graph-children">
      <details class="timeline-node timeline-agent-node" open>
        <summary class="timeline-node-row" style="--depth: 1">
          <span class="timeline-tree-line"></span>
          <span class="timeline-type-chip agent">LEAD</span>
          <span class="timeline-node-title">Lead agent</span>
          <span class="timeline-node-meta">3 steps · 4 tools · 2.3s</span>
        </summary>
        <details class="timeline-node timeline-step-node">
          <summary class="timeline-node-row" style="--depth: 2">
            <span class="timeline-tree-line"></span>
            <span class="timeline-type-chip step">STEP</span>
            <span class="timeline-node-title">Step 1</span>
            <span class="timeline-node-meta">model · 2 tools · 1.1s</span>
          </summary>
          ...
        </details>
      </details>
    </div>
  </details>
</div>
```

### 默认展开策略

* 最新/current Run：默认展开。

* 历史 Run：默认折叠。

* 当前 `Agent Execution: lead`：默认展开。

* 未来 sub-agent：默认折叠，但有 error / human gate 时展开一级。

* ReAct Step：默认展开 summary，但 children 可折叠；如果节点很多，默认折叠。

* Phase：默认展开一层摘要。

* Raw Event Detail：默认折叠，只展示 label、kind、time、badge。

* Error / failed tool / human gate：默认展开一级，避免用户错过关键事件。

### 节点摘要

Run 摘要：

* request id 短码

* agent count

* step count

* tool count

* hook count

* duration

* status

Agent Execution 摘要：

* agent role / name

* step count

* tool count

* duration

* status

ReAct Step 摘要：

* step number

* model call count

* tool count

* human gate count

* duration

Tool 摘要：

* tool name

* status

* duration

* result summary / error

Model 摘要：

* block count

* tool use count

* token usage

* prompt source

### 视觉规范

参考图左侧：

* 左侧竖线表达层级。

* 每个节点一行文字，配一个 type chip。

* 子节点缩进 14-18px。

* 节点摘要紧凑，不用大卡片。

* 详情 JSON 放折叠 `<pre>`。

类型颜色建议：

| 类型 | 颜色语义 | 适用节点 |
|------|----------|----------|
| run | primary / blue | `Run` |
| agent | indigo | `Agent Execution`，包含 lead / sub agent |
| step | cyan | `ReAct Step` |
| prompt | purple | `prompt_phase`、prompt version、input context |
| memory | violet | future memory read/write/search |
| model | green | `model_call`、token、model output、progress |
| tool | amber | `tool_planning`、`tool_execution`、tool disabled |
| mcp | orange | future MCP server/resource/call |
| human | pink/red | approval、question |
| skill | cyan/teal | skills inventory、system injected、skill loaded |
| todo | green | todo update |
| session | gray | session/global events |
| error | red | error / failed tool |

建议 class：

```css
.timeline-graph
.timeline-graph-node
.timeline-graph-summary
.timeline-graph-children
.timeline-graph-line
.timeline-graph-icon
.timeline-graph-title
.timeline-graph-meta
.timeline-graph-chip
.timeline-graph-detail
.timeline-run-node
.timeline-agent-node
.timeline-step-node
.timeline-phase-node
.timeline-event-node
```

## Filter Design

推荐：先完整构建 Graph，再过滤可见节点。

原因：

* 如果先过滤 events，父子结构容易断。

* 比如 filter=tools 时，仍需要保留 Run / Agent Execution / ReAct Step / Phase 父节点，否则工具事件会变成散卡片。

规则：

```ts
function filterTimelineGraph(graph, filter) {
  if (filter === "all") return graphWithDefaultHiddenDetails(graph);
  return keepNodesWhere(node matches filter || node has visible descendants);
}
```

filter 行为：

* `all`：显示 Run / Agent Execution / ReAct Step / Phase 摘要，隐藏 raw `input_context` / `model_output_block` detail，除非展开或位于 model phase。

* `hooks`：显示 hook event，同时保留其 Run / Agent Execution / ReAct Step 父链。

* `model`：显示 prompt/model/token/progress，同时保留 Run / Agent Execution / ReAct Step 父链。

* `tools`：显示 tool planning/execution/skill\_loaded，同时保留 Run / Agent Execution / ReAct Step 父链。

* `human`：显示 approval/question。

* `session`：显示 session/prompt setting/tool setting/todo/error/global events。

## Extensibility Contract

未来新增 MCP、Memory、Retrieval、Provider span、Cache、Policy 等组件时，必须遵守以下扩展契约。

### 1. 先分类，再决定是否新增 Phase

新增事件先尝试映射到现有 Phase：

| 新组件类型 | 默认归属 | 说明 |
|------------|----------|------|
| MCP tool call | `tool_execution` | MCP 作为外部工具执行时，不新增顶层层级 |
| MCP server/resource lifecycle | `Workspace / Session Events` | 无 `requestId` 的连接/发现/配置事件归入全局 |
| Memory read/write | `memory` phase | 如果语义是跨轮记忆检索/写入，进入 ReAct Step 下的 `memory` Phase |
| Lead / Sub Agent | `Agent Execution` | 不新增 Phase，而是在 Run 下创建 agent execution 节点 |
| Retrieval/context pack | `prompt_phase` 或 `memory` | 如果只影响 prompt 组装，归入 prompt；如果有记忆语义，归入 memory |
| Provider request/response | `model_call` | 不新增 provider 顶层节点 |
| Cache hit/miss | `model_call` 或 `prompt_phase` | 看缓存对象是模型响应还是 prompt/context |
| Policy/safety/permission | `human_gate` 或 `tool_execution` | approval 类进 human；tool skip 类进 tool |

只有当一个组件满足以下条件时，才新增 Phase：

* 它发生在某个 Run / Agent Execution / ReAct Step 内。

* 它不是 prompt、model、tool、human、skills、memory、mcp、todo、error 的自然子类。

* 它需要在 UI 上被用户稳定识别，而不是只作为普通 event detail。

新增 Phase 的代码改动应限制在：

* `TimelinePhaseType`

* `classifyTimelineEvent()`

* `phaseForTimelineEvent()`

* phase 排序表

* 样式颜色表

* 单测 fixtures

### 2. Unknown event 不能破坏渲染

Graph builder 必须有兜底：

```ts
if (event.requestId) {
  attachToPhase(currentAgentExecution.currentStep, "unscoped", event);
} else {
  attachToWorkspaceSessionEvents(event);
}
```

这样未来后端新增 event 时，旧前端最多显示为 `unscoped`，不能直接丢失或导致 Timeline 空白。

### 3. Graph metadata 只能增强归属

未来如果 `TraceEvent.graph` 存在：

* 优先用 `graph.step`、`graph.nodeType`、`graph.category`、`graph.refs.toolUseId` 提高归属准确性。

* 如果存在 `graph.refs.agentId` / `graph.refs.agentRole`，优先用于创建 `Agent Execution`。

* 仍必须输出同一套 `TimelineGraph` ViewModel。

* 不允许根据 metadata 渲染另一套 DOM 结构。

### 4. 对话轮次组织

对话轮次统一映射为 `Run`：

* 主键优先使用 `requestId`。

* 标题可以从同 request 附近的 user message 提取 preview。

* 多轮 query 形成多个 sibling Run。

* 一轮 query 内可以有一个或多个 Agent Execution。

* 一个 Agent Execution 内多个 ReAct loop 形成多个 ReAct Step。

* 跨轮 memory / session 事件如果没有 requestId，进入 `Workspace / Session Events`；如果有 requestId，进入对应 Run 的 `memory` 或 `prompt_phase`。

## Future Backend Metadata

这一节不是另一套方案，只是同一套 `TimelineGraph` 的未来增强。

原则：

* UI 层级仍然固定为 `Workspace / Session Events -> Run -> Agent Execution -> ReAct Step -> Phase -> Event`。

* 后端 metadata 只用于减少前端推断，提高归属准确性。

* 旧 trace 没有 metadata 时，仍按本文的前端派生规则构建同一套 Graph。

### 推荐新增字段

相关文件：`web/types.ts`

```ts
export interface TraceEvent {
  id: string;
  sessionId: string;
  requestId?: string;
  kind: TraceKind;
  at: string;
  label: string;
  data?: Record<string, unknown>;
  graph?: TraceGraphMeta;
}

export interface TraceGraphMeta {
  nodeId: string;
  parentId?: string;
  rootId?: string;
  category: TraceGraphCategory;
  nodeType: TraceGraphNodeType;
  status?: "pending" | "running" | "success" | "error" | "skipped";
  runIndex?: number;
  step?: number;
  sequence?: number;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  refs?: {
    requestId?: string;
    messageIndex?: number;
    blockIndex?: number;
    toolUseId?: string;
    toolName?: string;
    hook?: string;
    agentId?: string;
    agentRole?: "lead" | "sub" | "unknown";
  };
}
```

### 可选补强的后端事件语义

如果后续需要更准确的耗时和生命周期，可以补强以下事件语义，但它们仍映射进同一套 Graph 层级：

* `run_started`

* `run_completed`

* `agent_step_started`

* `agent_step_completed`

* `agent_execution_started`

* `agent_execution_completed`

* `model_call_started`

* `model_call_completed`

* `tool_execution_failed`，或者在 completed 中保留 status。

短期不建议马上加一堆新 kind。更推荐先补 `graph` metadata 或 `toolUseId`，这样兼容旧 UI 和旧 trace。

### 最小后端增强建议

如果只做一个小后端增强，优先级最高的是：

```ts
tool_execution_started/completed.data.toolUseId
```

原因：

* 当前 tool call detected 与 tool execution 之间最容易错配。

* Graph 中 tool execution 是用户最关心的树状子节点。

## Document Clarity Cleanup

本节用于确认文档是否还有不明确或冗余内容。

已收敛的点：

* 删除多方案心智：文档不再让执行者在多套 Graph 之间选择，只保留 `Workspace / Session Events -> Run -> Agent Execution -> ReAct Step -> Phase -> Event`。

* 明确 session 维度：`Workspace / Session Events` 表示 WebSession / workspace 级全局事件，不是一轮用户 query。

* 明确 lead/sub agent 扩展：当前默认 `Agent Execution: lead`，未来 sub-agent 只新增 agent execution 节点，不改变 Run/Step/Phase 主结构。

* 明确未来组件接入：MCP、Memory、Provider、Cache、Policy 先按扩展契约归类，未知事件兜底到 `unscoped` 或 `Workspace / Session Events`。

* 弱化卡片设计：UI 方案以薄行节点、类型颜色、执行时间、树状连线为主，不再设计厚重卡片。

仍需在实现阶段注意的点：

* 现有后端没有 agent id / sub-agent metadata，所以第一版必须默认挂到 `lead`。

* 现有后端没有 memory / mcp trace kind，文档只预留 phase 和扩展规则，不要求第一版伪造节点。

* `tool_execution_started/completed` 当前缺稳定 `toolUseId`，第一版只能弱匹配，未来建议后端补字段。

* `Workspace / Session Events` 默认折叠，避免全局配置事件挤占 Timeline 主视图。

## Proposed Implementation Plan

### 1. 新增 Timeline Graph builder

文件：`web/public/view.js`

新增：

```js
export function buildTimelineGraph(events = [], options = {}) {}
function classifyTimelineEvent(event) {}
function createTimelineRunNode(event) {}
function createTimelineAgentExecutionNode(run, event) {}
function createTimelineStepNode(run, step) {}
function attachTimelineEvent(graph, event) {}
```

保留旧 `renderTimelineHTML(events, filter)` 入口，内部改为：

```js
const graph = buildTimelineGraph(events);
const visibleGraph = filterTimelineGraph(graph, filter);
return renderTimelineGraphHTML(visibleGraph, filter);
```

### 2. 渲染 Timeline Graph

文件：`web/public/view.js`

新增：

```js
function renderTimelineGraphHTML(graph, filter) {}
function renderTimelineNode(node, depth = 0) {}
function renderTimelineEventNode(node) {}
function timelineNodeSummary(node) {}
function timelineNodeBadge(node) {}
```

保留 `renderTimelineItem(event)` 作为 fallback 或 raw event detail renderer。

### 3. 增加树状样式

文件：`web/public/styles.css`

新增 `.timeline-graph-*` 样式：

* 缩进线

* 紧凑 summary

* type chip

* status color

* JSON detail

* error/highlight

不复用 Agent Output Graph class，避免 Timeline Graph 和 Agent Output Graph 视觉/职责耦合。

### 4. 更新测试

文件：`web/__tests__/frontend-view.test.ts`

新增测试：

* 当前全部 `TraceKind` 都能被 classify。

* 多 requestId 能生成多个 Run。

* 每个 Run 当前默认生成 `Agent Execution: lead`。

* `beforeAgentStep` / `afterAgentStep` 能生成 ReAct Step。

* model 事件能归入 Model Call。

* tool 事件能归入 Tool Execution。

* human 事件能归入 Human Gate。

* 无 requestId 的 session/prompt/tool setting 事件归入 `Workspace / Session Events`。

* filter=tools 时保留 Run / Agent Execution / ReAct Step 父链。

* 旧 replay events 兼容。

文件：`web/__tests__/frontend-smoke.test.ts`

更新 smoke：

* `renderTimelineHTML()` 输出 `.timeline-graph`。

* 仍包含 `Hook & Tool Timeline`。

* replay smoke 的 timeline 仍包含 tool/hook/human/session 关键信息。

### 5. 不改后端第一版

第一版不修改：

* `web/server.ts`

* `web/types.ts`

* `web/trace.ts`

* `src/agent/agent.ts`

只在文档里记录未来后端增强建议。

## Assumptions & Decisions

* Timeline Graph 与 Agent Output Graph 分开维护。

* Timeline Graph 关注 hook/middleware/tool/model/session/human 审计链路，不展示完整用户可读回答。

* 第一版只基于现有 `TraceEvent[]` 前端派生 Graph。

* 第一版不新增后端接口，不改 SSE type，不改 trace 文件格式。

* `requestId` 是 Run 的主分组字段。

* 当前无 agent metadata 时，每个 Run 自动创建默认 `Agent Execution: lead`。

* `hook_triggered.data.step` 是 Step 的主锚点。

* tool 执行第一版用弱匹配，未来补 `toolUseId`。

* filter 应在 Graph 构建后应用，保留父链。

* 参考图的树状样式只借鉴左侧缩进/节点/耗时/折叠形态，不照搬右侧详情面板。

## Verification

设计阶段验证：

* 已检查 `web/public/view.js` 中 `renderTimelineHTML()`、`shouldShowTimelineEvent()`、`timelineBadge()`、`timelineIcon()`。

* 已检查 `web/types.ts` 中全部 `TraceKind`。

* 已检查 `web/trace.ts` 中 middleware hook、model、skill、token、tool call detected 的 trace 来源。

* 已检查 `web/server.ts` 中 session、prompt、tool execution、human action、todo、error 的 trace 来源。

* 已检查 `src/agent/agent.ts` 中 agent run / step / model / tool 的执行顺序。

实现阶段建议运行：

```bash
bun test web/__tests__/frontend-view.test.ts
bun test web/__tests__/frontend-smoke.test.ts
bun run check
```

手动验证：

1. 发起一次普通 query，无 tool，确认生成一个 Run + 一个 Agent Execution + 一个 ReAct Step + Model Call。
2. 发起一次 tool query，确认 Tool Planning 和 Tool Execution 出现在对应 ReAct Step 下。
3. 触发 approval/question，确认 Human Gate 节点显示。
4. 切换 filters：All / Hooks / Model / Tools / Human / Session，确认父链保留。
5. 打开 replay trace，确认旧 trace 文件能生成 Graph。
6. 对比 Agent Output Graph，确认两者职责不混：Agent Output 展示模型 ReAct 输出，Timeline 展示系统执行审计。

## Change Scope For Future Implementation

第一版必改：

* `web/public/view.js`

* `web/public/styles.css`

* `web/__tests__/frontend-view.test.ts`

* `web/__tests__/frontend-smoke.test.ts`

第一版不应改：

* `web/server.ts`

* `web/types.ts`

* `web/trace.ts`

* `src/agent/agent.ts`

* `src/agent/agent-middleware.ts`

未来 metadata 增强可能改：

* `web/types.ts`：新增可选 `TraceGraphMeta`，但不改变现有 `TraceEvent` 主结构。

* `web/trace.ts`：给 middleware trace event 填同一套 Graph 的归属 metadata。

* `web/server.ts`：给 tool execution、human action、session/prompt events 填同一套 Graph 的归属 metadata。

* `src/agent/agent.ts`：如需精确 span lifecycle，可能需要暴露更明确的 run/step/tool context，但不应引入第二套 Graph 层级。
