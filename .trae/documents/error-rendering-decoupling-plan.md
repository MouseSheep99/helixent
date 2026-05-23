# 错误渲染与 Run 解耦改造方案

## 0. 触发问题（事故复盘）

用户在 composer 里粘贴了一张 > 5 MB 的截图。前端 [addPendingImages](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/session.js#L128-L159) 的本地校验失败后调用 [showError](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/api.js#L21-L34)，结果错误以 "ERR · Runtime error · Image too large (max 5 MB) ..." 的形式被挤进了上一轮已经结束的 `Run 2 → ReAct 7` 内部，看起来就像 agent 自己运行出错。

实际上图片根本没有发出去（在客户端校验阶段就被拒绝），它和 agent runtime 没有任何因果关系，但当前的渲染管线把它当成了 trace event。

## 1. 目标

1. **客户端 UI 校验错** 与 **agent 运行错** 在数据通道与渲染位置上彻底分开。
2. 前端 graph 数据结构新增**系统级错误容器**，使「与任何 Run 无关的错误」有合法落点，不再被强行挂载到最近的 Run 上。
3. error 事件本身需要带 `source / scope` 字段以表达来源，方便后续统计 / 过滤 / 导出区分。
4. 改动最小化：保留现有 trace event / agent-output-graph / export 协议，仅做加法（新字段 + 新容器 + 新展示位）。

## 2. 现状分析

### 2.1 数据流概览

```
[ 服务端 SSE error ]                          [ 客户端 UI 校验错 ]
        │                                              │
        ▼                                              ▼
session.js handleServerEvent:                addPendingImages / readFileAsDataURL:
  if event.type === "error"                    showError("Image too large...")
    showError(event.message, …)
        │                                              │
        └──────────────► api.js showError ◄────────────┘
                              │
                              ├─ state.events.push(event)        ← 污染
                              ├─ appendTraceRow(event)            ← 污染
                              └─ renderTimeline / renderRunState / renderOutput
```

`showError` 是一个口子，但被两个语义完全不同的来源共用。

### 2.2 graph 构建（[buildAgentOutputGraph](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/agent-output-graph.js#L15-L207)）

- 入参 `state.traceRows`（注入了客户端假事件）
- error 分支（[L189-L200](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/agent-output-graph.js#L189-L200)）：
  ```js
  if (row.kind === "error" && row.data?.showInOutput !== false) {
    const run = ensureRun(rowIndex);
    ...
    if (currentStep) currentStep.errors.push(item);
    else run.errors.push(item);
  }
  ```
- `ensureRun` 在没有任何 user message 时会强行造一个 `Legacy Run`；存在 user message 时会把错误挂到最近的 Run 之下；存在 currentStep 时再下沉到 step.errors。

**这是问题核心**：`ensureRun(rowIndex)` 把"任何错误必须找一个 Run 收容"作为前提，但客户端校验错**根本没有 Run 归属**。

### 2.3 timeline 与 export 的旁路影响

- `renderTimeline` 也会消费 `state.events`，把客户端假事件作为 timeline item 渲染（虽然不致错位，但语义错误）。
- [export.js#L155-L157](file:///Users/bytedance/Documents/Codex/helixent/web/public/export.js#L155-L157) 与 [#L185-L192](file:///Users/bytedance/Documents/Codex/helixent/web/public/export.js#L185-L192) 也会把客户端假错误写进 trace 导出，污染分享出去的 trace。

### 2.4 现有错误可能的来源清单

| 触发点 | 文件 | 性质 | 是否 trace 事件 |
|---|---|---|---|
| 服务端推 `error` SSE | session.js#L332 | 服务端运行错（agent / hook / tool runtime） | ✅ 是 |
| addPendingImages mime / size / 上限 / FileReader | session.js#L132/L136/L140/L155 | 客户端校验 | ❌ 不是 |
| prompt 编辑、保存、reset 失败 | prompt.js#L29/58/68/72/286/346 | 客户端 UI 操作错 | ❌ 不是 |
| config 表单未填齐 | config.js#L30/43 | 客户端表单校验 | ❌ 不是 |
| init 启动失败 | app.js#L18 | 客户端启动错 | ❌（应当 banner 提示） |

→ 当前 14 处 `showError` 中 **13 处都不是 trace 事件**，但它们都会被错误地写入 `state.events / state.traceRows`。

## 3. 设计要点

### 3.1 字段新增（trace event level）

为 `kind: "error"` 事件**显式增加来源元数据**：

```jsonc
{
  "id": "...",
  "kind": "error",
  "at": "...",
  "label": "human readable",
  "data": {
    "message": "...",
    "source": "client" | "server",   // 新增：错误来源
    "scope": "ui" | "trace",          // 新增：是否需要落入 trace 流
    "showInOutput": true              // 现有字段保留
  }
}
```

约定：
- `source: "server"` + `scope: "trace"` → 进入 events/traceRows，按现有逻辑挂到 Run。
- `source: "client"` + `scope: "ui"` → **不进入** events/traceRows，仅触发 UI 通知通道。
- 兜底：缺省视为 `server` + `trace`（向后兼容）。

### 3.2 graph 数据结构新增字段

`graph` 顶层增加 `systemErrors`：

```ts
type AgentOutputGraph = {
  runs: Run[];
  nodeById: Record<string, Node>;
  systemErrors: ErrorItem[];   // 新增：与任何 Run 无关的错误
};
```

收容范围：
- 任何 `kind === "error"` 但**当前还没有任何 Run** 时，落到 `graph.systemErrors`，不再 `ensureRun()` 造假 Run。
- `source === "client"` 的错误如果意外混入 traceRows（兼容场景），也归到 `systemErrors`。
- Run 内部产生的服务端错误仍然走 `run.errors / step.errors`，**这个不变**。

### 3.3 客户端 UI 错通道（不入 trace）

`showError(message, options)` 拆成两个职能：

```js
showError(message, { source = "server", scope = "trace", showInOutput = true } = {})
  ├─ if scope === "ui":
  │     showNotice(message, { tone: "error" })   // 新增 toast/banner，不写 state
  │     return;
  └─ else: 走原 trace 写入逻辑
```

新增 `showNotice(message, { tone, autoDismissMs = 5000 })`：
- 渲染到 composer 上方一个 `<div id="appNotices" class="app-notices">`；
- 多条堆叠，每条独立计时自动隐藏；
- 关闭按钮可手动 dismiss；
- 不向 `state.events / state.traceRows` 写任何东西。

### 3.4 调用点迁移

`session.js` 的 4 处 composer 校验失败 + `prompt.js` 的 6 处 + `config.js` 的 2 处 + `app.js` 的 1 处启动错 → 全部传 `{ scope: "ui" }`。

服务端 SSE 推上来的 error（`session.js#L332` `handleServerEvent`）保持现状（默认 `scope: "trace"`）。

### 3.5 渲染位置

- `agent-output-graph` 顶部新增 `<div class="agent-output-system-errors">` 区块，渲染 `graph.systemErrors`（折叠/灰色调）。
- timeline 不再受客户端错影响（因为根本不进 events）。
- export 同步：`graph.systemErrors` 单独成 section，避免污染 trace 主体。

## 4. 改动文件清单

### 4.1 [web/public/app/api.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/api.js)

- 把 `showError` 改造为按 `scope` 分流：`scope === "ui"` 走 `showNotice`，否则走 trace。
- 给 trace 写入路径的 event.data 增加 `source`、`scope` 字段。
- 新增 `showNotice(message, { tone, autoDismissMs })` 函数。

### 4.2 [web/public/app/state.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/state.js)

- 在 `els` 增加 `appNotices: $("appNotices")` 引用。

### 4.3 [web/public/index.html](file:///Users/bytedance/Documents/Codex/helixent/web/public/index.html)

- 在 composer 上方插入 `<div id="appNotices" class="app-notices" aria-live="polite"></div>`。
- cache version `v=trace-lens-workbench-63` → `v=trace-lens-workbench-64`（styles.css + app.js）。

### 4.4 [web/public/styles/composer.css](file:///Users/bytedance/Documents/Codex/helixent/web/public/styles/composer.css)（或新建 [styles/notices.css](file:///Users/bytedance/Documents/Codex/helixent/web/public/styles/notices.css)）

- 新增 `.app-notices`、`.app-notice`、`.app-notice[data-tone="error"]`、`.app-notice-close` 样式：
  - 堆叠 chip 风格，红色边 + 浅红底，右侧 ×。
  - 限制最大宽度，自适应布局，不挤占 composer 空间。

如新建文件，需在 [styles.css](file:///Users/bytedance/Documents/Codex/helixent/web/public/styles.css) 加 `@import url("./styles/notices.css");`。

### 4.5 [web/public/app/session.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/session.js)

- 4 处 `addPendingImages` 校验失败 + `readFileAsDataURL` 失败 → 改为 `showError(msg, { scope: "ui" })`。
- `handleServerEvent` 中 `event.type === "error"` 一行保持不变（服务端错继续入 trace）。

### 4.6 [web/public/app/prompt.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/prompt.js)

- 6 处 `showError(...)` 改为 `showError(msg, { scope: "ui" })`。

### 4.7 [web/public/app/config.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/config.js)

- 2 处 `showError(...)` 改为 `showError(msg, { scope: "ui" })`。

### 4.8 [web/public/app.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app.js)

- `init().catch(...)` 改为 `showError(error.message, { scope: "ui" })`。

### 4.9 [web/public/view/agent-output-graph.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/agent-output-graph.js)

- `buildAgentOutputGraph` 初始化 `graph.systemErrors = []`。
- error 分支改为：
  ```js
  if (row.kind === "error" && row.data?.showInOutput !== false) {
    const item = addItem({ id, type: "error", rowIndex, content: row, text: row.label || ... });
    const isClient = row.data?.source === "client" || row.data?.scope === "ui";
    if (isClient || !currentRun) {
      graph.systemErrors.push(item);
    } else if (currentStep) {
      currentStep.errors.push(item);
    } else {
      currentRun.errors.push(item);
    }
  }
  ```
- 删除 `ensureRun(rowIndex)` 在 error 分支造 Legacy Run 的副作用。
- `renderAgentOutputGraph(graph)` 在 `runs.map(...)` 之前先渲染 `graph.systemErrors`：
  ```html
  ${graph.systemErrors.length ? `<details class="agent-output-system-errors" ...>...</details>` : ""}
  ```

### 4.10 [web/public/styles/agent-output-graph.css](file:///Users/bytedance/Documents/Codex/helixent/web/public/styles/agent-output-graph.css)

- 新增 `.agent-output-system-errors` 容器样式：低饱和红色顶部条，标题 "System notices"，与 Run 卡片视觉上区分。

### 4.11 [web/public/export.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/export.js)

- 导出 graph 时：systemErrors 单独成 section "System Notices"。
- 同步 [shouldRenderOutputRow](file:///Users/bytedance/Documents/Codex/helixent/web/public/export.js#L192) 逻辑：`source === "client"` 不再被视为 output row（与 agent-output-graph 一致）。

### 4.12 测试

- 新增 [web/__tests__/frontend-error-routing.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-error-routing.test.ts)：
  - E1：`buildAgentOutputGraph` 输入 `[client error]`（无 Run）→ `graph.systemErrors.length === 1` 且 `graph.runs.length === 0`。
  - E2：`buildAgentOutputGraph` 输入 `[user msg, server error]` → `runs[0].errors.length === 1`，`graph.systemErrors.length === 0`。
  - E3：`buildAgentOutputGraph` 输入 `[user msg, react step, client-source error]` → 客户端错落 `systemErrors`，**不**挂到最近的 Run。
  - E4：缺省/老格式 error event（无 source/scope）→ 视为 server，挂到 Run，向后兼容。

- 已有测试保持绿（`bun run check`）。

## 5. 假设与决策

1. **不引入新依赖**。toast/banner 用纯 DOM + CSS 实现，与现有 ink-free 渲染体系一致。
2. **不修改服务端协议**。error event 增加的 `source / scope` 字段只在前端 `showError` 内自填，不要求服务端配合。
3. **`source` 默认值 = "server"**，保证旧 trace 文件和 SSE event 即使没带这两个字段，也按现有行为处理（向后兼容）。
4. **systemErrors 不参与 timeline**：timeline 是 trace event 的视图，client UI 错本就不进 events，自然不参与；服务端"无 Run 错误"理论上也存在（如启动期），但目前未观察到，systemErrors 主要服务于 graph 视图作为兜底容器。
5. **不抹去客户端错可见性**：`showNotice` 是显眼的红色 banner + 自动隐藏 + 手动关闭，可见性强于先前混在 graph 里的"runtime error"。
6. **不重写 timeline / export 主流程**：仅在 export 入口对 `systemErrors` 单独成 section。
7. **prompt.js / config.js / app.js 的 showError 一并迁移**：它们与 image 校验错本质相同（客户端 UI 错），顺手统一，避免遗漏导致再次错位。

## 6. 验证步骤

1. `bun run check:types` 通过。
2. `bun run lint` 通过。
3. `bun test` 通过；新增 `frontend-error-routing.test.ts` 4 case 全过。
4. 手动验证（在浏览器内）：
   - **场景 A**：上传 6 MB 图片 → 顶部红色 banner "Image too large (max 5 MB): ..."；agent-output-graph **无新内容**；timeline **无新事件**；export 不包含此条目。
   - **场景 B**：上传不支持的 mime（如 `image/svg+xml`）→ 同上。
   - **场景 C**：超过 4 张图片 → 同上。
   - **场景 D**：服务端真的抛 error（例如手动关 API key 触发模型调用失败）→ 仍然在最近的 Run 内显示 "Runtime error"，与改造前一致。
   - **场景 E**：banner 5 秒后自动消失，× 可手动关闭。

## 7. 不在范围内（Out of Scope）

- 不改服务端 `error` event 协议（不动 `web/types.ts` / `web/server.ts`）。
- 不重新设计 timeline 错误展示。
- 不引入第三方 toast 组件。
- 不修改图片功能本身（Stage A-E 已完成）。
