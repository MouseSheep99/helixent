# Web Slash Commands 一致性 PRD

> Status: Draft · Owner: TBD · Triage: ready-for-agent
> 关联代码：`web/server.ts`、`web/public/app/session.js`、`src/cli/tui/command-registry.ts`、`src/cli/tui/hooks/use-agent-loop.ts`

## Problem Statement

用户在 Web 端的输入框里键入 `/clear`、`/exit` 等斜杠指令时，看起来「平台没有任何反应」：

- 消息列表没有清空
- Trace 面板看似没刷新
- 也没看到任何提示告诉用户「指令已执行 / 不被支持 / 被当成普通消息了」

而在 TUI 里，用户记得 helixent 是支持 `/clear` 等指令的。这导致两个体验问题：

1. Web 与 TUI 的斜杠指令体验不一致：TUI 命中后立即清屏并给反馈，Web 命中后用户感知不到。
2. 平台对 `/xxx` 的处理是隐式的：未注册的 `/xxx` 会被静默作为普通用户消息发给模型，用户既不知道命令未生效，也不知道发生了什么。

附加问题：当前 `BUILTIN_COMMANDS` 的分发逻辑在 CLI（`use-agent-loop.ts`）和 Web（`web/server.ts`）各写了一份 `switch`，新增任何一个 `/xxx` 都需要改两处，容易漂移。

## Solution

让 Web 输入框的斜杠指令体验与 TUI 对齐，并把斜杠指令的分发收敛到一个共享分发表，使新增 `/xxx` 时 CLI 和 Web 自动一致。

具体目标：

1. 在 Web 上键入 `/clear` 后，UI 立即清空消息列表、清除 trace、todo、approval 等状态，并提示「Session cleared」。
2. 在 Web 上键入 `/help` 后，渲染帮助文本（含 builtin + skill 两类命令）。
3. 在 Web 上键入 `/exit` 或 `/quit` 时，前端显式提示「该命令仅在 TUI 中可用」，不静默。
4. 在 Web 上键入未注册的 `/xxx` 时，前端先给一条系统提示询问是否仍要把它作为普通消息发送，避免被静默吞掉（最小实现可降级为：直接当作普通消息发送，但 UI 上明确给出「未识别命令，按普通消息发送」一行提示）。
5. 把斜杠指令分发逻辑下沉到 `command-registry`，CLI 与 Web 共用同一张分发表 + 同一份元数据。
6. 后端 `submitMessage` 命中 builtin 时，统一 emit 一个语义化事件（如 `command_executed`），让前端有明确的渲染锚点。

非目标：
- 不在本次 PRD 中扩充 builtin 集合（如 `/compact`、`/tools` 等），相关需求归到二期 outline。
- 不动 skill 类命令的现有 `buildPromptSubmission` 逻辑。

## User Stories

1. 作为 Web 用户，我希望在输入框输入 `/clear` 后，消息列表立刻被清空，这样我能直观地确认 session 已重置。
2. 作为 Web 用户，我希望在执行 `/clear` 后看到一条简短的系统提示（如「Session cleared」），这样我知道刚才的回车有被服务器接收。
3. 作为 Web 用户，我希望在 `/clear` 后 trace 面板、todo 面板、approval 队列同时被清空，这样下一轮对话不会受到上一轮的残留影响。
4. 作为 Web 用户，我希望 `/help` 在 Web 与 TUI 都可用，这样我能在不切换终端的情况下查看可用斜杠指令。
5. 作为 Web 用户，我希望 `/help <name>` 能展示具体某个命令的说明，与 TUI 一致。
6. 作为 Web 用户，我希望输入 `/exit` 或 `/quit` 时收到「该命令仅在 TUI 中可用」的明确提示，这样我不会以为是 bug。
7. 作为 Web 用户，我希望输入未注册的 `/xxx` 时不被静默地作为模型消息处理，这样我能立即发现拼写错误或不存在的命令。
8. 作为 Web 用户，我希望 `/clear` 行为与侧边栏 Clear 按钮完全一致，这样我能在两种入口下得到同样的状态机结果。
9. 作为 Web 用户，我希望键入 `/skill-name args` 时与 TUI 一样，会触发对应 skill 的 `requestedSkillName`，这样体验保持一致。
10. 作为 TUI 用户，我希望斜杠指令在我使用 Web 后行为不退化，这样多入口下没有「哪个版本是权威」的疑惑。
11. 作为开发者，我希望新增一个 builtin 斜杠指令时只改一处分发表，这样 CLI 与 Web 行为天然一致，不会漂移。
12. 作为开发者，我希望分发表里能声明「Web 是否支持」「CLI 是否支持」，这样 `/exit` 这种只在 TUI 有意义的命令在 Web 端能给出明确提示，而不是隐式失败。
13. 作为开发者，我希望对 `/clear` 在 Web 端的行为有一份回归测试，这样后续重构不会再次让 textarea 走回「静默吞掉」的老路。
14. 作为开发者，我希望前端拿到「命令已执行」事件时，UI 重置逻辑是单一函数（与侧边栏 Clear 按钮共享），这样维护成本最低。
15. 作为产品负责人，我希望 PRD 中明确「未注册 /xxx」的兜底策略，避免日后体验讨论反复。
16. 作为产品负责人，我希望此次只做行为修复与分发表收敛，不扩张命令集合，把范围控制住。

## Implementation Decisions

### 模块划分

引入两个深模块（deep modules），覆盖 CLI / Web 两个入口：

1. `SlashCommandRegistry`（强化现有 `command-registry`）
   - 单一职责：维护命令元数据 + 解析 + 分发选择。
   - 接口（语义层面，非具体签名）：
     - 定义 `SlashCommand` 元数据：`name`、`description`、`availability: { cli, web }`、`handlerKind: 'builtin' | 'skill'`、可选 `helpDetails`。
     - 解析输入字符串到 `BuiltinInvocation | SkillInvocation | null`，并区分「`null` 表示输入不是 `/xxx`」与「`unknown` 表示输入是 `/xxx` 但未注册」。
   - 这样保留 `resolveBuiltinCommand` 现有用法，仅扩展返回类型，向上兼容。

2. `SlashCommandDispatcher`（新模块，server 与 hooks 共用）
   - 单一职责：根据上下文（`'cli' | 'web'`）执行 builtin 命令，并产出语义事件。
   - 接口（语义层面）：
     - `dispatch(invocation, context) → DispatchResult`，其中 `DispatchResult` 是一个判别联合类型：`{ kind: 'state-mutation', mutations: [...] } | { kind: 'message', message } | { kind: 'unsupported', reason } | { kind: 'unknown-command', name }`。
     - 由 caller（CLI hook 或 Web `submitMessage`）把 `mutations` / `message` 翻译成自己环境下的副作用（emit event、清空 store 等）。
   - 该接口稳定、可测试，CLI / Web 调用同一份。

### 行为决策

- `/clear`：
  - Web：后端命中后调用 `agent.clearMessages()`，并 emit 新的 `command_executed { name: 'clear' }` 事件。前端监听该事件，复用现有 `clearSession()` 内部的 UI 重置（不再发起重复的 REST 调用），并在消息流末尾追加一条 system message「Session cleared」。
  - CLI：行为保持不变（已有 `clearTerminal()` + `agent.clearMessages()`）。
- `/help` / `/help <name>`：
  - Web：维持现有「emit 一对 user/assistant message」的渲染方式，但内容生成改为走 `formatHelp(commands, args)`，并在 assistant 内容里包含 builtin + skill 两类。
- `/exit` / `/quit`：
  - Web：前端把 error 渲染从角落 toast 升级为「输入框上方一行明显文案」+ 一次性自动消失；后端继续 emit `error: "Exit is only available in the terminal UI."`。
- 未注册 `/xxx`：
  - 第一阶段（最小实现）：前端在拼装 submit body 之前先做本地解析，识别到 `unknown-command` 时弹一个一行提示「未识别命令 `/xxx`，已作为普通消息发送」并仍走 `POST /messages`。
  - 第二阶段（可选）：升级为「弹确认条」让用户选择「按普通消息发送 / 取消」。本 PRD 仅交付第一阶段。
- 分发表 availability：
  - `clear / help`: cli + web
  - `exit / quit`: cli only（Web 命中即返回 `{ kind: 'unsupported' }`）
  - 后续新增 builtin 时按需声明。

### 事件契约

新增一类前后端共识事件：

```
type CommandExecutedEvent = {
  type: 'command_executed';
  name: 'clear' | 'help' | 'exit' | 'quit';
  detail?: Record<string, unknown>;
};
```

前端 `output.js` / `session.js` 监听该事件触发对应 UI 行为。这条事件是稳定契约，新增 builtin 时复用相同 schema。

### 兼容性

- `resolveBuiltinCommand` 外部行为保持不变（CLI 现有 switch 仍可工作），只是 Web 改为走新的 dispatcher。
- 现有 `command-registry.test.ts` 不需要修改，新增 dispatcher 与事件契约的测试。
- 不修改 message 类型、不动 model context，不影响二期 generalize-agent-platform outline。

## Testing Decisions

### 测试原则

- 仅测外部行为：解析后产出哪些 `DispatchResult`、Web emit 哪些事件、前端在收到事件后调用了哪些 UI 重置函数。
- 不测内部 `switch` 分支命中细节、不测具体 DOM 选择器。
- 用 fixture 输入 + 断言 emitted 事件序列的方式覆盖典型路径。

### 模块覆盖

1. `SlashCommandRegistry` 解析层
   - 已有：`command-registry.test.ts` 覆盖 `/clear`、`/help`、`/help <name>`、未识别命令、空白等典型 case。
   - 补充：`unknown-command` 与 `null` 的区分；availability 元数据的存在性。

2. `SlashCommandDispatcher` 分发层（新建测试文件）
   - `/clear` 在 web 上下文 → 返回 `{ kind: 'state-mutation', mutations: ['agent.clearMessages', 'todos.clear'] }`。
   - `/help foo` 在 web 上下文 → 返回 `{ kind: 'message', message: { role: 'assistant', ... } }`。
   - `/exit` 在 web 上下文 → 返回 `{ kind: 'unsupported', reason: 'cli-only' }`。
   - `/exit` 在 cli 上下文 → 返回 `{ kind: 'state-mutation', mutations: ['exit'] }` 或等价语义。
   - `/nope` → 返回 `{ kind: 'unknown-command', name: 'nope' }`。

3. Web `submitMessage` 行为（现有 server 测试或新建）
   - 输入 `/clear` 时：不调用 `agent.stream`、emit `command_executed: clear`、emit `todo_update: undefined`。
   - 输入 `/exit` 时：emit `error` 且不调用 `agent.stream`。
   - 输入未识别 `/xxx` 时：仍走完整 `agent.stream` 路径（与今天行为一致）。

4. 前端最小集成测试（如有 jsdom 环境）
   - 收到 `command_executed: clear` 事件 → state.messages / state.events / state.todos 被清空。
   - 收到 `error: "Exit is only available..."` → 渲染入口提示，未抛错。

### 先前实践

- `src/cli/tui/__tests__/command-registry.test.ts` 是同类型纯函数解析测试的范式，新增 dispatcher 测试沿用其风格。
- 后端 server 行为测试可以参考现有 `web/__tests__/*`（若不存在则建立一个最小新文件）。

## Out of Scope

- 新增任何 builtin 之外的命令（`/compact`、`/tools`、`/agents`、`/profile` 等都归二期 generalize-agent-platform outline）。
- 修改 skill 命令链路（`buildPromptSubmission`、`requestedSkillName`）。
- 改造 message 类型 / ModelContext / provider 调用。
- 修复多轮对话上下文截断 / compact / offload，那是 outline §1.10、§1.11、§4 的范围。
- TUI 渲染重构（如 ink 升级、message-text 拆分），仅保证 TUI 现状不被回归。
- approval pipeline、rejection 熔断器（属于 outline §1.11）。

## Further Notes

- 此 PRD 同时回应了 [docs/study-claude-code](file:///Users/bytedance/Documents/Codex/helixent/docs/study-claude-code) 学习中的发现：Claude Code 的 `processSlashCommand.tsx` 是统一的分发入口，Web/CLI/headless 都共用，避免 helixent 现在 CLI/Web 各写一份 switch 的隐患。
- 完成后建议在 [.trae/documents/generalize-agent-platform-outline.md](file:///Users/bytedance/Documents/Codex/helixent/.trae/documents/generalize-agent-platform-outline.md) 的「关键决策」一节追加一条：斜杠指令分发表为 CLI/Web 共享单源，新增二期命令时无需双写。
- 实施单可拆为 3 个独立 PR：
  1. `command-registry` 增强（增加 availability 元数据 + unknown-command 类型，改造完全向后兼容）。
  2. `SlashCommandDispatcher` + Web `submitMessage` 接入 + `command_executed` 事件契约。
  3. 前端 `session.js / output.js` 监听 `command_executed` 与 unknown-command 提示。
- 验收标准：在 Web 输入框依次输入 `/clear`、`/help`、`/help clear`、`/exit`、`/notacommand`，每条都能给出可见反馈；TUI 行为无回归；现有测试通过 + 新增 dispatcher / web behavior 测试通过。
