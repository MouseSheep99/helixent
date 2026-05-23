# Web 稳定性与 Prompt/SSE 体验修复方案

## Summary

最近排查链路里发现：

- 浏览器报 `net::ERR_INCOMPLETE_CHUNKED_ENCODING /api/sessions/.../events`
- 服务端日志：`[Bun.serve]: request timed out after 10 seconds. Pass idleTimeout to configure.`
- 前端 `Agent Output` 看似空白
- 后端 session 仍 `streaming = true`，下次发送被 409 `Agent is already running.`
- 用户在右侧改 system prompt，**实际不会随发送 query 一起提交**，容易混淆

本计划只解决最关键、最影响实际使用的几点，不做扩张。

按优先级：

1. **P1 修 SSE 稳定性**：Bun 10s idle timeout + 缺少 heartbeat
2. **P2 发送态交互**：running 时禁用发送按钮，避免用户重复点造成 409
3. **P3 Agent Output 空状态优化**：run 一开始就显示占位卡片
4. **P4 Prompt 编辑语义提示**：明确 prompt editor 与 send query 的关系

---

## Current State Analysis

### SSE 实现

[web/server.ts](file:///Users/bytedance/Documents/Codex/helixent/web/server.ts#L108-L123) `Bun.serve(...)` 没有传 `idleTimeout`：

```ts
const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(req) { ... },
});
```

Bun 默认 `idleTimeout = 10s`，长连接 10 秒内无写入就会被切断。

[web/server.ts](file:///Users/bytedance/Documents/Codex/helixent/web/server.ts#L668-L708) `eventStream(...)` 只有真业务事件才 `enqueue`，没有 heartbeat：

```ts
client.send({ type: "ready", sessionId, commands });
// 之后只有业务事件才会 enqueue
```

也没有 `controller.enqueue(": ping\n\n")` 之类 keepalive。

前端 [app.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app.js#L210-L223) 用 `EventSource`：

```ts
source.onerror = () => {
  els.progressStatus.textContent = "SSE reconnecting";
};
```

EventSource 自带重连，但每次断都会丢失中间事件，并且服务端的 `session.clients` 里旧 client 会先被踢，新 client 重新订阅，体验上看起来就是 UI “定住了”。

### 发送态保护

后端在 [submitMessage](file:///Users/bytedance/Documents/Codex/helixent/web/server.ts#L377-L384) 严格保护：

```ts
if (session.streaming) {
  throw new HttpError("Agent is already running.", 409);
}
```

前端 [submitPrompt](file:///Users/bytedance/Documents/Codex/helixent/web/public/app.js#L304-L314) 没有任何状态判断：

```ts
async function submitPrompt(event) {
  event.preventDefault();
  if (!state.session) return;
  const text = els.promptInput.value.trim();
  if (!text) return;
  els.promptInput.value = "";
  await api(`/api/sessions/${state.session.sessionId}/messages`, {
    method: "POST",
    body: { text },
  });
}
```

也就是说：

- agent 还在 running
- 用户敲 Enter 一次，前端就直接 POST
- 后端返回 409
- 抛到 `api()` 的 `throw new Error(...)` → console error

### Agent Output 空状态

[view.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view.js#L827-L829)：

```ts
return cards.length ? `<div class="output-stack">${cards.join("")}</div>`
  : `<div class="empty-state">No model output or pending human action yet.</div>`;
```

而 streaming 中 agent 还没产出 first message / tool_call_detected / model_output_block 时，`cards` 为空，于是显示 `No model output or pending human action yet.`，看起来就是“啥也没打印”。

实际此时 `state.progress` 已经在更新（`Thinking` / `Tool · xxx`），但只渲染在顶部 `Run Metrics`，主区域没有视觉反馈。

### Prompt Editor 与 Send Query 的语义

[submitPrompt](file:///Users/bytedance/Documents/Codex/helixent/web/public/app.js#L304-L314) 只发 `{ text }`，不带 `prompt`。

只有显式 `Save` / `Save & Activate` 后，才会通过 prompt versions 走到 `beforeModel` 真正影响请求。

UI 上没有任何提示告诉用户这件事，所以容易误以为“我刚改的 system prompt 会立刻生效”。

---

## Proposed Changes

### 1. P1：修 SSE 稳定性

**目的**：消除 `ERR_INCOMPLETE_CHUNKED_ENCODING`，让 SSE 长连接稳定。

#### 1.1 给 `Bun.serve` 加 `idleTimeout`

文件：[web/server.ts](file:///Users/bytedance/Documents/Codex/helixent/web/server.ts#L108-L123)

改动：

```ts
const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  idleTimeout: 0, // 0 = no timeout，给 SSE 长连接放行
  async fetch(req) { ... },
});
```

> 也可以选 `255`（Bun 上限）。这里选 `0` 表示禁用 idle timeout，因为我们用 SSE，并且服务端有自己的 `signal.abort` 处理。

#### 1.2 SSE heartbeat

文件：[web/server.ts](file:///Users/bytedance/Documents/Codex/helixent/web/server.ts#L668-L708) `eventStream(...)`

在 `start(controller)` 里加：

```ts
const heartbeat = setInterval(() => {
  try {
    controller.enqueue(encoder.encode(`: ping\n\n`));
  } catch {
    clearInterval(heartbeat);
  }
}, 15000);
```

并在 `signal abort` 和 `cancel()` 时 `clearInterval(heartbeat)`。

> 即使我们已经把 idleTimeout 设为 0，加 heartbeat 仍是稳健做法，可以兼容反向代理 / 浏览器侧空闲断连。

### 2. P2：发送态交互防重复

**目的**：running 时禁用发送按钮，避免触发 409。

#### 2.1 state 增加 `streaming` 状态

文件：[web/public/app.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app.js)

- 在 `state` 上加 `streaming: false`
- `handleAgentEvent` 收到 agent_started/finished 等事件时更新 `state.streaming`（已有 `state.progress`，这里只需加一个 `state.streaming` 布尔）

具体来源（已有事件）：
- `agent_started` / `agent_finished` / `agent_aborted` / `agent_error` 这些 hook 事件

也可以更简单：用 `state.progress` 是否为 `null` / 是否处于 active 状态来推断；为了清晰建议显式维护 `state.streaming`。

#### 2.2 提交前判断

[submitPrompt](file:///Users/bytedance/Documents/Codex/helixent/web/public/app.js#L304-L314)：

```ts
async function submitPrompt(event) {
  event.preventDefault();
  if (!state.session) return;
  if (state.streaming) {
    flashStatus("Agent is already running. Abort or wait first.");
    return;
  }
  const text = els.promptInput.value.trim();
  if (!text) return;
  ...
}
```

`flashStatus` 可以直接复用 `els.exportStatus` 或者 `els.progressStatus`，不新引入组件。

#### 2.3 UI 禁用发送按钮

`renderRunState()` 里根据 `state.streaming` 设置：

- 提交按钮 `disabled = true`
- 文案改为 `Running…`
- 输入框可保持可编辑

需要确认提交按钮的 DOM id（已存在 [composer](file:///Users/bytedance/Documents/Codex/helixent/web/public/app.js#L123) 表单），按钮通过 `els.composer.querySelector('button[type="submit"]')` 取。

### 3. P3：Agent Output 空状态优化

**目的**：run 一开始就显示一个占位卡片，避免用户以为“没反应”。

#### 3.1 `renderOutputHTML` 增加 streaming 分支

文件：[web/public/view.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view.js#L827-L829)

把：

```ts
return cards.length ? `<div class="output-stack">${cards.join("")}</div>`
  : `<div class="empty-state">No model output or pending human action yet.</div>`;
```

改为：

```ts
if (cards.length) return `<div class="output-stack">${cards.join("")}</div>`;
if (options.streaming) {
  return `<div class="output-stack">${renderThinkingPlaceholderCard(options.progress)}</div>`;
}
return `<div class="empty-state">No model output or pending human action yet.</div>`;
```

新增 `renderThinkingPlaceholderCard(progress)`：

- 显示一个 `Thinking…` 占位卡
- 副标题用 `progress.subtype === "tool" ? "Tool · " + progress.name : "Waiting for model response"`

`options` 在 `renderOutput()` 调用 `renderOutputHTML(options)` 时新增：

- `streaming: state.streaming`
- `progress: state.progress`

#### 3.2 占位卡 CSS

文件：[web/public/styles.css](file:///Users/bytedance/Documents/Codex/helixent/web/public/styles.css)

增加 `.output-card.thinking-placeholder`，复用现有 `thinking` 样式即可，不引入新颜色。

### 4. P4：Prompt Editor 语义提示

**目的**：让用户清楚知道 prompt editor 改动不会立即生效。

#### 4.1 在 Prompt Lab 顶部加一行提示

文件：[web/public/index.html](file:///Users/bytedance/Documents/Codex/helixent/web/public/index.html)

在 prompt textarea 上方加：

```html
<p class="prompt-editor-hint">
  Editing here is a draft. Click Save & Activate to apply for the next request.
</p>
```

样式在 [styles.css](file:///Users/bytedance/Documents/Codex/helixent/web/public/styles.css) 加 `.prompt-editor-hint`，弱化色。

#### 4.2 不改提交链路

不动 [submitPrompt](file:///Users/bytedance/Documents/Codex/helixent/web/public/app.js#L304-L314)。

继续保持“draft 必须显式保存”的语义，避免引入隐式覆盖运行时 prompt 的复杂性。

---

## Assumptions & Decisions

- **`idleTimeout: 0`**：禁用空闲超时，让 SSE 长连接长期可用。如果未来发现连接资源泄露，再调成有限值（例如 600 秒）+ heartbeat 保活组合策略。
- **heartbeat 间隔 15 秒**：远低于常见代理的 60 秒空闲阈值，足够防断；也不会刷屏服务端日志。
- **不自动续传 SSE 中间事件**：EventSource 自动重连保留现状，先解决“被切断”的根因；中间事件丢失目前不在范围内。
- **不改 `submitPrompt` 提交体的 payload**：保留“editor draft 必须显式 Save & Activate”的语义。
- **不引入 toast 组件**：复用 `els.progressStatus` / `els.exportStatus` 这类已有节点提示。
- **不动 trace / message 事件结构**：不做 schema 改动，只是 UI 层增加占位卡。

---

## File Touch List

| 文件 | 改动 |
|---|---|
| [web/server.ts](file:///Users/bytedance/Documents/Codex/helixent/web/server.ts) | `Bun.serve idleTimeout`、`eventStream heartbeat` |
| [web/public/app.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app.js) | `state.streaming`、`submitPrompt` 防重复、`renderRunState` 同步禁用按钮、把 streaming/progress 透传给 `renderOutput` |
| [web/public/view.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view.js) | `renderOutputHTML` 加 streaming 分支、新增 `renderThinkingPlaceholderCard` |
| [web/public/index.html](file:///Users/bytedance/Documents/Codex/helixent/web/public/index.html) | Prompt Lab 顶部加提示行；按需 bump 静态资源缓存号 |
| [web/public/styles.css](file:///Users/bytedance/Documents/Codex/helixent/web/public/styles.css) | `.prompt-editor-hint` 弱化样式、占位卡样式微调 |
| [web/__tests__/frontend-view.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-view.test.ts) | 新增/调整：streaming 占位卡渲染断言 |
| [web/__tests__/frontend-smoke.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-smoke.test.ts) | 新增：prompt-editor-hint 节点存在 |

---

## Verification Steps

### 自动测试

- `bun run check` 全量
- 重点关注：
  - `frontend-view.test.ts`：streaming 占位卡渲染
  - `frontend-smoke.test.ts`：新加的 hint 节点

### 手动验证

1. 启动 `bun run web/server.ts`
2. 打开页面，新建 session
3. 不触发任何动作，等 30s+；观察 DevTools Network → `events` 不再被切断
4. 发起一条会卡较久的 query：
   - `Agent Output` 立刻出现 `Thinking…` 占位卡
   - 提交按钮变成 `Running…` 且不可点击
   - 在按钮 disabled 期间继续敲 Enter，不再触发 `Agent is already running.`
5. abort 当前 run：
   - 占位卡消失或变成最终结果卡
   - 提交按钮恢复可点
6. Prompt Lab 顶部能看到 hint 文案

### 回归

- 历史 session replay 正常
- skills `/coding-plan` 触发链路不受影响
- ◐ 弹窗 sent prompt 正常显示

---

## Out of Scope

- 不做 prompt editor live-bind 到下次发送（保留显式 Save 流程）
- 不做 SSE 中间事件补偿/续传
- 不做 tools CRUD（之前已经讨论过，这里不动）
- 不修改 schema 弹窗（已经在另一个改动里完成三段式）
- 不动 skills 加载顺序与目录探测
