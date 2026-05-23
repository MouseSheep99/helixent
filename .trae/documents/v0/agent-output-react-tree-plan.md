# Agent Output Graph 开发文档

## 1. 目标

将 Web UI 的 Agent Output 从“扁平大卡片流”改造成适配 ReAct 过程的层级 Graph 展示：

- 一级：一次用户 query 对应的 `Run`
- 二级：该 run 内的一次 ReAct loop，对应 `ReAct Step`
- 三级：step 内的 `Thinking`、`Tool`、`Response`、`Error` 等 detail 节点

第一期只优化 Agent Output，不设计完整 Trace Graph，不改后端接口，不改 agent loop 语义。

最终用户应该能在折叠态看到：

- 一轮 query 里有几次 ReAct loop
- 每次 ReAct loop 调用了几个工具
- 工具名称是什么
- 哪个 step/tool 成功、pending 或失败

展开后再看：

- thinking 原文
- tool input JSON
- tool result
- response 全文
- sent prompt `◐`

## 2. 明确非目标

第一期不要做这些事情，避免范围失控：

- 不新增后端 Agent Output API
- 不新增后端 Graph 存储
- 不修改 `POST /api/sessions/:id/messages`
- 不修改 SSE event type
- 不修改 `GET /api/traces/:traceId`
- 不迁移 `tool_execution_started` / `tool_execution_completed`
- 不新增 `afterToolUseError`
- 不强制给 message row 补 `requestId`
- 不强制给 output row 补 `step`
- 不把 middleware/hook/skills/prompt version/token usage 混进 Agent Output 主结构
- 不做完整 Trace Graph
- 不在第一期追求精确耗时和 token 统计

后续如果要做精确耗时、token、middleware hook、skills load 关系，应单独设计 `TraceGraph` 或 Agent Output metadata 扩展。

## 3. 当前前后端数据流

### 3.1 实时运行链路

相关文件：

- `web/server.ts`
- `web/types.ts`
- `web/public/app.js`
- `web/public/view.js`

当前实时 Agent Output 不走独立查询接口，而是由 SSE 驱动：

1. 用户在 composer 输入 query。
2. 前端调用 `POST /api/sessions/:id/messages`。
3. `web/server.ts` 的 `submitMessage()` 创建 user message。
4. 服务端执行 `session.agent.stream(userMessage)`。
5. 服务端通过 SSE 推送：
   - `message`
   - `trace`
   - `hook`
   - `streaming_state`
   - `approval`
   - `question`
   - `todo_update`
   - `error`
6. 前端 `handleServerEvent()` 收到事件后更新状态。
7. 与 Agent Output 相关的数据会进入 `state.traceRows`。
8. `renderOutput()` 调用 `View.renderOutputHTML(state.traceRows, options)`。

### 3.2 历史回放链路

相关文件：

- `web/server.ts`
- `web/trace.ts`
- `web/public/app.js`
- `web/public/view.js`

当前历史回放使用 trace 文件接口：

1. 前端调用 `GET /api/traces/:traceId`。
2. 服务端返回 `{ id, events }`。
3. 前端 `openTrace()` 将 `events` 放进 `state.traceRows`。
4. 同样调用 `renderOutputHTML()` 渲染 Agent Output。

因此第一期 Graph builder 的输入应该继续是 `state.traceRows`，这样实时和回放共用同一套渲染逻辑。

## 4. 当前 Agent Output 实际消费的数据

当前 `web/public/view.js` 的 `renderOutputHTML()` 只渲染以下 row：

### 4.1 `message` row

形态：

```ts
type MessageRow = {
  type: "message";
  message: NonSystemMessage & { __skipModelOutput?: boolean };
  __clientReceivedAt?: string;
};
```

来源：

- SSE `message` event
- trace replay 中的 `{ type: "message", message }`

用途：

- `role: "user"`：用户 query，可作为 `Run` 边界。
- `role: "tool"`：工具结果，可归属到某个 `ToolCallNode`。
- `role: "assistant"`：少量 assistant message；如果带 `__skipModelOutput`，不重复渲染。

注意：

- 前端 `outputMessageForTraceRow()` 会给包含 `thinking` / `text` / `tool_use` 的 assistant message 标记 `__skipModelOutput`。
- 原因是这些 assistant blocks 已经由 `model_output_block` trace row 渲染。

### 4.2 `input_context` row

形态：

```ts
type InputContextRow = {
  kind: "input_context";
  at?: string;
  data?: {
    prompt?: string;
    messages?: unknown[];
    tools?: unknown[];
    source?: "runtime" | "draft" | "prompt_version";
    versionId?: string | null;
    versionName?: string | null;
  };
};
```

用途：

- 不作为 Agent Output 主节点。
- 只记录最近 sent prompt row index。
- 给 `◐` 按钮打开“本轮实际送入模型的 system prompt”弹窗。

### 4.3 `model_output_block` row

形态：

```ts
type ModelOutputBlockRow = {
  kind: "model_output_block";
  data?: {
    blockIndex?: number;
    block?: ThinkingBlock | ToolUseBlock | TextBlock | Record<string, unknown>;
  };
};
```

用途：

- `block.type === "thinking"` -> `Thinking` detail 节点。
- `block.type === "tool_use"` -> `ToolCallNode.request`。
- `block.type === "text"` -> `Response` detail 节点。

### 4.4 `tool_call_detected` row

形态：

```ts
type ToolCallDetectedRow = {
  kind: "tool_call_detected";
  data?: {
    blockIndex?: number;
    toolUse?: {
      id?: string;
      type?: "tool_use";
      name?: string;
      input?: unknown;
    };
  };
};
```

用途：

- 当前 UI 会单独显示 “Harness detected tool call”。
- Graph 里不建议单独做大卡片。
- 应归属到对应 `ToolCallNode.detected`，作为 tool 的辅助 detail。

### 4.5 `error` row

形态：

```ts
type ErrorRow = {
  kind: "error";
  label?: string;
  data?: {
    message?: string;
    showInOutput?: boolean;
  };
};
```

用途：

- 显示 runtime error。
- 如果 `data.showInOutput === false`，不进入 Agent Output。
- Graph 里归入当前 run 的 `errors`，并影响 run status。

### 4.6 Pending human actions

来源：

- `state.pendingApproval`
- `state.pendingQuestion`

用途：

- 继续追加在 Agent Output 末尾。
- 第一版不强行归到某个 ReAct step。

## 5. Agent Output Graph 输入过滤

新增函数：

```ts
function isAgentOutputRow(row) {
  if (row?.type === "message" && row.message) return true;
  if (row?.kind === "input_context") return true;
  if (row?.kind === "model_output_block") return true;
  if (row?.kind === "tool_call_detected") return true;
  if (row?.kind === "error") return row.data?.showInOutput !== false;
  return false;
}
```

明确排除：

- `hook_triggered`
- `skills_inventory`
- `skill_system_injected`
- `skill_loaded`
- `prompt_version_applied`
- `prompt_version_saved`
- `prompt_version_activated`
- `prompt_version_deleted`
- `tool_execution_started`
- `tool_execution_completed`
- `token_usage`
- `todo_update`
- `agent_progress`
- `session_created`
- `session_cleared`
- `session_aborted`

这些数据属于 Trace/Timeline 范围，不进入第一期 Agent Output Graph。

## 6. Graph 数据结构

新增 `buildAgentOutputGraph(rows, options)`，从 `state.traceRows` 派生 ViewModel。

Graph 不写入后端、不写入 trace 文件、不作为 API response。

```ts
type AgentOutputGraph = {
  runs: AgentRunNode[];
  nodeById: Record<string, AgentOutputNode>;
};

type AgentOutputNode = AgentRunNode | ReactStepNode | ToolCallNode | AgentOutputItem;

type AgentRunNode = {
  id: string; // run:<index>
  type: "run";
  index: number;
  title: string;
  user?: AgentOutputItem;
  sentPromptRowIndex: number;
  status: "running" | "success" | "error";
  steps: ReactStepNode[];
  errors: AgentOutputItem[];
};

type ReactStepNode = {
  id: string; // step:<runIndex>:<stepIndex>
  type: "react_step";
  runIndex: number;
  stepIndex: number;
  title: string;
  status: "pending" | "running" | "success" | "error";
  thinking: AgentOutputItem[];
  tools: ToolCallNode[];
  response: AgentOutputItem[];
  errors: AgentOutputItem[];
};

type ToolCallNode = {
  id: string; // tool:<toolUseId> or tool:<runIndex>:<stepIndex>:<toolIndex>
  type: "tool";
  toolUseId?: string;
  name: string;
  input?: unknown;
  request?: AgentOutputItem;
  detected?: AgentOutputItem;
  result?: AgentOutputItem;
  status: "pending" | "success" | "error";
};

type AgentOutputItem = {
  id: string;
  type:
    | "user"
    | "thinking"
    | "tool_use"
    | "tool_detected"
    | "tool_result"
    | "response"
    | "error";
  rowIndex: number;
  blockIndex?: number;
  content: unknown;
};
```

## 7. Graph 构建规则

### 7.1 Run 边界

规则：

- 遇到 `role: "user"` 的 message row 创建新 run。
- run title 来自 user message 文本摘要。
- `input_context` 不创建 run。
- 如果 `input_context` 出现在 user message 前：
  - 先缓存为 `pendingSentPromptRowIndex`。
  - 下一个 run 创建时挂到 `run.sentPromptRowIndex`。
- 如果 `input_context` 出现在 run 已存在时：
  - 更新当前 run 的 `sentPromptRowIndex`。
- 老 trace 如果没有 user message：
  - 创建 `Legacy Run`。
  - 将后续 output rows 放入该 run。

### 7.2 ReAct Step 边界

规则：

- 一个 step 表示一次 `_think()` + 后续 `_act()`。
- 由于第一期不依赖后端 step id，step 由前端顺序推导。
- 遇到 `thinking` 或第一个 `tool_use` block 时，如果当前 run 没有 active step，则创建 step。
- 同一 assistant/model response 里的：
  - `thinking`
  - 多个 `tool_use`
  - 后续 `text`
  归到同一个 step。
- 如果遇到 `text` block 且当前没有 active step：
  - 创建 response-only step。
- 如果一个 step 已经有 response，再遇到新的 `thinking` 或 `tool_use`：
  - 创建下一个 step。

### 7.3 Tool 关联

规则：

- `tool_use.id` 是优先关联键。
- `tool_result.tool_use_id` 对应 `tool_use.id`。
- `tool_call_detected.data.toolUse.id` 对应 `tool_use.id`。
- 如果没有 id：
  - fallback 使用 `tool:<runIndex>:<stepIndex>:<toolIndex>`。
- 如果 tool result 找不到对应 tool_use：
  - 创建 orphan tool。
  - 名称使用 `unknown_tool` 或从 tool result content 中尽量推断。

### 7.4 状态规则

Tool status：

- 有 request，没 result：`pending`
- 有 result，且 result content 以 `Error:` 开头：`error`
- 有 result，非 error：`success`

Step status：

- 任一 tool error 或 step errors 非空：`error`
- 任一 tool pending：`pending`
- 无 error 且无 pending：`success`

Run status：

- 任一 step error 或 run errors 非空：`error`
- 任一 step pending：`running`
- 无 error 且无 pending：`success`

## 8. 默认展开/折叠策略

### 8.1 Run

默认策略：

- 当前/最新 run 默认展开。
- 历史 run 默认折叠。
- replay 中如果只有一个 run，则默认展开。

原因：

- 用户默认需要看到这轮 query 下有哪些 ReAct steps。
- 但多轮历史不能全部展开，否则噪音太大。

交互：

- 点击 run summary：折叠/展开整个 query 下所有 ReAct steps。

### 8.2 ReAct Step

默认策略：

- 默认折叠。
- error step 可以默认展开一级，但内部 tool/detail 仍折叠。

原因：

- Step 是主要降噪层。
- 折叠态已经能看到工具数量、工具名和状态。

交互：

- 点击 step summary：展开 thinking/tool/response detail rows。

### 8.3 Tool

默认策略：

- 默认折叠。

原因：

- tool input/result JSON 通常最长。
- 当前截图里最大的问题就是 tool request JSON 默认展开。

交互：

- 点击 tool summary：展开 input/result。

### 8.4 Thinking

默认策略：

- 默认折叠。

折叠态：

- 显示一行 preview。

展开态：

- 显示完整 thinking 文本。

### 8.5 Response

默认策略：

- 默认折叠。

折叠态：

- 显示 response preview。

展开态：

- 显示完整 response。

说明：

- 第一版保持所有 detail 节点一致默认折叠。
- 如果后续认为 final response 应该更醒目，可以单独改成 final response 默认展开。

## 9. 卡片形态设计

### 9.1 总体视觉方向

从“独立大卡片”改为“树形节点”：

- run 是较大的 container card。
- step 是 run 内的次级 card/row。
- tool/detail 是 step 内的轻量 row。
- 使用缩进线表达层级。
- 使用 summary 一行表达关键信息。
- 长内容默认不展示。

### 9.2 Run 折叠态

示例：

```text
▾ Run 1                                      success
  用户 query 摘要...
  3 ReAct steps · 5 tools · read_file, grep_search, bash
  ◐ Sent prompt
```

包含：

- 展开箭头
- `Run 1`
- 状态 chip
- query 摘要
- step 数量
- tool 总数量
- tool 名称摘要
- `◐` sent prompt 入口

### 9.3 ReAct Step 折叠态

示例：

```text
  ▸ ReAct 1                                  2 tools
    Thinking + tool calls · read_file, grep_search · success
```

包含：

- 展开箭头
- `ReAct 1`
- tool count chip
- tool names
- status
- 可选 duration placeholder：第一期显示 `duration: —` 或不显示

### 9.4 ReAct Step 展开态

示例：

```text
  ▾ ReAct 1                                  success
    Thinking
    模型正在定位 skill 文件...

    ▸ read_file                              success
      path: /Users/.../skills/coding-plan/SKILL.md

    ▸ grep_search                            success
      pattern: "defineTool"

    ▸ Response                               ready
      我找到了两个相关位置...
```

### 9.5 Tool 折叠态

示例：

```text
    ▸ read_file                              success
      path: /Users/.../skills/coding-plan/SKILL.md
```

包含：

- tool name
- status chip
- input preview
- result 状态：`pending` / `result` / `error`

### 9.6 Tool 展开态

示例：

```text
    ▾ read_file                              success
      Input
      {
        "path": "/Users/.../SKILL.md"
      }

      Result
      读取成功，内容 12.4k chars...
```

注意：

- input/result 使用 `pre`。
- result 很长时仍保留 overflow/wrap。
- 第一版不加复制按钮，避免按钮过多。

### 9.7 Thinking detail

折叠态：

```text
    ▸ Thinking                               internal
      用户问的是 skills，需要先检查...
```

展开态：

```text
    ▾ Thinking                               internal
      用户问的是 skills，我需要查看当前项目中的 skills 目录...
```

### 9.8 Response detail

折叠态：

```text
    ▸ Response                               assistant
      找到了两个 skills...
```

展开态：

```text
    ▾ Response                               assistant
      找到了两个 skills：coding-plan 和 deep-research-plan...
```

## 10. 样式规范

新增或调整样式文件：

- `web/public/styles.css`

建议新增 class：

- `.agent-output-graph`
- `.agent-run`
- `.agent-run-summary`
- `.react-step`
- `.react-step-summary`
- `.tool-call`
- `.tool-call-summary`
- `.agent-detail-node`
- `.agent-node-children`
- `.agent-node-icon`
- `.agent-node-title`
- `.agent-node-subtitle`
- `.agent-node-meta`
- `.agent-node-chip`

颜色建议：

- Run success：绿色
- Run running：青色
- Run error：红色
- Step success：绿色
- Step pending/running：蓝/青色
- Step error：红色
- Tool pending：琥珀色
- Tool success：绿色
- Tool error：红色
- Thinking：紫色
- Response：绿色或中性色

布局建议：

- `.agent-output-graph`：纵向 flex，gap 12-14px。
- `.agent-run`：保留当前 output-card 的 card 质感，但内部变成 tree container。
- `.react-step`：比 run 更轻，减少 padding。
- `.tool-call` / `.agent-detail-node`：更轻量，像一行 tree row。
- `.agent-node-children`：左侧 border line + padding-left。
- summary hover：轻微 background。
- 默认去掉大段 body 的展示，body 只在 details open 时出现。

## 11. 修改范围

### 11.1 必改

`web/public/view.js`

- 新增 `isAgentOutputRow(row)`。
- 新增 `buildAgentOutputGraph(rows, options)`。
- 新增 graph 渲染函数：
  - `renderAgentOutputGraph(graph, options)`
  - `renderAgentRunNode(run, options)`
  - `renderReactStepNode(step, options)`
  - `renderToolCallNode(tool, options)`
  - `renderAgentOutputItem(item, options)`
- 修改 `renderOutputHTML()`：
  - 保留 legacy signature。
  - rows 归一化后先 build graph。
  - graph 为空且 streaming 时继续显示 `renderThinkingPlaceholderCard()`。
  - graph 为空且非 streaming 时显示 empty state。
- 保留现有 sent prompt 逻辑：
  - `latestInputContextRowIndex`
  - `renderSentPromptIcon()`
  - `renderSentPromptDialogHTML()`

`web/public/styles.css`

- 添加 graph/tree 样式。
- 保留旧 `.output-card` 样式，避免影响 pending approval/question、message history 或其他区域。
- 只让 Agent Output Graph 使用新 class。

`web/__tests__/frontend-view.test.ts`

- 更新现有 `renderOutputHTML()` 断言。
- 增加 graph builder 和 tree render 测试。

### 11.2 可能需要小改

`web/public/app.js`

- 理论上不需要改。
- 如果需要保存折叠状态，后续可在这里监听 details toggle 并写 `localStorage`。
- 第一版不建议加折叠状态持久化。

`web/__tests__/frontend-smoke.test.ts`

- 如果 smoke 测试依赖旧 output-card 文案，需要更新。

### 11.3 不应修改

- `web/server.ts`
- `web/types.ts`
- `web/trace.ts`
- `src/agent/agent.ts`
- `src/agent/agent-middleware.ts`
- `src/foundation/*`
- `src/coding/tools/*`

除非后续明确进入 Trace Graph / 精确耗时二期，否则第一期不改这些文件。

## 12. 流程示例

输入 rows：

```ts
[
  { type: "message", message: { role: "user", content: [{ type: "text", text: "查一下 skills" }] } },
  { kind: "input_context", data: { prompt: "..." } },
  { kind: "model_output_block", data: { blockIndex: 0, block: { type: "thinking", thinking: "需要查看 skills 目录" } } },
  { kind: "model_output_block", data: { blockIndex: 1, block: { type: "tool_use", id: "call_1", name: "list_files", input: { path: "/skills" } } } },
  { kind: "tool_call_detected", data: { blockIndex: 1, toolUse: { id: "call_1", name: "list_files", input: { path: "/skills" } } } },
  { type: "message", message: { role: "tool", content: [{ type: "tool_result", tool_use_id: "call_1", content: "Listed 2 entries" }] } },
  { kind: "model_output_block", data: { blockIndex: 0, block: { type: "text", text: "当前有两个 skills..." } } },
]
```

输出 graph：

```ts
{
  runs: [
    {
      id: "run:1",
      type: "run",
      title: "查一下 skills",
      sentPromptRowIndex: 1,
      status: "success",
      steps: [
        {
          id: "step:1:1",
          type: "react_step",
          status: "success",
          thinking: [{ type: "thinking" }],
          tools: [
            {
              id: "tool:call_1",
              type: "tool",
              toolUseId: "call_1",
              name: "list_files",
              status: "success",
              request: { type: "tool_use" },
              detected: { type: "tool_detected" },
              result: { type: "tool_result" }
            }
          ],
          response: [{ type: "response" }]
        }
      ],
      errors: []
    }
  ]
}
```

## 13. 测试计划

### 13.1 Graph builder 测试

文件：`web/__tests__/frontend-view.test.ts`

测试项：

- 单轮 query + thinking + 1 tool + result + response -> 1 run / 1 step / 1 tool。
- 单轮 query + 2 tool_use + 2 tool_result -> 1 run / 1 step / 2 tools。
- 多轮 user message -> 多个 runs。
- tool result 根据 `tool_use_id` 归属正确 tool。
- tool result 找不到 request -> orphan tool。
- result content 以 `Error:` 开头 -> tool/step/run status = error。
- input_context row 能设置 run.sentPromptRowIndex。
- token_usage/hook/skills rows 不进入 graph。

### 13.2 Render 测试

文件：`web/__tests__/frontend-view.test.ts`

测试项：

- `renderOutputHTML()` 输出 `.agent-output-graph`。
- 输出 `<details class="agent-run">`。
- 输出 `<details class="react-step">`。
- 输出 `<details class="tool-call">`。
- step/tool/detail 默认不带 `open`。
- latest run 默认带 `open`。
- historical run 默认不带 `open`。
- error step 默认可展开一级。
- `◐` sent prompt button 仍存在。
- pending approval/question 仍显示。

### 13.3 Smoke 测试

文件：`web/__tests__/frontend-smoke.test.ts`

测试项：

- 页面仍能加载 Agent Output 容器。
- 新 class 不影响其他面板。

### 13.4 手动验证

步骤：

1. 启动 web server。
2. 发一个不会调用工具的问题。
3. 确认显示 1 run / 1 response-only step。
4. 发一个会调用多个工具的问题。
5. 确认 run 展开，step/tool 默认折叠。
6. 展开 step，确认能看到 thinking/tool/response rows。
7. 展开 tool，确认能看到 input/result。
8. 点击 `◐`，确认 sent prompt 弹窗正常。
9. 打开历史 trace，确认 replay 仍能显示 graph。
10. 确认 Timeline/Trace 区域不受影响。

## 14. 风险和处理

### 14.1 Step 边界不完美

原因：

- 第一版不使用后端 step id。

处理：

- 用可解释的前端顺序规则。
- 遇到不确定情况，归到当前 step。
- 后续如需要精确边界，再补 metadata。

### 14.2 Tool result 找不到 tool_use

原因：

- 旧 trace 或异常事件顺序可能缺 request。

处理：

- 创建 orphan tool。
- UI 标记为 `unknown_tool`。
- 不丢失 result。

### 14.3 Response 默认折叠可能不够直观

处理：

- 第一版保持一致：所有 detail 默认折叠。
- 如果用户反馈最终回答不明显，再改 final response 默认展开。

### 14.4 旧测试依赖旧文案

处理：

- 更新测试断言为新结构。
- 不删除旧 helper，优先复用现有内容渲染函数。

## 15. 执行顺序

1. 在 `web/public/view.js` 增加 graph builder 和纯函数测试。
2. 将 `renderOutputHTML()` 切换为 graph render。
3. 增加 run/step/tool/detail 渲染函数。
4. 增加 `web/public/styles.css` 树形样式。
5. 更新 `frontend-view.test.ts`。
6. 如 smoke 受影响，更新 `frontend-smoke.test.ts`。
7. 运行 `bun run check`。
8. 手动验证实时 query 和 replay trace。

## 16. 验收标准

- Agent Output 不再是 thinking/tool/request/result 的扁平大卡片列表。
- 一轮 query 显示为一个 run。
- run 下显示 ReAct steps。
- step 下显示 tool/detail rows。
- Run 可以整体折叠。
- Step 默认折叠。
- Tool 默认折叠。
- Thinking 默认折叠。
- Response 默认折叠。
- Tool JSON input/result 不再默认铺开。
- `◐` sent prompt 功能不回归。
- pending approval/question 不回归。
- replay trace 不回归。
- Timeline/Trace 面板不受影响。
- `bun run check` 通过。
