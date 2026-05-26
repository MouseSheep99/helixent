# Web Slash Commands 一致性 — 技术开发文档（TDD）

> 配套 PRD：[web-slash-commands-prd.md](file:///Users/bytedance/Documents/Codex/helixent/.trae/documents/web-slash-commands-prd.md)
> 状态：Draft · 范围：CLI + Web 双入口 + 后端 server.ts + 前端 web/public/app/*
> 关联代码：
> - [src/cli/tui/command-registry.ts](file:///Users/bytedance/Documents/Codex/helixent/src/cli/tui/command-registry.ts)
> - [src/cli/tui/hooks/use-agent-loop.ts](file:///Users/bytedance/Documents/Codex/helixent/src/cli/tui/hooks/use-agent-loop.ts)
> - [web/server.ts](file:///Users/bytedance/Documents/Codex/helixent/web/server.ts)
> - [web/public/app/session.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/session.js)

---

## 0. 文档目的

把 PRD 描述的「Web textarea `/clear` 没反应、CLI/Web 各写一份分发、未注册 `/xxx` 被静默」三个问题，转化为可直接拉分支动手的开发计划：模块拆分、接口契约、文件级落点、改造步骤、测试矩阵、回归与回滚预案。

不在本文中写完整源码，只给到「关键签名」「事件契约」「关键改动点定位」级别的精度。

---

## 1. 术语与现状参考点

| 术语 | 含义 |
|---|---|
| Builtin command | 当前 `BUILTIN_COMMANDS` 中的 4 项：`clear / exit / help / quit` |
| Skill command | 由 `loadAvailableCommands()` 从 `.trae/skills/*` 注入的 `/skill-name` |
| Unknown command | 输入是 `/xxx` 形式，但既不是 builtin 也不是 skill |
| Plain message | 不以 `/` 开头的普通用户消息 |
| Dispatch context | 当前指令的执行环境，取值 `'cli' | 'web'` |
| Command event | 后端给前端的语义化指令事件，本次新增 |

现状关键文件锚点：

- 解析：[command-registry.ts#L83-L97](file:///Users/bytedance/Documents/Codex/helixent/src/cli/tui/command-registry.ts#L83-L97) `resolveBuiltinCommand`
- 帮助文本：[command-registry.ts#L104-L137](file:///Users/bytedance/Documents/Codex/helixent/src/cli/tui/command-registry.ts#L104-L137) `formatHelp`
- CLI 分发：`src/cli/tui/hooks/use-agent-loop.ts#L85` switch 命中后调用 `agent.clearMessages()` / `clearTerminal()`
- Web 分发：[web/server.ts#L403-L423](file:///Users/bytedance/Documents/Codex/helixent/web/server.ts#L403-L423)
- Web SSE 事件类型注册：[web/public/app/session.js#L306](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/session.js#L306)
- Web `clearSession()` UI 重置：[web/public/app/session.js#L412-L427](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/session.js#L412-L427)

---

## 2. 模块设计

设计两个深模块（deep modules）：解析层 + 分发层。两层都是纯函数，无副作用，让 CLI 和 Web 各自把"副作用"翻译成自己的执行环境。

### 2.1 模块 A：`SlashCommandRegistry`（强化现有 `command-registry`）

**单一职责**：维护命令元数据 + 解析输入 → 返回判别联合。

#### 2.1.1 元数据扩展

`SlashCommand` 增加两个字段：

```ts
export interface SlashCommand {
  name: string;
  description: string;
  type: "builtin" | "skill";
  // 新增：可用环境，缺省视为 ['cli', 'web']
  availability?: ReadonlyArray<"cli" | "web">;
  // 新增：可选长帮助文本（formatHelp <name> 用），缺省回落到 description
  helpDetails?: string;
}
```

`BUILTIN_COMMANDS` 调整：

| name | availability | 备注 |
|---|---|---|
| `clear` | `['cli','web']` | |
| `help` | `['cli','web']` | |
| `exit` | `['cli']` | Web 命中即 `unsupported` |
| `quit` | `['cli']` | 同上 |

#### 2.1.2 解析返回值

新增统一解析函数 `parseSlashInput(text) → SlashParseResult`：

```ts
type SlashParseResult =
  | { kind: "not-slash" }                                  // 输入不是 /xxx，应作为 plain message
  | { kind: "builtin"; name: BuiltinName; args: string }   // 命中 builtin
  | { kind: "skill"; name: string; args: string }          // 命中 skill
  | { kind: "unknown"; raw: string; args: string };        // 是 /xxx 但未注册
```

注意点：

- `resolveBuiltinCommand` 保留并复用其内部逻辑，新函数在它之上叠加 skill / unknown 分支。
- 解析 skill 时需要传入 `commands: SlashCommand[]`，或使用单例 `getCachedCommands()`。
- `not-slash` 与 `unknown` 必须严格区分，`unknown` 才能驱动前端"未识别命令"提示。

#### 2.1.3 兼容性

- `resolveBuiltinCommand` 不删除，签名不动；CLI 不改逻辑也能跑。
- `BUILTIN_COMMANDS` 字段新增 `availability` 是可选字段，既有测试不会编译失败。
- `formatHelp` 不改签名，仅在内部使用 `helpDetails ?? description`。

### 2.2 模块 B：`SlashCommandDispatcher`（新文件）

**位置建议**：`src/cli/tui/slash-dispatcher.ts`，作为纯函数模块，CLI 与 Web 共用。

**单一职责**：把 `SlashParseResult` 翻译成「想要发生的事」（语义层），不直接动 agent / DOM。

#### 2.2.1 接口

```ts
type DispatchContext = "cli" | "web";

type DispatchResult =
  | { kind: "noop" }                                         // not-slash: 调用方继续走 plain message 流程
  | { kind: "state-mutation"; mutations: StateMutation[] }   // 命中 builtin 且应执行副作用
  | { kind: "render-message"; message: NonSystemMessage }    // 命中 builtin 且只需渲染消息（如 /help）
  | { kind: "unsupported"; name: string; reason: string }    // 命中 builtin 但当前 context 不支持
  | { kind: "unknown-command"; name: string }                // /xxx 未注册
  | { kind: "skill-passthrough"; skillName: string };        // 命中 skill：调用方继续 plain message 流程，但带上 requestedSkillName

type StateMutation =
  | { kind: "clear-agent-messages" }
  | { kind: "clear-todos" }
  | { kind: "clear-trace" }
  | { kind: "exit-process" };
```

`dispatch(parseResult, context) → DispatchResult` 是纯函数；它读 availability，决定 builtin 在该 context 下走 `state-mutation` / `render-message` 还是 `unsupported`。

#### 2.2.2 行为表

| Input | CLI 输出 | Web 输出 |
|---|---|---|
| `/clear` | `state-mutation: [clear-agent-messages, clear-todos, clear-trace]` | 同左 |
| `/help` | `render-message: assistant(formatHelp(commands))` | 同左 |
| `/help foo` | `render-message: assistant(formatHelp(commands, 'foo'))` | 同左 |
| `/exit` 或 `/quit` | `state-mutation: [exit-process]` | `unsupported: cli-only` |
| `/skillname` | `skill-passthrough: skillname` | 同左 |
| `/notacommand` | `unknown-command: notacommand` | 同左 |
| `hi` | `noop` | 同左 |

`render-message` 选择 assistant 角色是为了与现状 [web/server.ts#L411-L418](file:///Users/bytedance/Documents/Codex/helixent/web/server.ts#L411-L418) 保持一致（也 emit user + assistant），只是把构造下沉到 dispatcher。

### 2.3 模块 C：事件契约 `command_executed`

新增 SSE 事件类型，供前端监听。

```ts
type CommandExecutedEvent = {
  type: "command_executed";
  name: "clear" | "help" | "exit" | "quit";
  reason?: "cli-only";
  detail?: Record<string, unknown>;
};
```

注意：

- `command_executed` 与 `error` 是互补的：`unsupported` 既可以走 `command_executed { name, reason: 'cli-only' }`，也可以走现状的 `error` 字符串。本设计选择前者，让前端能针对"已知不可用"做特定 UI（如轻量 toast），而不是错误条。
- 需要在 [web/public/app/session.js#L306](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/session.js#L306) `connectEvents` 的事件类型数组里加入 `"command_executed"`。

---

## 3. 改动落点（文件级）

### 3.1 后端 / 共享

1. **[src/cli/tui/command-registry.ts](file:///Users/bytedance/Documents/Codex/helixent/src/cli/tui/command-registry.ts)**
   - 扩展 `SlashCommand` 接口：加 `availability?`、`helpDetails?`。
   - `BUILTIN_COMMANDS` 给 `exit/quit` 加 `availability: ['cli']`。
   - 新增 `parseSlashInput(text, commands?) → SlashParseResult`。
   - `formatHelp` 内部支持 `helpDetails`，对外签名不变。

2. **`src/cli/tui/slash-dispatcher.ts`（新增）**
   - 实现 `dispatch(parseResult, context)`。
   - 不依赖 `Agent` / `console` / DOM；只做纯映射。
   - 导出 `StateMutation`、`DispatchResult` 类型。

3. **[src/cli/tui/hooks/use-agent-loop.ts](file:///Users/bytedance/Documents/Codex/helixent/src/cli/tui/hooks/use-agent-loop.ts)**
   - 把现有 builtin switch 替换为：
     `parseSlashInput → dispatch(_, 'cli') → 翻译 mutations`
   - mutations 翻译表：
     - `clear-agent-messages` → `agent.clearMessages()`
     - `clear-trace` → 现有"清屏"行为
     - `exit-process` → 调用现有退出钩子
   - skill-passthrough、unknown-command 行为：保持现状（CLI 现在就把未识别命令当普通输入），可选打 hint 但不强制。

4. **[web/server.ts](file:///Users/bytedance/Documents/Codex/helixent/web/server.ts)**
   - `submitMessage` 中：
     - 把 `resolveBuiltinCommand(text)` 替换为 `parseSlashInput(text, session.commands)`。
     - 调 `dispatch(result, 'web')`。
     - 按 `DispatchResult` 分支处理：
       - `state-mutation`: 执行 mutations（`agent.clearMessages()` / `emit todo_update: undefined` / 内部清 trace 状态），最后 emit `command_executed { name }`。
       - `render-message`: emit `message: user` + `message: assistant(message)`。
       - `unsupported`: emit `command_executed { name, reason: 'cli-only' }`。
       - `unknown-command`: 走 plain message 流程，但额外 emit `command_executed { name: undefined, detail: { unknown: true, raw: name } }`，让前端做提示（实现细节：可以用单独 `error`/`hint` 事件，避免污染 `command_executed` 的 name 联合，本文档采用单独 `command_hint` 事件，见 §3.2 选项 B）。
       - `skill-passthrough`: 走现有 plain message 流程，把 `requestedSkillName` 设为该 skill。
       - `noop`: 走现有 plain message 流程，与今天行为完全一致。

   > 选项 B（推荐）：把"未识别命令提示"由前端本地解析负责（前端拿到 `commands` 列表后自己判断），后端不引入新事件。这样 unknown-command 不污染后端事件 schema，前端在拼 body 之前 toast 一行即可。本文档采用选项 B。

### 3.2 前端

1. **[web/public/app/session.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/session.js)**
   - `connectEvents` 注册的 SSE 类型数组加 `"command_executed"`。
   - `handleServerEvent` 加 `command_executed` 分支：
     - `name === 'clear'` → 调用现有 `clearSession()` 的"UI 重置部分"（拆出 `resetSessionUiState()`，避免它再次发 REST `/clear`）。
     - `name === 'help'` → 无需特殊处理（`render-message` 已经走 message 通道）。
     - `name === 'exit' | 'quit'` 且 `reason === 'cli-only'` → `flashStatus("This command is only available in the TUI.")`。
   - `submitPrompt` 在发送前调用前端版 `parseSlashInput(text, state.commands)`：
     - `unknown` → `flashStatus("Unknown command /xxx, sending as a normal message.")` 然后照旧发送。
     - 其他分支不变（builtin 路由仍由后端做权威分发）。

2. **抽出 `resetSessionUiState()`**
   - 把 [session.js#L415-L426](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/session.js#L415-L426) 中清空 state + 重新渲染的部分独立成函数。
   - `clearSession()`（侧边栏按钮）= `await POST /clear` + `resetSessionUiState()`。
   - `command_executed: clear` 处理 = `resetSessionUiState()`（不再重复 REST，因为 textarea `/clear` 已经走过 `/messages`）。

3. **轻量"未识别命令"提示**
   - 不需要新 UI 组件，复用现有 `flashStatus()`。
   - 字符串建议：`Unknown command /<name>; sent as a regular message.`

### 3.3 共享类型 / 跨入口

- 把 `parseSlashInput` 的核心解析独立成不依赖 Node 的函数，确保前端可以通过 `web/public/app` 复制一份等价 JS 实现（仓库目前前端是原生 JS，没有共享 ts 编译路径）。
- 长期方案（不在本期）：在 `src/foundation/commands` 下抽 `parser.ts`，CLI/Web 后端共用，前端用一个轻量 mirror。

---

## 4. 接口契约总览

### 4.1 SlashCommand 元数据（扩展后）

```ts
interface SlashCommand {
  name: string;
  description: string;
  type: "builtin" | "skill";
  availability?: ReadonlyArray<"cli" | "web">; // 缺省 = ["cli","web"]
  helpDetails?: string;
}
```

### 4.2 SlashParseResult

```ts
type SlashParseResult =
  | { kind: "not-slash" }
  | { kind: "builtin"; name: "clear" | "exit" | "help" | "quit"; args: string }
  | { kind: "skill"; name: string; args: string }
  | { kind: "unknown"; raw: string; args: string };
```

### 4.3 DispatchResult

```ts
type DispatchResult =
  | { kind: "noop" }
  | { kind: "state-mutation"; mutations: StateMutation[] }
  | { kind: "render-message"; message: NonSystemMessage }
  | { kind: "unsupported"; name: string; reason: "cli-only" }
  | { kind: "unknown-command"; name: string }
  | { kind: "skill-passthrough"; skillName: string };
```

### 4.4 后端 → 前端事件

```ts
type CommandExecutedEvent =
  | { type: "command_executed"; name: "clear" | "help" }
  | { type: "command_executed"; name: "exit" | "quit"; reason: "cli-only" };
```

### 4.5 前端拦截逻辑

`submitPrompt(textarea)`:
1. 拿到 trimmed text。
2. 若为空 + 无图：return（同现状）。
3. `parseSlashInputClient(text, state.commands)`：
   - `unknown` → `flashStatus(...)`；继续发送（保持当前行为兼容）。
   - 其他 → 不拦截。
4. 走原 `POST /messages`。

---

## 5. 调用链（改造后）

**Web 端 `/clear`**：

```
textarea Enter
  → submitPrompt()
      → POST /api/sessions/:id/messages { text: "/clear" }
  → server submitMessage()
      → parseSlashInput("/clear") = { kind:"builtin", name:"clear" }
      → dispatch(_, "web") = { kind:"state-mutation", mutations:[clear-agent-messages, clear-todos, clear-trace] }
      → 执行 mutations: agent.clearMessages(); emit todo_update: undefined
      → emit command_executed { name: "clear" }
  → frontend SSE listener "command_executed"
      → resetSessionUiState()
      → flashStatus("Session cleared")
```

**Web 端 `/exit`**：

```
parse → builtin{exit} → dispatch(web) → unsupported{cli-only}
emit command_executed { name:"exit", reason:"cli-only" }
frontend → flashStatus("This command is only available in the TUI.")
```

**Web 端 `/notacommand`**：

```
frontend submitPrompt: parseSlashInputClient → unknown{notacommand}
flashStatus("Unknown command /notacommand; sent as a regular message.")
继续 POST /messages
server submitMessage: parse → unknown → 走 plain message 流程（与今天等价）
```

**CLI 端 `/clear`**：

```
parse → builtin{clear} → dispatch(cli) → state-mutation
hook 翻译 mutations: agent.clearMessages(); clearTerminal()
（行为与今天一致）
```

---

## 6. 任务拆解（按 PR 切片）

### PR-1：Registry 增强（无行为变化）
- [ ] `SlashCommand` 加 `availability` / `helpDetails`，`BUILTIN_COMMANDS` 给 exit/quit 加 `availability:['cli']`。
- [ ] 新增 `parseSlashInput(text, commands?) → SlashParseResult`。
- [ ] 单元测试覆盖 4 个分支（`not-slash / builtin / skill / unknown`）+ `availability` 元数据存在性。
- [ ] 不动调用方，CI 应全绿。

### PR-2：Dispatcher + Web server 接入
- [ ] 新增 `src/cli/tui/slash-dispatcher.ts` + 单元测试（覆盖行为表所有行）。
- [ ] 改 `web/server.ts.submitMessage`：换为 parse + dispatch；按 `DispatchResult` 分支 emit。
- [ ] 引入 `command_executed` 事件类型并在 `connectEvents` 数组注册。
- [ ] 后端 server 行为测试：
  - `/clear` 不调 `agent.stream`，发出 `command_executed: clear`，发出 `todo_update: undefined`。
  - `/help foo` 发出 user + assistant message。
  - `/exit` 发出 `command_executed: exit, reason:'cli-only'`，不调 `agent.stream`。
  - 普通 `/notacommand` 仍走 `agent.stream`。

### PR-3：前端事件接入 + 前端解析提示
- [ ] 抽出 `resetSessionUiState()`，`clearSession()` 复用。
- [ ] `handleServerEvent` 加 `command_executed` 分支。
- [ ] `submitPrompt` 加 `parseSlashInputClient`：unknown → `flashStatus`；其余继续。
- [ ] 手动验收 §8 的脚本。

### PR-4（可选）：CLI 切换到 dispatcher
- [ ] `use-agent-loop.ts` 把 builtin switch 替换为 `dispatch + 翻译 mutations`，行为不变。
- [ ] 单元测试：CLI mutations 翻译路径覆盖。

---

## 7. 测试矩阵

| 测试层 | 文件 | 覆盖 |
|---|---|---|
| 解析单测 | `src/cli/tui/__tests__/command-registry.test.ts`（扩展） | `parseSlashInput` 4 个 kind；`availability` 字段读取 |
| 分发单测 | `src/cli/tui/__tests__/slash-dispatcher.test.ts`（新增） | §2.2.2 行为表所有 7 行 × 2 context |
| Web 行为 | `web/__tests__/submit-message.test.ts`（新增或合并） | §6 PR-2 列出的 4 个场景 |
| 前端最小 | 若有 jsdom 环境：`web/public/__tests__/session-events.test.js` | `command_executed:clear` → state.messages 清空；`exit` → 触发 flashStatus 调用 |
| CLI 行为 | `src/cli/tui/__tests__/use-agent-loop.test.ts`（如已有；如无可用 PR-4 内补） | `state-mutation` 翻译为正确 agent.clearMessages 调用 |

测试原则（沿用 PRD）：

- 只断言外部行为。
- emit 事件序列用 mock collector 比对。
- 不去断 DOM 选择器，前端最小测试只断 state 字段。

---

## 8. 验收脚本（人工）

在本地 dev server 起来后，逐项验证：

1. textarea 输入 `/clear` → 消息列表清空、trace 面板清空、todo 清空、底部 flash 出现 `Session cleared`。
2. textarea 输入 `/help` → 渲染一对 user / assistant 消息，含 builtin + skill 列表。
3. textarea 输入 `/help clear` → assistant 消息只显示 `clear` 的详情。
4. textarea 输入 `/exit` → flash 出现 `This command is only available in the TUI.`，消息列表无新增。
5. textarea 输入 `/notacommand` → flash 出现 `Unknown command /notacommand; sent as a regular message.`，随后看到模型对 `/notacommand` 的普通回复。
6. textarea 输入 `/skill-creator make a foo` → 与今天一致：作为普通消息发送，且后端 `requestedSkillName === 'skill-creator'` 注入。
7. 侧边栏 Clear 按钮 → 与第 1 步效果完全一致。
8. CLI 内 `/clear`、`/exit`、`/help`、`/help clear` → 行为与今天一致（无回归）。

---

## 9. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 前端 unknown 提示与历史用户习惯冲突（一些用户故意用 `/foo` 当普通消息） | 中 | 低 | 仍发送，仅一行 toast；可加用户偏好开关（不在本期） |
| `command_executed` 与现有 `error` 事件功能重叠，引发前端歧义 | 低 | 中 | 文档化：`unsupported` 走 `command_executed{reason}`，`error` 仅用于异常路径 |
| dispatcher 抽象引入循环依赖 | 低 | 中 | dispatcher 不 import agent / DOM，仅依赖类型 |
| 前端 mirror parser 与后端不一致 | 中 | 中 | `parseSlashInputClient` 在 PR-3 中加单测，构造与后端共享的 fixture 集合 |
| Web `unknown` 仍走模型导致额外 token 浪费 | 低 | 低 | 可选 PR-3 升级为"二次确认条"，本期不做 |

---

## 10. 回滚策略

每个 PR 都设计为**独立可回滚**：

- PR-1 仅扩字段，回滚无副作用。
- PR-2 回滚后 Web 行为退回今日（仍是 textarea `/clear` 静默生效），但 server schema 不破坏。
- PR-3 回滚后前端不再消费新事件，但后端 emit 仍兼容。
- PR-4 回滚后 CLI 退回 switch；不影响 Web。

---

## 11. 与二期 outline 的关系

- 本期是"流程修复 + 模块收敛"，不引入新指令。
- 完成后，`SlashCommandDispatcher` 与 `command_executed` 事件契约会被二期 outline 用作以下命令的接入面：
  - `/compact`（outline §4 manual compact 的入口）
  - `/agents`（outline §6 sub-agent 调试入口）
  - `/profile`（outline §1 profile 切换入口）
  - `/tools`（outline §2 toolkit 调试入口）
- 上述命令在二期落地时，只需在 `BUILTIN_COMMANDS` 加一项 + dispatcher 行为表加一行 + 前端按事件 name 加 UI handler，无需再次改动分发骨架。

---

## 12. 出口清单（Done 定义）

- [ ] 三个 PR 合入 main，CI 全绿。
- [ ] 第 8 节验收脚本人工通过。
- [ ] CLI 端 `/clear /exit /help /help clear` 行为与改造前一致（截图对比或单测保证）。
- [ ] [.trae/documents/generalize-agent-platform-outline.md](file:///Users/bytedance/Documents/Codex/helixent/.trae/documents/generalize-agent-platform-outline.md) 关键决策小节追加一条："斜杠指令分发表为 CLI/Web 共享单源"。
- [ ] [PRD](file:///Users/bytedance/Documents/Codex/helixent/.trae/documents/web-slash-commands-prd.md) 状态更新为 Done，并附本 TDD 链接。
