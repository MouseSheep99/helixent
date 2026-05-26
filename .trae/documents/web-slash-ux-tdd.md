# Web Slash 指令 UX 体验升级 — 技术开发文档（TDD）

> 配套 PRD：[web-slash-ux-prd.md](file:///Users/bytedance/Documents/Codex/helixent/.trae/documents/web-slash-ux-prd.md)
> 上游已落地：[web-slash-commands-prd.md](file:///Users/bytedance/Documents/Codex/helixent/.trae/documents/web-slash-commands-prd.md) + [web-slash-commands-tdd.md](file:///Users/bytedance/Documents/Codex/helixent/.trae/documents/web-slash-commands-tdd.md)（PR-1/2/3 已合入）
> 状态：Draft · 范围：Web 前端（textarea / suggestion popover / Agent Output / Timeline）+ 后端（command_registry · server.ts SSE / HTTP）
>
> 关键代码锚点：
> - 解析层：[command-registry.ts](file:///Users/bytedance/Documents/Codex/helixent/src/cli/tui/command-registry.ts)
> - 分发层：[slash-dispatcher.ts](file:///Users/bytedance/Documents/Codex/helixent/src/cli/tui/slash-dispatcher.ts)
> - 后端入口：[web/server.ts#L394-L461](file:///Users/bytedance/Documents/Codex/helixent/web/server.ts#L394-L461)（submitMessage）+ [web/server.ts#L820-L826](file:///Users/bytedance/Documents/Codex/helixent/web/server.ts#L820-L826)（refreshSessionCommands）
> - 事件契约：[web/types.ts#L47-L59](file:///Users/bytedance/Documents/Codex/helixent/web/types.ts#L47-L59)
> - 前端入口：[web/public/index.html#L120-L129](file:///Users/bytedance/Documents/Codex/helixent/web/public/index.html#L120-L129)、[session.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/session.js)、[commands.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/commands.js)
> - Agent Output 渲染：[agent-output-graph.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/agent-output-graph.js)
> - Timeline 渲染：[timeline.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/timeline.js) + [timeline-legacy.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/timeline-legacy.js)

---

## 0. 文档目的与覆盖矩阵

把 PRD 的 5 条交付线（A/B/C/D/E）24 个 user story、4 个测试集翻译为可拉分支动手的 PR 级开发计划：模块拆分、接口契约、文件级落点、改造步骤、测试矩阵。

PRD ↔ 本 TDD 章节覆盖映射：

| PRD 章节 | 本 TDD 章节 | 关键产物 |
|---|---|---|
| §A. Slash Suggestion Popover | §3 + §4.1 + §6.PR-2 | `slash-suggestion.js` 纯函数 + `composer-controller` |
| §B. Command Chip in textarea (B1) | §4.1 + §6.PR-2 | textarea 上方 chip hint 行 |
| §C. Agent Output / Timeline 专属渲染 | §4.2 + §4.3 + §6.PR-3 | `commandCard` 节点 + Timeline `slash` 类目 |
| §D. Local vs Prompted | §2 + §3.1 + §4 + §6.PR-1 | `effect` 字段 + 三色 chip + 标签 |
| §E. Skills hot-reload | §5 + §6.PR-4 | `refreshSessionCommands` 触发点扩展 + `POST /api/skills/refresh` + Reload 按钮 |
| Testing T1-T4 | §7 | 4 个测试文件 |

PRD User Story ↔ 实现落点见 §8 验收矩阵。

---

## 1. 术语与现状参考点

| 术语 | 含义 |
|---|---|
| Suggestion popover | 自定义浮层（替代 `<datalist>` 的可发现性短板） |
| Command chip | textarea 上方的 chip hint 行（B1 方案）；PRD §B 视觉 |
| Command Card | Agent Output 中的独立卡片节点，渲染 `command_executed` |
| Command effect | `local`（不入 messages）/ `prompted`（入 messages）的语义层标签 |
| Skills hot-reload | 外部修改 skills 目录后让 Web 端无需重启就能感知 |

现状关键锚点：

- 解析返回值 `SlashParseResult`（已就绪）：[command-registry.ts#L74-L78](file:///Users/bytedance/Documents/Codex/helixent/src/cli/tui/command-registry.ts#L74-L78)
- 客户端 `parseSlashInputClient`（已就绪）：[session.js#L423-L435](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/session.js#L423-L435)
- `command_executed` SSE（已就绪）：[types.ts#L58](file:///Users/bytedance/Documents/Codex/helixent/web/types.ts#L58) + 后端发射点 [server.ts#L427/L449/L453](file:///Users/bytedance/Documents/Codex/helixent/web/server.ts#L427-L453)
- `<datalist>` 兜底（保留）：[index.html#L123-L124](file:///Users/bytedance/Documents/Codex/helixent/web/public/index.html#L123-L124)
- 现有 `commands` SSE 广播：[server.ts#L820-L826](file:///Users/bytedance/Documents/Codex/helixent/web/server.ts#L820-L826)（仅在 `POST/PUT/DELETE /api/skills` 时调用）

---

## 2. 模块设计总览

依然是「**纯函数 helper + DOM 控制器**」的两层结构，让纯函数侧能 bun test 单测，DOM 侧只做映射。

```
┌────────────────────────────────────────────────────────────────────┐
│                         server (TS / Bun)                          │
│  command-registry.ts  ──▶ SlashCommand.effect 必填                │
│  slash-dispatcher.ts  ──▶ DispatchResult.effect 透传              │
│  web/server.ts                                                    │
│    ├── submitMessage  ──▶ emit command_executed (含 effect)       │
│    ├── snapshotSession ──▶ refresh on read（§E ①）                │
│    └── POST /api/skills/refresh ──▶ refreshSessionCommands (§E ②) │
└────────────────────────────────────────────────────────────────────┘
                              ▲           │ SSE: commands / command_executed
                              │           ▼
┌────────────────────────────────────────────────────────────────────┐
│                       web/public (vanilla ESM)                     │
│  view/slash-suggestion.js     纯函数：算 popover 状态              │
│  view/render-suggestion.js    纯函数：popover HTML 模板           │
│  view/command-chip.js         纯函数：chip hint HTML 模板         │
│  app/composer-controller.js   DOM 控制器：textarea 事件 + popover  │
│  app/commands.js              注入 chip hint 行 / 数据列表       │
│  app/session.js               handleServerEvent: command_executed │
│                                ──▶ pushTraceRow → 走 graph 渲染   │
│  view/agent-output-graph.js   buildAgentOutputGraph: commandCard  │
│  view/timeline.js             eventCategory: command_executed     │
│                                ──▶ "slash" + filter chip          │
└────────────────────────────────────────────────────────────────────┘
```

---

## 3. 解析 / 元数据层改造（PR-1，TS 后端）

### 3.1 `SlashCommand.effect` 必填字段

文件：[command-registry.ts](file:///Users/bytedance/Documents/Codex/helixent/src/cli/tui/command-registry.ts)

```ts
export interface SlashCommand {
  name: string;
  description: string;
  type: "builtin" | "skill";
  availability?: ReadonlyArray<SlashCommandSurface>;
  helpDetails?: string;
  /** 是否会进入 session.agent.messages 参与后续模型上下文。 */
  effect: "local" | "prompted";   // ⬅️ 新增、必填
}
```

`BUILTIN_COMMANDS` 全部标 `effect: "local"`：

| name | availability | effect |
|---|---|---|
| clear | cli, web | local |
| help  | cli, web | local |
| exit  | cli      | local |
| quit  | cli      | local |

`toSkillCommand()` 构造 skill 时强制 `effect: "prompted"`。

⚠️ 这是**破坏性类型变更**：所有 `SlashCommand` 实例必须显式声明 `effect`。一次性 grep `web/server.ts` / 测试 fixture，把缺失字段补齐。

### 3.2 `SlashParseResult` 不变

`parseSlashInput` / `dispatch` 输出契约不变；前端通过 `state.commands` 查 effect。

### 3.3 `formatHelp` 末尾追加 hot-reload 提示

文件：[command-registry.ts](file:///Users/bytedance/Documents/Codex/helixent/src/cli/tui/command-registry.ts) `formatHelp()`

无 target 分支，在最后一行 `Run \`/help <name>\`...` 之前插入：

```
"Skills are loaded on session start, page refresh, or via the Skills > Reload button."
```

（满足 PRD User Story #24）

### 3.4 `command_executed` SSE 字段扩展（兼容）

文件：[types.ts#L58](file:///Users/bytedance/Documents/Codex/helixent/web/types.ts#L58)

```ts
| { type: "command_executed";
    name: BuiltinCommandName | string;     // 兼容 skill / unknown
    effect?: "local" | "prompted" | "unknown";   // ⬅️ 新增可选
    reason?: "cli-only";
    detail?: string }
```

后端 `submitMessage` 在 4 个 emit 点（state-mutation / render-message / unsupported / unknown-command）补 `effect`：

- `state-mutation` / `render-message` → 查 `BUILTIN_COMMANDS` 拿 `effect`（一定 `local`）。
- `unsupported` → `local`（CLI-only 也是本地命令）。
- `unknown-command` → `unknown`（前端展示橘色 chip）。
- `skill-passthrough` 不 emit `command_executed`，沿用普通 user_message 路径。

注：客户端可容忍缺省（旧版前端不会因新字段崩）。

---

## 4. 前端渲染层改造（PR-2 / PR-3，纯前端 ESM）

### 4.1 `slash-suggestion` + `composer-controller`（PR-2）

#### 4.1.1 文件清单

| 文件 | 类型 | 职责 |
|---|---|---|
| `web/public/view/slash-suggestion.js` (新) | 纯函数 | 计算下拉状态（输入 → items / activeIndex / open） |
| `web/public/view/render-suggestion.js` (新) | 纯函数 | popover HTML 模板（含 mark 高亮） |
| `web/public/view/command-chip.js` (新) | 纯函数 | chip hint 行 HTML 模板（含 effect 视觉） |
| `web/public/app/composer-controller.js` (新) | DOM 控制器 | 事件绑定、ARIA 同步、insert 补全 |
| `web/public/app/commands.js` (改) | 入口 | 在 sidebar 渲染 strip 之外，启动 composer-controller |
| `web/public/index.html` (改) | DOM | 加 popover 容器 + chip hint 容器 |
| `web/public/app/state.js` (改) | DOM 引用 | 注册新 DOM 引用 |

#### 4.1.2 `slash-suggestion.js` 接口

```js
/**
 * @param {{ text: string, caretOffset: number, commands: SlashCommand[], activeIndex?: number }} input
 * @returns {{ open: boolean, query: string, items: SuggestionItem[], activeIndex: number }}
 */
export function computeSuggestionState(input) { ... }

/**
 * @typedef SuggestionItem
 * @property {string} name
 * @property {"builtin"|"skill"} type
 * @property {"local"|"prompted"} effect      // 来自 command.effect
 * @property {string} description
 * @property {Array<[start: number, end: number]>} matchHighlight  // name 上的高亮区间
 */
```

行为契约（与 PRD §A 一致）：

- `open=true` 当且仅当：`text.slice(0, caretOffset)` 在最后一行 `/` 开头且不含空格。
- `query` = 当前 token 去掉首字符 `/`，全部小写。
- 排序：前缀命中（score 3）> 子串包含（score 2）> description 命中（score 1）；name 字典序兜底。
- 候选最多取 10 项；空 query 列出全部。
- `activeIndex` 由 controller 传入；helper 仅做 clamp（[0, items.length - 1]，0 默认）。
- `matchHighlight`：query 在 name 中的连续位置（lower-case 匹配，记录 [s, e)）。零命中（query 字符不在 name 中）则数组为空。
- commands 为空 → `items: []`，`open` 仍按规则触发（前端 fallback "no commands available"）。

#### 4.1.3 `render-suggestion.js` 模板

```html
<div id="slashSuggestionPopover"
     class="slash-popover"
     role="listbox"
     aria-label="Slash command suggestions"
     hidden>
  <div class="slash-popover-section">
    <div class="slash-popover-section-title">Built-in</div>
    <div role="option" id="slash-opt-0" aria-selected="true"
         class="slash-popover-item active" data-cmd="help" data-index="0">
      <span class="slash-popover-name">/<mark>he</mark>lp</span>
      <span class="slash-popover-effect slash-popover-effect-local">Local</span>
      <span class="slash-popover-desc">List available slash commands…</span>
    </div>
    …
  </div>
  <div class="slash-popover-section">
    <div class="slash-popover-section-title">Skills</div>
    …（effect 为 prompted）
  </div>
</div>
```

注意：

- `<mark>` 用于高亮，颜色用现有 `--accent` token；
- `data-cmd` 暴露给 controller click handler；
- 分组按 `type === "builtin" | "skill"`；空分组隐藏；
- effect chip 颜色：`local` 灰、`prompted` 蓝。

#### 4.1.4 `command-chip.js` 模板（PRD §B + §D）

```html
<div id="composerCommandChip" class="composer-chip" hidden>
  <span class="composer-chip-name">/help</span>
  <span class="composer-chip-effect composer-chip-effect-local">Local · won't reach the model</span>
  <button type="button" class="composer-chip-remove" aria-label="Clear command">×</button>
</div>
```

视觉决策表（与 PRD §D 表一致）：

| parseResult | effect | 颜色类 | 标签文案 |
|---|---|---|---|
| builtin/clear, builtin/help | local | `chip-effect-local`（灰） | Local · won't reach the model |
| builtin（未来 prompted） | prompted | `chip-effect-prompted`（蓝） | Sent to model |
| skill | prompted | `chip-effect-prompted`（蓝） | Sent to model · skill |
| unknown | unknown | `chip-effect-unknown`（橘） | Unknown · sent as plain text |
| not-slash | — | `hidden` | — |

#### 4.1.5 `composer-controller.js` 行为

监听事件（promptInput）：

| 事件 | 行为 |
|---|---|
| `input` | 调 `computeSuggestionState`，更新 popover；同时调 `parseSlashInputClient` 更新 chip hint |
| `keydown` | `↑/↓` 改 activeIndex；`Enter`/`Tab` 在 popover open 时拦截并补全；`Esc` 关闭 popover；不打断 form submit |
| `blur` | 50ms 延迟关闭（让 click 能先冒泡到候选项） |
| `click`（候选项） | 补全 textarea；关闭 popover |
| `click`（chip 的 ✕） | 清掉 textarea 中匹配 `^/[^\s]+\s?` 的 prefix |

补全逻辑：把 textarea 中**当前 slash token**（从行首到光标的 `/xxx`）替换为 `/<chosenName> `（末尾空格），caret 落在末尾。

ARIA 同步：

- `promptInput` 加：`aria-controls="slashSuggestionPopover" aria-autocomplete="list" aria-expanded` 随 open 变化；`aria-activedescendant="slash-opt-<index>"`。
- popover 关闭时清空 `aria-expanded` 和 `aria-activedescendant`。

位置算法：

- popover `position: absolute`；挂在 `.composer`（form）下；`.composer` 加 `position: relative`。
- top = `-popover.offsetHeight - 4`；left = 0。
- `ResizeObserver(promptInput)` + window resize 重算。

#### 4.1.6 `<datalist>` 兜底（PR-2 收尾）

- 不删 `<datalist>`，仍由现有 `renderCommandsHTML` 注入。
- 给 textarea CSS：`appearance: none; ::-webkit-calendar-picker-indicator { display: none }`，抑制原生小箭头。
- 浮层 open 时 textarea 不需要 `aria-hidden` datalist；关闭时浏览器原生回退仍可工作。

### 4.2 Agent Output: Command Card（PR-3）

#### 4.2.1 数据来源：traceRows

[session.js handleServerEvent](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/session.js) 的 `command_executed` 分支扩展：

```js
case "command_executed": {
  // 现有：flashStatus（保留）
  const at = new Date().toISOString();
  pushTraceRow({
    type: "command_executed",   // 不是 trace.kind，是 row.type
    name: event.name,
    effect: event.effect ?? null,
    reason: event.reason ?? null,
    detail: event.detail ?? null,
    at,
  });
  // /clear 已有 resetSessionUiState 分支：保留
  break;
}
```

`pushTraceRow` 已经驱动 graph 重建。

#### 4.2.2 `agent-output-graph.js` 改造

[isAgentOutputRow](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/agent-output-graph.js#L6-L13) 新增分支：

```js
if (row?.type === "command_executed") return true;
```

`buildAgentOutputGraph`：

- 处理顺序仍按 `rows` 时间线扫描。
- 命中 `row.type === "user_message" || row.type === "message" && role==="user"` 且 user.text 是合法 `/cmd`：标记 `pendingCommandUserRow = row`。
- 命中 `row.type === "command_executed"`：
  - 关闭当前 step / run（如果开着）。
  - 在当前 run 后追加一个**独立 commandCard 节点**（不嵌进 step）：
    ```js
    {
      id: `cmd:${runIndex}:${cmdIndex}`,
      type: "command_card",
      name: row.name,
      effect: row.effect,
      reason: row.reason,
      userText: pendingCommandUserRow?.message?.content,   // 用户气泡文本
      assistantBlocks: [],   // 后续合成 assistant 用 __synthetic 标记，附在这里
      at: row.at,
    }
    ```
  - 重置 `pendingCommandUserRow`。
- 命中 `row.type === "message" && role==="assistant" && message.__synthetic`：
  - 找最近一张未关闭的 commandCard，把 content blocks push 到 `assistantBlocks`。
  - **不再** 进入 reasoning trail（避免双渲染）。

#### 4.2.3 渲染模板

```html
<article class="command-card command-card-effect-local">
  <header>
    <span class="command-card-icon">❯</span>
    <span class="command-card-title">/help</span>
    <span class="command-card-effect">Built-in · Local · won't reach the model</span>
  </header>
  <pre class="command-card-body monospace">…帮助文本…</pre>
</article>
```

`/clear`（assistantBlocks 为空）：

```html
<article class="command-card command-card-empty">
  <span class="command-card-title">/clear</span>
  <span class="command-card-status">Session cleared</span>
</article>
```

CSS animation：3 秒后 fade-out（满足 PRD User Story #13）。但卡片**不从 graph 中移除**，仅视觉降透明度（保留导出/回看）。

#### 4.2.4 用户气泡 chip 化

[agent-output-graph.js renderUserTurn](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/agent-output-graph.js)（具体 renderer 名按现状）：

- 检测 user message text 匹配 `^/[A-Za-z][\w-]*` 且 `parseSlashInputClient(text, commands).kind !== "not-slash"` → 渲染 `chat-command-bubble`：
  ```html
  <div class="chat-command-bubble" data-effect="local">
    <span class="chat-command-icon">❯</span>
    <span class="chat-command-name">/help</span>
    <span class="chat-command-effect-tag">Local</span>
  </div>
  ```
- 不命中保持原 `user-bubble`。

### 4.3 Hook & Tool Timeline 改造（PR-3）

#### 4.3.1 `timeline.js`

文件：[web/public/view/timeline.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/timeline.js)

- `EVENT_KINDS` 数组追加 `"command_executed"`。
- `EVENT_KIND_LABELS` 加 `command_executed: "Command"`。
- `eventCategory(event)` 加：
  ```js
  if (event.kind === "command_executed") return "slash";
  ```
  其中 `event.kind` 来自 trace row 的虚拟节点（见 §4.3.3）。
- `eventPhaseKey(event)` 把 `command_executed` 归到 `user_input` phase。
- 顶部过滤器 chip 列表新增两个：`Slash · Local` / `Slash · Prompted`（细分），分别匹配 `event.data?.effect === "local" / "prompted"`。

#### 4.3.2 `timeline-legacy.js`

同步图标常量与 filter 列表，避免 legacy 视图回归。

#### 4.3.3 让 timeline 收到 command_executed

[session.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/session.js) 的 `pushTraceRow` 已经把 row 写入 `state.traceRows`，但 timeline 需要的是**`TraceEvent` 形状**（带 `kind`）。

方案：在 session.js handle 时**额外**合成一条虚拟 trace 推入 timeline 流：

```js
state.timelineRows.push({
  id: `cmd:${at}:${name}`,
  kind: "command_executed",
  at,
  label: `/${name}`,
  data: { effect: event.effect, reason: event.reason, detail: event.detail },
});
```

不污染 server trace 落盘（参见 PRD Out of Scope）。

---

## 5. Skills Hot-reload（PR-4，TS 后端 + 前端 sidebar）

### 5.1 §E ① Refresh on read（必做）

文件：[web/server.ts](file:///Users/bytedance/Documents/Codex/helixent/web/server.ts)

改造点：

1. **新 SSE 连接**（`GET /api/sessions/:id/events`）流式建立时，先 `await refreshSessionCommands()`（仅当前 session）。提取一个 helper：
   ```ts
   async function refreshSingleSession(session: WebSession) {
     session.commands = await loadAvailableCommands(getSkillsDirs(session.cwd));
     session.skills = await listSkills(getSkillsDirs(session.cwd));
   }
   ```
2. **`snapshotSession`**（`GET /api/sessions/:id/snapshot`）入口先 `await refreshSingleSession(session)`，再返回 snapshot。
3. **创建 session 时**已有同等逻辑，无需改。

性能注：`fs.readdir` × N 个 dir × 每个 dir × `readSkillFrontMatter`，实测一次 ≈ 5–20ms，对刷新页面体感无影响。

### 5.2 §E ② Manual refresh（推荐做）

#### 5.2.1 后端 endpoint

```
POST /api/skills/refresh
Body: 无 / 可选 { sessionId?: string }
Response: { commands: SlashCommand[], skills: SkillRecord[], refreshedAt: string }
```

实现：

- 无 `sessionId` → 调用 `refreshSessionCommands()`（已有，刷所有 sessions 并广播）。
- 有 `sessionId` → 仅刷一个 session，并 emit `commands` 给该 session。
- 返回当前 session（或第一个 session）的 commands + skills，方便前端 toast 显示数量。

文件：[web/server.ts](file:///Users/bytedance/Documents/Codex/helixent/web/server.ts) request handler 中新增 path 分支：

```ts
if (path === "/api/skills/refresh" && req.method === "POST") {
  const body = await readJson<{ sessionId?: string }>(req).catch(() => ({}));
  if (body.sessionId) {
    const session = sessions.get(body.sessionId);
    if (!session) throw new HttpError("Session not found", 404);
    await refreshSingleSession(session);
    emit(session, { type: "commands", commands: session.commands });
    return json({ commands: session.commands, skills: session.skills, refreshedAt: new Date().toISOString() });
  }
  await refreshSessionCommands();   // 刷所有
  const first = sessions.values().next().value;
  return json({
    commands: first?.commands ?? [],
    skills: first?.skills ?? [],
    refreshedAt: new Date().toISOString(),
  });
}
```

#### 5.2.2 前端 Reload 按钮

文件：[web/public/index.html](file:///Users/bytedance/Documents/Codex/helixent/web/public/index.html) sidebar Skills 区块（搜 `data-skills-list` / `Skills`）。

加一个按钮：

```html
<header class="sidebar-section-header">
  <h3>Skills</h3>
  <button id="skillsReloadButton" class="icon-button" type="button"
          aria-label="Reload skills" title="Reload skills from disk">
    ↻
  </button>
</header>
```

文件：`web/public/app/skills.js`（已有）增加 click handler：

```js
els.skillsReloadButton.addEventListener("click", async () => {
  els.skillsReloadButton.disabled = true;
  try {
    const res = await fetch("/api/skills/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.sessionId }),
    });
    const data = await res.json();
    flashStatus(`Skills reloaded · ${data.commands.length} commands`);
    // commands 事件已经会驱动 sidebar 自动重渲染；toast 即可
  } finally {
    els.skillsReloadButton.disabled = false;
  }
});
```

### 5.3 §E 不做的事

- **不上 `fs.watch` / chokidar**：明确写在 PRD Out of Scope。
- **不改 `commands` SSE 事件契约**。

---

## 6. 任务拆解（PR 级）

每个 PR 独立 mergeable，前一个 PR 的 main 上线后下一个能 rebase 上去。

### PR-1：后端 `effect` 字段 + `command_executed` 透传 + `formatHelp` 提示

- [ ] `SlashCommand` 加必填 `effect`，`BUILTIN_COMMANDS` 全部标 `local`，`toSkillCommand` 强制 `prompted`。
- [ ] 修复所有引用 `SlashCommand` 字面量构造点（grep 一遍 web/server.ts、tests）。
- [ ] [types.ts#L58](file:///Users/bytedance/Documents/Codex/helixent/web/types.ts#L58) `command_executed` 加 `effect?` 字段。
- [ ] [server.ts](file:///Users/bytedance/Documents/Codex/helixent/web/server.ts) submitMessage 在 4 个 emit 点附 `effect`。
- [ ] `formatHelp` 末尾追加 hot-reload 说明。
- [ ] 单测：`command-registry.test.ts` 加「effect 必填」「skill 默认 prompted」用例；`slash-dispatcher.test.ts` 不需要新增（dispatcher 输出形态不变）。
- [ ] 跑 `bun run check`。

### PR-2：Slash Suggestion Popover + Command Chip Hint

- [ ] 新建 `view/slash-suggestion.js` + 单测 `web/__tests__/slash-suggestion.test.ts`。
- [ ] 新建 `view/render-suggestion.js`、`view/command-chip.js`（纯模板）。
- [ ] 新建 `app/composer-controller.js`，挂载在 `app/commands.js` 启动入口。
- [ ] [index.html](file:///Users/bytedance/Documents/Codex/helixent/web/public/index.html) 在 `<form id="composer">` 内加 `<div id="composerCommandChip">` 和 `<div id="slashSuggestionPopover">` 容器（初始 hidden）。
- [ ] [state.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/state.js) 注册新 DOM 引用。
- [ ] 加 CSS：popover、chip、effect 颜色（复用 `--accent` 等 token）。
- [ ] 烟雾测试：`web/__tests__/frontend-composer-suggestion.test.ts`（renderSuggestionPopoverHTML 快照）。
- [ ] 跑 `bun run check` + 人工 a11y / 键鼠 / 浏览器栈兼容（macOS Safari、Chrome）。

### PR-3：Command Card · Timeline 类目 · 用户气泡 chip

- [ ] [session.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/session.js) `command_executed` 扩展 `pushTraceRow` + `timelineRows.push`。
- [ ] [agent-output-graph.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/agent-output-graph.js)：
  - `isAgentOutputRow` 加 `command_executed` 分支；
  - `buildAgentOutputGraph` 新增 `commandCard` 节点（合并相邻 user/`__synthetic` assistant）；
  - `renderUserTurn` 检测 `/cmd` → `chat-command-bubble`。
- [ ] [timeline.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/timeline.js) + [timeline-legacy.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/timeline-legacy.js)：`EVENT_KINDS`、`eventCategory`、`eventPhaseKey`、filter chip。
- [ ] CSS：`.command-card`、`.chat-command-bubble`、`/clear` 的 fade-out。
- [ ] 单测：新建 `web/__tests__/frontend-command-card.test.ts`，覆盖 §7.T2 全部用例。
- [ ] 跑 `bun run check`。

### PR-4：Skills Hot-reload

- [ ] [server.ts](file:///Users/bytedance/Documents/Codex/helixent/web/server.ts) 提取 `refreshSingleSession`；在 SSE connect / `snapshotSession` 入口调用。
- [ ] 新增 `POST /api/skills/refresh` 路由。
- [ ] [index.html](file:///Users/bytedance/Documents/Codex/helixent/web/public/index.html) sidebar Skills header 加 Reload 按钮。
- [ ] [skills.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/skills.js) 接 click handler + flashStatus。
- [ ] 集成测试：新建 `web/__tests__/skills-refresh.test.ts`，覆盖 §7.T4 全部用例。
- [ ] 跑 `bun run check`。

---

## 7. 测试矩阵

测试金字塔自下而上：纯函数单测 → 渲染契约单测 → 后端集成测试 → 人工浏览器验收。

### T1. `slash-suggestion` 单测（PR-2）

文件：`web/__tests__/slash-suggestion.test.ts`

| # | 输入 | 期望 |
|---|---|---|
| 1 | `text=""` | open=false |
| 2 | `text="hi"` | open=false |
| 3 | `text="/"` | open=true，items=全部 commands，activeIndex=0 |
| 4 | `text="/he"` | open=true，前两条是 `help`/`handoff`（前缀命中优先），matchHighlight=[[0,2]] |
| 5 | `text="/help foo"`，caret 在末尾 | open=false |
| 6 | `text="hello /he"`，caret 在末尾 | open=true（行首认 `/he`） |
| 7 | `text="hello /he"`，caret 移到 5 | open=false（caret 不在 slash token 内） |
| 8 | commands 全 uppercase + query lowercase | open=true，命中（大小写不敏感） |
| 9 | commands=[] | open=true，items=[] |

### T2. Command Card 渲染契约（PR-3）

文件：`web/__tests__/frontend-command-card.test.ts`

| # | 场景 | 期望 |
|---|---|---|
| 1 | rows=[user "/clear", command_executed "clear"] | graph.runs[0].commandCards[0].name="clear", assistantBlocks=[] |
| 2 | rows=[user "/help", command_executed "help", assistant `__synthetic` "...help text..."] | commandCard.assistantBlocks 含 help text，**reasoning trail 不再多渲染** |
| 3 | timeline.eventCategory({kind:"command_executed"}) | "slash" |
| 4 | timeline.eventPhaseKey | "user_input" |
| 5 | timeline filter `slash:local` 过滤 effect="local" 仅命中 local 项 | 通过 |
| 6 | 后端连续 submit `/help` × 3 | session.agent.messages.length 不变（local 不污染上下文） |
| 7 | submit `/help` 后再 submit "hi" | 模型上下文里没有 `/help` 这条 |
| 8 | chip effect 标签：builtin/clear / skill/foo / unknown/xxx | 分别 "local"/"prompted"/"unknown" |

### T3. Composer 烟雾测试（PR-2，可选）

文件：`web/__tests__/frontend-composer-suggestion.test.ts`

| # | 输入 | 断言 |
|---|---|---|
| 1 | `renderSuggestionPopoverHTML(items, 0)` 含 `aria-selected="true"` 在第 0 项 | snapshot |
| 2 | matchHighlight=[[0,2]] → name HTML 含 `<mark>he</mark>lp` | 字符串 includes |
| 3 | items=[]+open=true → "No commands available" 文本 | includes |
| 4 | command-chip.js 不同 effect → 渲染对应 className | 命中 |

### T4. Skills hot-reload 集成（PR-4）

文件：`web/__tests__/skills-refresh.test.ts`

| # | 场景 | 期望 |
|---|---|---|
| 1 | fixture 目录加一个 SKILL.md，POST `/api/skills/refresh` | 响应 commands 含新 skill；session SSE 收到 `commands` 事件 |
| 2 | 不调 refresh，先加 SKILL.md，再 GET `/api/sessions/:id/snapshot` | snapshot.commands 含新 skill（验证 §E ①） |
| 3 | 删除 fixture 中一个 skill，refresh | commands 中消失 |
| 4 | refresh 携带未知 sessionId | 404 |
| 5 | refresh 不带 sessionId | 刷所有 sessions 并广播；返回 commands 数组 |

### T5. 后端类型/编译回归（每个 PR 必跑）

```bash
bun run check          # tsc + eslint + bun test 全量
```

---

## 8. PRD User Story 验收矩阵

| US # | 场景 | 落点 |
|---|---|---|
| 1 | `/` 触发浮层 | §4.1.5 |
| 2 | 字符高亮 | §4.1.2 matchHighlight + §4.1.3 `<mark>` |
| 3 | ↑↓Enter Tab Esc | §4.1.5 keydown |
| 4 | `/` 删除/空格自动消失 | §4.1.2 open 规则 |
| 5 | builtin/skill 分组 + description | §4.1.3 模板 |
| 6 | 合法 `/cmd` chip hint | §4.1.4 |
| 7 | 未识别 toast | §4.1.4 unknown 橘色 chip + flashStatus |
| 8 | `/help` Command Card | §4.2.2 + §4.2.3 |
| 9 | 用户气泡 chip | §4.2.4 |
| 10 | Timeline 节点 | §4.3.1 + §4.3.3 |
| 11 | Timeline filter `Slash` | §4.3.1 filter chip |
| 12 | 基于 SSE 不嗅探 content | §4.2.1 traceRows 来源 |
| 13 | `/clear` 顶部短暂提示 | §4.2.3 fade-out 卡片 |
| 14 | 浮层 ARIA | §4.1.5 ARIA 同步 |
| 15 | 浮层位置自适应 | §4.1.5 ResizeObserver |
| 16 | chip 标 Local/Prompted | §4.1.4 + §3.1 effect |
| 17 | Card 保留 effect 标签 | §4.2.3 模板 |
| 18 | Timeline filter 细分 Local/Prompted | §4.3.1 |
| 19 | 未识别橘色警告 | §4.1.4 |
| 20 | `effect` 必填 | §3.1 |
| 21 | 刷新页面就生效 | §5.1 |
| 22 | Reload 按钮 | §5.2.2 |
| 23 | toast `Skills reloaded · N commands` | §5.2.2 click handler |
| 24 | `/help` 末尾说明 | §3.3 |

---

## 9. 回归与回滚预案

### 9.1 关键回归点

- 现有 PR-1/2/3（一致性 PRD）的功能：`/clear`、`/help`、`/exit`（cli-only 提示）、unknown command 走 plain-text fallthrough。**T2 #6/#7 + 既有 [slash-dispatcher.test.ts](file:///Users/bytedance/Documents/Codex/helixent/src/cli/tui/__tests__/slash-dispatcher.test.ts) 必须全过。**
- `<datalist>` 在浮层 controller 失败时仍可工作（删除浮层 JS 文件做手动回归）。
- Agent Output 现有 reasoning trail 渲染（无 `__synthetic` assistant 的普通模型回复）不受新代码影响。

### 9.2 回滚策略

每个 PR 都可独立 revert：

| PR | 失败现象 | 回滚动作 |
|---|---|---|
| PR-1 | TS 编译失败 / `BUILTIN_COMMANDS` 缺字段 | revert PR-1（前端没新代码依赖 effect，向后兼容） |
| PR-2 | popover 卡死 / 拦截 Enter 提交 | revert PR-2（datalist 兜底仍可用） |
| PR-3 | command card 错位 / Timeline 报错 | revert PR-3（command_executed 仍走 flashStatus 老路径） |
| PR-4 | refresh endpoint 误删 commands | revert PR-4；§5.1 必做项独立可关，加 env flag `HELIXENT_DISABLE_REFRESH_ON_READ=1` |

### 9.3 上线分阶段

1. PR-1 合入 main，主干运行 24h，关注 type 错误反馈。
2. PR-2 合入，关注 a11y / 键盘事件冲突（特别是中文输入法 composition）。
3. PR-3 合入，关注 Agent Output 长 trace 的渲染性能。
4. PR-4 合入，关注 fs.readdir 在 home 目录上的延迟（极端情况 ~/.helixent/skills 很大时）。

---

## 10. Open Questions

- 中文输入法 composition 期间 `/` 触发浮层会不会误触发？需要在 `compositionstart`/`compositionend` 时暂停 popover 计算（PR-2 实现时再确认）。
- skills 数量极多（>100）时 popover 性能：先用 `slice(0, 10)` 截断，未来若投诉再加虚拟滚动。
- `fade-out` `/clear` 卡片对历史回看导出（Export 按钮）的内容是否可见？建议导出时强制 visible（PR-3 实现时核对 export.js）。
- `command_executed` 是否需要落 `.jsonl`（trace 文件）？本期保持现状不落，二期 outline 决策。
