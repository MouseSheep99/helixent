# 06 · UI / Services / Telemetry —— 终端渲染、API 层与运营暗面

> 对应评论：`14-ui-state-management.md` / `14-ui-state-rendering.md` / `15-services-api-layer.md` / `17-telemetry-privacy-operations.md`
>
> 关联 outline：§3.1（CLI / TUI 与 Web 借鉴速览）、§6（验收基线，"querySource 重试分类 / 后台 529 不重试"）

## 1. 概述

这一篇把 Claude Code 评论里**离用户最近的三层**揉到一起做对照：

- **UI 状态管理**：一个 35 行的 `createStore` + `useSyncExternalStore`，配合 `AppStateStore` 的 `DeepImmutable<AppState>`、`onChangeAppState` 单一副作用咽喉，以及帧调度 16ms 节流。
- **UI 渲染层**：fork 出来的 Ink + Yoga + Int32Array 双缓冲屏幕、W3C 捕获/冒泡事件分发、虚拟滚动 + WeakMap 高度缓存。
- **Services / API 层**：`getAnthropicClient()` 多提供商工厂、`queryModel()` 700 行核心、`withRetry()` AsyncGenerator 状态机、前台/后台 529 重试白名单、prompt cache 三层 TTL + 会话稳定锁存。
- **Telemetry / 隐私 / 运营**：双通道（1P + Datadog）事件管道、GrowthBook 紧急开关 `tengu_frond_boric` / `tengu-off-switch`、cardinality reduction、undercover 模式、远程托管设置 + "接受或退出"对话框。

helixent 当前在这四层上的体量与 Claude Code 不在同一个量级：TUI 是普通 Ink + 一个 50ms `setTimeout` 节流；community providers 是 SDK 直接 `for await`，**没有任何重试 / 看门狗 / 熔断 / 遥测**。本笔记目的是把"哪些值得二期搬，哪些标 v3 候选"画清楚。

## 2. Claude 做法

### 2.1 UI 状态管理（来源 14-ui-state-management.md）

- **35 行 `createStore`**：`getState / setState / subscribe`，`Object.is` 引用相等跳过，`onChange?: OnChange<T>` 单一副作用钩子。
- **`AppState`** 通过 `DeepImmutable<...>` 包裹大部分字段；含 `Map / Set / 函数` 的字段通过交叉类型排除在 immutable 包装外（务实折衷）。
- **选择器读取**：`useAppState(s => s.verbose)`，底层是 `useSyncExternalStore(subscribe, get, get)`，并发渲染撕裂安全。
- **副作用集中化**：所有 8+ 条修改权限模式的代码路径都流经 `onChangeAppState` 一个 diff，避免"几条路径忘了通知 CCR"导致 Web/CLI 状态不同步。
- **focus 栈 + W3C 事件**：FocusManager 维持最大 32 条目的 focus stack，对话框关闭后自动 pop 回前一个仍挂载的元素。

### 2.2 UI 渲染层（来源 14-ui-state-rendering.md）

- **完整 fork 一份 Ink**：~620KB / 48 个文件，React 19 ConcurrentRoot、Yoga flexbox、`renderer.ts` 把 DOM → Screen 缓冲。
- **打包 Int32Array 屏幕**：每个 cell = 2 个 Int32（charId + styleId/hyperlinkId/width），同 ArrayBuffer 上的 `cells64: BigInt64Array` 一次 `fill(0n)` 清屏；`CharPool` 把字符串 intern 成整数。
- **双缓冲 + ANSI diff**：每帧 reset back，blit 到 back，与 front 对比生成最小 ANSI 输出，stdout.write，再交换。
- **帧调度 16ms 节流**：每次按键经过 `parse-keypress → Dispatcher → React → reconciler → Yoga → Screen → ANSI`，60fps 等效。
- **虚拟滚动**：可见视口 ± 1 屏窗口渲染 + WeakMap 高度缓存；`scrollClampMin/Max` 防止快速滑动出现空白；`stickyScroll` 自动钉底，仅显式上滚才取消。
- **renderer 与 store 解耦**：`useSyncExternalStore` 保证并发渲染读取一致性；选择器粒度的订阅避免不相关 setState 触发整子树 re-render。

### 2.3 Services / API 层（来源 15-services-api-layer.md）

- **多提供商工厂 `getAnthropicClient()`**：通过 `CLAUDE_CODE_USE_BEDROCK / FOUNDRY / VERTEX` 环境变量分发，**动态 `await import()`** 把不用的 SDK 排除在 bundle 外；返回类型对外统一 `as unknown as Anthropic`（"we have always been lying about the return type"）。
- **`buildFetch` 包装器**：第一方请求自动注入 `x-client-request-id` UUID，超时也能跟服务器日志对齐。
- **`queryModel()`（700 行核心）流水线**：熔断开关 → beta header 装配 → 工具搜索过滤（`isDeferredTool`）→ schema 构建 → 消息规范化 → beta header 锁存（`fast_mode/afk_mode/cache_editing`）→ `paramsFromContext` 闭包 → `withRetry` → 原始 SSE 流消费（绕过 SDK 二次方 partial-JSON 重解析）。
- **熔断开关 `tengu-off-switch`**：Anthropic 可在 Opus 雪崩时**远程**禁用非订阅、非自定义模型的 Opus 入口，先做廉价同步检查再 await GrowthBook。
- **`withRetry` 是 AsyncGenerator**：`AsyncGenerator<SystemAPIErrorMessage, T>`，重试间隔 yield 状态消息让 UI 可以渲染"X 秒后重试……"。
- **重试决策矩阵**：
  | 错误 | 策略 |
  |---|---|
  | 429 速率限制 | 遵守 `retry-after` 或快速模式冷却 |
  | 529 过载 | 最多 3 次 → 降级到 Sonnet |
  | 401 / 403 | 强制刷新 OAuth token → 重试 |
  | 400 上下文溢出 | 缩 `max_tokens` → 重试 |
  | ECONNRESET / EPIPE | 关 keep-alive → 重试 |
  | **后台 source 撞 529** | **立即放弃**（FOREGROUND_529_RETRY_SOURCES 白名单） |
- **会话稳定锁存**：beta header（影响 prompt cache key）一旦在会话中翻 `true` 就锁住，不允许中途回退；1h cache TTL 资格、白名单都同样锁存到 bootstrap state，防止 "用户用完配额超额翻转 → 缓存 key 翻转 → 20K token 全部失效"。
- **流空闲看门狗**：默认 `STREAM_IDLE_TIMEOUT_MS = 90s`，`STREAM_IDLE_WARNING_MS = 45s`，监控 chunk 间隔；这一层 SDK 自身不覆盖（SDK timeout 只覆盖初始 fetch）。
- **闭包工厂 + 代际计数器**：`createLSPServerManager()` 用闭包私有状态替代 class；可重入 `initializationGeneration` 让过期初始化的 `.then()` 静默丢弃。

### 2.4 Telemetry / 隐私 / 运营（来源 17-telemetry-privacy-operations.md）

- **双通道**：1P（OTLP / Anthropic 后端 / 磁盘持久化失败重试）+ 第三方 Datadog（白名单 64 种事件）。
- **基数缩减**：`mcp__*` 折叠为 `"mcp"`、未知模型折叠为 `"other"`、`SHA256(userId) % 30` 分桶。
- **GrowthBook 远程开关**：紧急开关如 `tengu_frond_boric`（关 sink）、`tengu_amber_quartz_disabled`（关语音）、`tengu-off-switch`（Opus 熔断）；2 种读取模式（非阻塞 stale / 阻塞 init）。
- **隐私边界**：repo 仅 SHA256 远端 URL（伪匿名，不防定向反查）、bash 命令 17 种白名单提取扩展名画像、deviceId 跨会话稳定。**没有用户侧关闭遥测的设置面板**。
- **远程托管设置 + 接受或退出**：危险变更弹阻塞对话框，拒绝就 `gracefulShutdownSync(1)` 直接退出；非交互 CI 模式跳过该检查（静默应用）。
- **undercover / 模型代号**：`isUndercover()` 只对 ant 员工激活，外部构建 DCE；构建脚本 `excluded-strings.txt` 扫描代号，运行时 `String.fromCharCode` 编码避免 buddy 物种名 `capybara` 撞扫描器。

## 3. 关键代码线索

- `state/store.ts` 35 行；`state/AppStateStore.ts` 570 行 AppState 类型；`state/AppState.tsx:142-163` `useAppState`；`state/onChangeAppState.ts:43-171`。
- `ink/reconciler.ts:224-506`；`ink/screen.ts:21-348`（`CharPool` + 打包 word0/word1）；`ink/dom.ts:31-91`（DOMElement + scrollClampMin/Max）；`ink/events/dispatcher.ts:46-138`。
- `services/api/client.ts:88-189`（`getAnthropicClient` + Bedrock/Foundry/Vertex 分发）；`:358-389` `buildFetch`。
- `services/api/claude.ts:1028-1049` 熔断开关；`:1128-1172` 工具搜索过滤；`:1538-1729` `paramsFromContext`；`:1642-1689` beta header 锁存；`:1818-1928` 原始 SSE + 空闲看门狗；`:358-434` `getCacheControl` + `should1hCacheTTL`。
- `services/api/withRetry.ts:62-82` `FOREGROUND_529_RETRY_SOURCES`；`:96-98` 持久重试常量；`:170-178` `withRetry` 签名。
- `services/api/errors.ts:85-96` `parsePromptTooLongTokenCounts`；`:425` `getAssistantMessageFromError`。
- `services/analytics/firstPartyEventLogger.ts:38-85, 300-302, 396-449`；`services/analytics/datadog.ts:12-17`；`services/analytics/sinkKillswitch.ts`。
- `services/remoteManagedSettings/index.ts:52-54`；`securityCheck.tsx:67-73` `gracefulShutdownSync(1)`。
- `utils/undercover.ts:28-37`；`utils/attribution.ts:52-55`。

## 4. helixent 现状

> 路径相对仓库根 `/Users/bytedance/Documents/Codex/helixent`。所有行号对应当前 main。

### 4.1 TUI 状态层

- 入口 `src/cli/tui/app.tsx:25-82`：直接消费 `useAgentLoop()` / `useApprovalManager()` / `useAskUserQuestionManager()`，无全局 store；状态完全在 hook 内部 `useState`。
- `src/cli/tui/hooks/use-agent-loop.ts:31-73`：`messages` 由 React `useState` 持有；通过 `pendingMessagesRef + flushTimerRef` 做了一层 **50ms `setTimeout` 节流批刷**（`enqueueMessage` → `flushPendingMessages`）。这是 helixent 唯一类似 Claude "16ms 帧节流" 的机制，但粒度更粗、且只对消息生效，对其他 UI 状态无效。
- `:118-149` 主循环：`for await (const event of agent.stream(userMessage)) { if (event.type === "message") enqueueMessage(event.message); }`，`finally` 里 `flushPendingMessages() + setStreaming(false)`。
- `src/cli/tui/hooks/use-approval-manager.ts:5-25`：`globalApprovalManager.subscribe` —— 这是 helixent 唯一一个**外部可观察的全局状态源**，用 `useState` + `useEffect` 桥接到 React。其形状已经接近 Claude Code 的 `subscribe` 协议，但只服务审批一件事。
- 没有 `DeepImmutable<...>`、没有选择器、没有 `onChangeAppState` 单一副作用咽喉。

### 4.2 TUI 渲染层

- `src/cli/tui/components/message-history.tsx:11-213`：`MessageHistory / MessageHistoryItem / AssistantMessageItem / ToolUseContentItem` 全部 `memo` 包；`AssistantMessageItem` 渲染 `text` / `tool_use`，`ToolUseContentItem` 按 `content.name` switch（bash / str_replace / read_file / write_file / list_files / file_info / mkdir / glob_search / grep_search / move_path / apply_patch / ask_user_question / todo_write / 默认 fallback）。
- `app.tsx:42-59`：**只渲染 `lastMessage`**（`messages[messages.length - 1]`），其余用 `useFlushToScrollback` 写到 stdout 的 scrollback buffer。这是 helixent 自己设计的"偷工减料版虚拟滚动"——不渲染历史消息，让终端原生滚动条接管，规避了大列表 Ink re-render 的成本，但失去 React 内交互（搜索 / 高亮 / 跳转）的可能性。
- `src/cli/tui/message-text.ts:50-77` `toolUseText`：与 `ToolUseContentItem` **平行**的 ANSI 文本版（rgb→ansi 自手写常量 ESC/RESET/BOLD/DIM/WHITE/GRAY），用于上面 scrollback flush。两份实现按工具名 switch 分支结构完全一致，但故意未抽象（见仓库 `AGENTS.md` "tool use rendering CLI vs TUI" 说明）。
- 没有 fork Ink、没有自定义 reconciler、没有 Int32Array screen、没有 W3C 事件分发、没有 WeakMap 高度缓存。

### 4.3 Services / Provider 层

- `src/community/anthropic/index.ts:1`：`export * from "./model-provider"`。
- `src/community/anthropic/model-provider.ts:16-79` `AnthropicModelProvider`：构造 `new Anthropic({...})`，`invoke` 调 `messages.create`，`stream` 调 `messages.create({...stream:true})` 然后 `for await` 喂给 `StreamAccumulator`，每个事件 `yield acc.snapshot()`。**无重试 / 无看门狗 / 无降级 / 无 querySource 概念**。
- `:62-68` 唯一一处针对 thinking 的归一化：`thinking.budget_tokens ??= floor(max_tokens * 0.8)`。无 prompt cache 控制、无 beta header 锁存。
- `src/community/anthropic/stream-utils.ts:26-123` `StreamAccumulator`：自实现的 SSE 累加器，按 `message_start / content_block_start / content_block_delta / message_delta` 分支累计 text / thinking / tool_use partialJson，`snapshot()` 返回 `AssistantMessage`。这一段的设计动机其实就是 Claude Code 评论里 "**O(n²) partial JSON 解析问题**"——helixent 已经走对了，每次只追加 delta、不重解析；但 `parseToolInput` `:149-156` 仍然每次 snapshot 都 `JSON.parse(partialJson)` 一次，长 tool input 仍是 O(n²)。
- `src/community/openai/index.ts:1` 仅 re-export；`model-provider.ts:21-99` OpenAIModelProvider：`new OpenAI({baseURL, apiKey})`，`invoke / stream` 走 `chat.completions.create`，无 reasoning / tool stream 顺序处理（在 `StreamAccumulator` 里）；默认 `temperature: 0`，`stream_options: { include_usage: true }`。无重试 / fetch override / request-id 注入。

### 4.4 Telemetry / 运营

- helixent **完全没有遥测层**。无 1P 通道、无 Datadog、无 GrowthBook、无 feature flag、无 undercover、无 remote settings。这一项是 outline 里明确标 v3 候选的（B3.9 "undercover / 远程紧急开关 / 模型代号" 标 ❌ 不采纳）。

## 5. 差距与借鉴判断

| # | 借鉴点 | helixent 现状 | 二期取舍 | 优先级 | 标记 |
|---|---|---|---|---|---|
| U1 | 35 行 `createStore` + `useSyncExternalStore` 替代 hook 内部 `useState` | `useState` 直接持有 messages / streaming / approvalRequest | TUI 全局状态规模仍小（≈3 个），暂无收益；Web 端引入再评估 | ⭐ | [v3 候选] |
| U2 | `DeepImmutable<AppState>` + 选择器 | 无 immutable，无选择器 | 与 U1 绑定 | ⭐ | [v3 候选] |
| U3 | `onChangeAppState` 单一副作用咽喉 | 无 | 当前没有"多路径修改同一字段忘通知"的痛点 | ⭐ | [v3 候选] |
| U4 | 16ms 帧节流 | 50ms `setTimeout` 批刷消息（`use-agent-loop.ts:54-64`） | 现版够用；如要支持 streaming token-by-token 再优化 | ⭐ | [v3 候选] |
| U5 | fork Ink + Int32Array screen + 双缓冲 | Ink 原生 + 只渲染 lastMessage + scrollback flush | 与 helixent 极简思路冲突 | — | [v3 候选] |
| U6 | 虚拟滚动 + WeakMap 高度缓存 | scrollback flush 已规避问题 | 仅当未来要做 Web 端 trace 长列表时考虑 | ⭐ | [v3 候选] |
| U7 | 平行渲染器（CLI plain text vs TUI Ink）抽 `summarize(input) → {title, detail, kind}` | 两份 switch 平行复制（已在 `AGENTS.md` / outline §2.5.2 标注）| 已纳入 outline §2.4.6 / §2.5.4 ToolSummary 设计 | ⭐⭐ | [已纳入 §2.5.4] |
| S1 | `withRetry` AsyncGenerator + 状态消息 yield | provider 直接 SDK 调用，无任何重试 | 二期模块 1 §1.10 + B1.6 已规划 | ⭐⭐ | [已纳入 §1.10 / B1.6] |
| S2 | 重试决策矩阵（429/529/401/400PTL/ECONNRESET） | 全无 | 同上，按 outline B1.6 落到 foundation/models | ⭐⭐ | [已纳入 §B1.6] |
| S3 | **后台 querySource 撞 529 立即放弃**（FOREGROUND_529_RETRY_SOURCES） | 无 querySource，无前/后台分类 | 已贯穿 §1.10 AgentSession.querySource，§6 验收基线明确测试 | ⭐⭐⭐ | [已纳入 §1.10 / §6] |
| S4 | 流空闲看门狗 90s | 无 | 与 S1 同期落地 | ⭐⭐ | [已纳入 §B1.6] |
| S5 | 多提供商动态 import 工厂 | helixent 已分目录（`community/anthropic` / `community/openai`），但调用方 `new XxxModelProvider()` 直接绑定，无工厂分发 | 当前规模不必引入；保留两 provider 并行 | ⭐ | [v3 候选] |
| S6 | `buildFetch` 注入 `x-client-request-id` | 无 | 落到 foundation/models 可选注入；调试友好 | ⭐ | [已纳入 §B3.8] |
| S7 | beta header / 1h cache TTL 会话稳定锁存 | 无 prompt cache 控制、无 beta header 切换 | helixent 当前不暴露 beta header 切换，无锁存需求；引入时再说 | ⭐ | [v3 候选] |
| S8 | 原始 SSE 绕过 SDK O(n²) partial JSON 解析 | `StreamAccumulator` 已每事件追加而非重解析；但 `parseToolInput` 仍每帧 `JSON.parse(partialJson)` | 改 snapshot 时复用上一帧 input、仅在 `content_block_stop` 终态解析 | ⭐ | [v3 候选] |
| S9 | 闭包工厂 + 代际计数器（LSP）| helixent 暂无热重载场景 | 不采纳 | — | [v3 候选] |
| S10 | `getAssistantMessageFromError` 错误分类 + UI 友好提示 | `use-agent-loop.ts:134-141` 简单 `error instanceof Error ? .message : String(error)` 后 `Error: ${msg}` | 二期可加最小子集（PROMPT_TOO_LONG / 429 / 网络错误）| ⭐ | [v3 候选] |
| T1 | 1P 双通道遥测 + Datadog | 无 | 违反开源透明默认 | — | [v3 候选] |
| T2 | GrowthBook 紧急开关 | 无 | 不采纳（B3.9 已标❌）| — | [v3 候选] |
| T3 | undercover / 模型代号 / excluded-strings 扫描 | 无 | 不采纳，与 helixent OSS 定位冲突 | — | [v3 候选] |
| T4 | 远程托管设置 + "接受或退出" | 无 | 不采纳 | — | [v3 候选] |
| T5 | repo / device fingerprint | 无 | 不采纳；如要做 trace 仅 in-memory + 用户可关闭 | — | [v3 候选] |

## 6. 与 outline 章节关联

- **§3.1 模块 3 · Profile 只读 Web UI 借鉴点速览**：本笔记的 U/S/T 列直接对应 outline §3.1 的 B3.1～B3.9。其中 **B3.4 AsyncGenerator 重试管道**、**B3.5 35 行 store**、**B3.6 virtual scroll**、**B3.7 `/context` 命令**、**B3.8 client request_id**、**B3.9 undercover** 全部在 §3.1 表格里有标记，本笔记给出 helixent 现状后的具体取舍证据。
- **§1.10 AgentSession + querySource 元数据贯穿**：S3 "后台 529 立即放弃" 是 §1.10 设计的关键依据；outline 已写明 `FOREGROUND_SOURCES = new Set(["main"])`、非前台撞 529 立即放弃、不被反向放大。本笔记把对应的 Claude 源码坐标 `withRetry.ts:62-82` 串好。
- **§6 验收基线**：明确包含一条 **"querySource 重试分类：mock 后台 querySource 撞 529，断言不重试（前台 querySource 撞 529 触发标准重试矩阵）"**（行 1607）。这条验收基线就是本篇 S1+S2+S3 三项联合落地的最小可观测断言。
- **B1.6**："流空闲 watchdog 90s + 重试矩阵（429/529/401/400 PTL/ECONNRESET）" → 本笔记 S1/S2/S4 的具体落点。
- **B3.8**："客户端 request_id 注入" → 本笔记 S6 的具体落点。
- **§2.5.4 TUI tool-trace 增强 + §2.4.6 Tool registry summarize**：本笔记 U7 "平行渲染器抽 ToolSummary" 已被该章节吸收（`tool.summarize(input)` 在 TUI / Web / log 通用渲染）。
- **B1.8 parentSessionId trace 链**：与 telemetry 跨 session 关联呼应（虽 helixent 不做完整遥测，但 trace 链元数据已规划）。

## 7. 对 helixent 二期的具体启示

- **优先把 `withRetry` AsyncGenerator + 后台 529 放弃做掉**，这是把 outline §6 验收基线"querySource 重试分类"变成可断言的最小切片。落点是 `foundation/models` 增加一层 `withRetry()` 包装，`community/anthropic|openai` provider 透传 `querySource`，`FOREGROUND_SOURCES` 默认只含 `"main"`；测试用 mock provider 在 `querySource: "compact"` 撞 529 时断言一次失败即返回错误消息、不重试。`[已纳入 §1.10 / §B1.6 / §6]`

- **流空闲 watchdog 90s + 错误分类最小子集**：在 `AnthropicModelProvider.stream` `messages.create({stream:true})` 外包一层 `setTimeout(90_000)`，每个 chunk 续期；超时 abort 流并 yield `SystemAPIError(stream_idle_timeout)`。错误分类只挑三类落地——`PROMPT_TOO_LONG`（解析 `actualTokens / limitTokens`）、`429 / RATE_LIMIT`（透传 `retry-after`）、`NETWORK_RESET`（ECONNRESET / EPIPE / ETIMEDOUT），其余兜底字符串。这把 `use-agent-loop.ts:134-141` 的"裸 `error.message` + `Error:` 前缀"升级成可观测的可重试信号。`[已纳入 §B1.6]`

- **TUI tool 渲染统一到 `ToolSummary`**：把 `message-text.ts:50-77` 与 `message-history.tsx:112-213` 两份按工具名 switch 抽到 `tool.summarize(input) → {title, detail?, kind}`，TUI 用 Ink 节点展开、scrollback flush 用 ANSI 渲染、Web `/traces` 用 HTML 渲染——三处共用一份摘要语义。`todo_write` 仍特例化（Ink 端读 `todoSnapshots`），与现有 `AGENTS.md` 注解一致。`[已纳入 §2.4.6 / §2.5.4]`

- **`x-client-request-id` 可选注入**：`foundation/models` 增加 `requestIdHeader?: string` 选项，provider 在 `fetch` 包装层每个请求注入 `crypto.randomUUID()`，trace event 同时落库该 id。代价极小，超时调试与 Web `/traces` 上的"按 request id 查"立刻可用。`[已纳入 §B3.8]`

- **暂不引入全局 `createStore` / `DeepImmutable`**：当前 TUI 状态规模（messages / streaming / approvalRequest / askUserQuestionRequest / latestTodos）尚不构成"多路径忘通知"的痛点，且 `globalApprovalManager.subscribe` 已经把"必须跨 React 边界共享"的部分隔出去了。等到 v3 Web 端引入时再统一引 35 行 store + selector，规模收益才显著。`[v3 候选]`

- **遥测整线（双通道 / GrowthBook / undercover / remote settings / fingerprint）整体不采纳**：与 helixent 开源透明定位冲突。trace 仅保留 in-memory + 文件落盘 + Web `/traces` 只读视图（已在 outline §2.5 / §模块 3）；不引入 1P / 第三方上报、不做远程紧急开关、不做模型代号混淆。这条对应 outline B3.9 表内显式标记 ❌。`[v3 候选]`

- **`StreamAccumulator.parseToolInput` 优化推迟**：当前每次 snapshot `JSON.parse(partialJson)` 是 O(n²)，但工具 input 体量普遍 < 4KB，实际帧数也低。等观察到 long tool input 卡顿时，再改成"仅在 `content_block_stop` 终态解析、中间帧返回上一次的 `input`"。`[v3 候选]`

---

> **下一篇**：本系列 06 集为最后一集，参见 [`00-index.md`](./00-index.md) 总表。
>
> **上一篇**：[`05-bootstrap-config-session.md`](./05-bootstrap-config-session.md)（如已生成）。
