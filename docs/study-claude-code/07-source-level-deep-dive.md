# 07 · Claude Code 源码级深读补充

## 0. 这次补学的口径

上一轮笔记主要是按 19 篇架构评论做模块归纳，粒度偏“系统设计”。这份补充把本地 `claude-reviews-claude/architecture/zh-CN/*.md` 当作**源码索引**来读：重点抽取评论中出现的源码文件、函数名、类型名、状态机、调用链和工程约束，再反向对照 helixent 当前代码。

补充说明：后来已根据用户提供的 `https://github.com/liuup/claude-code-analysis/tree/main/src` clone 到 `/Users/bytedance/Documents/Codex/claude-code-analysis`，该仓库包含可直接读取的 Claude Code 源码分析版。本文保留为“评论索引级”深读；真实源码行号与文件级证据见同目录 `08-real-source-backed-deep-dive.md`。

## 1. Query Engine / Agent Loop

### 1.1 源码坐标

| Claude Code 源码线索 | 角色 | helixent 对照 |
|---|---|---|
| `QueryEngine.ts` | 会话级对象，持有历史、usage、文件缓存、session 状态 | [agent.ts](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts) 目前 `Agent` 同时兼任会话与回合 |
| `query.ts` / `query()` | 单个用户回合的异步生成器主循环 | [Agent.stream](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L140-L171) |
| `src/cost-tracker.ts` | session/model 维度成本与 token 账本 | helixent 暂无 usage 累计账本 |
| `src/services/api/withRetry.ts` | API 重试状态机，yield 状态消息 | helixent provider 直接调用 SDK |
| `src/services/api/claude.ts` | 原始 SSE、空闲 watchdog、queryModel 流水线 | [AnthropicModelProvider](file:///Users/bytedance/Documents/Codex/helixent/src/community/anthropic/model-provider.ts) |
| `src/context.ts` | Git / 用户 / 系统上下文收集 | [lead-agent.ts](file:///Users/bytedance/Documents/Codex/helixent/src/coding/agents/lead-agent.ts) 仅装配 prompt |
| `src/utils/messages.ts` | API 消息规范化、thinking block 不变量 | helixent 直接传 messages，规范化较薄 |

### 1.2 关键调用链

```text
submitMessage()
  -> processUserInput()
  -> getSystemContext() / getUserContext()
  -> query()
       -> 预算预处理 / snip / microcompact / autocompact
       -> queryModel()
       -> withRetry()
       -> 原始 SSE 消费
       -> 工具执行
       -> 若有 tool_use 继续 while(true)，否则 end_turn
```

Claude Code 最核心的设计是**双层宿主**：

- `QueryEngine` 是 conversation/session 层，长期持有可变状态。
- `query()` 是 turn 层，只负责当前用户输入触发的一次 ReAct/API 循环。
- 所有外部通信通过 `AsyncGenerator` 的 `yield` 返回，`return()` 即取消。

helixent 当前的 [Agent](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L48-L91) 把 profile、messages、tools、middlewares 都放在一个类里，缺少独立的 `AgentSession`。这就是二期 outline §1.10 要补 `AgentSession + querySource` 的根因。

### 1.3 状态机

| 状态机 | Claude Code 做法 | helixent 当前 | 迁移判断 |
|---|---|---|---|
| Query 主循环 | `while(true)`：预处理 → API → 工具 → 决策 | `for step <= maxSteps` | 现版够用；先补 session，再考虑 while |
| 消息事件 | `assistant/user/progress/stream_event/system/tombstone` 单 yield 管道 | `message/progress` 两类 | compact / retry 后需要扩展 |
| API 错误 | 429/529/401/403/ECONNRESET/context overflow 分支 | 工具错误转字符串，provider 错误直抛 | 二期应补最小 `withRetry` |
| 529 | 前台重试，后台 `querySource` 立即放弃 | 无 querySource | 已纳入 §1.10 / §6 |
| max output | 64K 升级 → 恢复消息最多 3 次 → 暴露错误 | 无 | v3 候选 |
| SSE | message_start/content_block_delta/... O(1) 追加 | `StreamAccumulator` 已做 delta 追加 | helixent 方向正确 |

### 1.4 真正要学的点

- Claude Code 的“复杂”不在主循环本身，而在主循环前后的**安全网**：消息规范化、预算预处理、错误恢复、retry、成本账本、querySource 分类。
- helixent 不应该直接复制 1700 行 `query()`，而应该先把 `Agent.stream()` 周边能力拆出去：`AgentSession`、`ModelRequestContext`、`withRetry`、`ContextBudgetMiddleware`。
- `querySource` 不是日志字段，而是会影响行为的控制面：后台 compact / sub-agent / hook-agent 的 529 不应像 main 一样烧重试。

## 2. Tools / Bash / Permissions

### 2.1 源码坐标

| Claude Code 源码线索 | 角色 | helixent 对照 |
|---|---|---|
| `Tool.ts` | `Tool<Input, Output, Progress>` 大接口 | [function-tool.ts](file:///Users/bytedance/Documents/Codex/helixent/src/foundation/tools/function-tool.ts) |
| `tools.ts` | `getAllBaseTools()` / `assembleToolPool()` | [lead-agent.ts](file:///Users/bytedance/Documents/Codex/helixent/src/coding/agents/lead-agent.ts#L103-L117) 手写数组 |
| `src/services/tools/toolExecution.ts` | `runToolUse()` 主执行管道 | [Agent._act](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L222-L272) |
| `src/utils/toolResultStorage.ts` | 大结果落盘与预览 | [tool-result-runtime.ts](file:///Users/bytedance/Documents/Codex/helixent/src/agent/tool-result-runtime.ts) |
| `tools/BashTool/` | Bash 入口、prompt、UI、常量、utils | [bash.ts](file:///Users/bytedance/Documents/Codex/helixent/src/coding/tools/bash.ts) 单文件 |
| `utils/permissions/permissions.ts` | `hasPermissionsToUseToolInner()` | [coding-approval-middleware.ts](file:///Users/bytedance/Documents/Codex/helixent/src/coding/permissions/coding-approval-middleware.ts) |
| `denialTracking.ts` | 拒绝熔断器 | helixent 暂无 |
| `yoloClassifier.ts` | auto 模式 AI 分类器 | 不建议二期采纳 |

### 2.2 Tool 执行链

```text
模型输出 tool_use
  -> runToolUse()
  -> 查找 tool
  -> abort signal 检查
  -> streamedCheckPermissionsAndCallTool()
       -> inputSchema.safeParse()
       -> tool.validateInput()
       -> Bash 投机分类 / readOnly 判断
       -> PreToolUse hooks
       -> canUseTool()
       -> tool.call()
       -> PostToolUse hooks
       -> mapToolResultToToolResultBlockParam()
       -> processToolResultBlock()
       -> contextModifier
       -> 注入 newMessages
```

helixent 当前 [Agent._act](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L222-L272) 已经有并行工具执行雏形，但工具元数据太少：

- 没有 `capabilities`，所以 approval 只能靠工具名白名单。
- 没有 `summarize`，所以 TUI / Web / policy 到处写 switch。
- 没有 `resultPolicy.maxResultSize`，所以大结果只截断或转结构化结果。
- 没有 `requiresUserInteraction`，未来 bypass/auto 模式会有风险。

### 2.3 Bash 引擎真正复杂的地方

Claude Code 的 Bash 不是简单 spawn，而是一套高风险工具运行时：

| 子系统 | 关键机制 |
|---|---|
| 输入 schema | `command` / `timeout` / `description` / `run_in_background` / `dangerouslyDisableSandbox` / 隐藏 `_simulatedSedEdit` |
| 运行函数 | `runShellCommand()` 是 `AsyncGenerator`，进度和最终结果共用一条控制流 |
| Shell 发现 | `CLAUDE_CODE_SHELL` → `$SHELL` → `which zsh/bash`，只允许 bash/zsh |
| CWD 跟踪 | 命令尾部追加 `pwd -P > cwd-file`，退出后同步读取 |
| 快照 | `createAndSaveSnapshot()` 捕获 PATH/alias/function，之后 source 快照 |
| I/O | stdout/stderr 合并到同一 fd，保证时间顺序 |
| 后台化 | 显式后台 / 超时后台 / 助手模式 15s / 用户 Ctrl+B |
| 看门狗 | 后台输出文件每 5s 查 size，超限 SIGKILL 进程树 |
| 沙箱 | macOS seatbelt，Linux/WSL2 bubblewrap + seccomp |
| 零 token 侧信道 | `<claude-code-hint />` 写 stderr，传模型前剥离 |

helixent 的 [bash.ts](file:///Users/bytedance/Documents/Codex/helixent/src/coding/tools/bash.ts) 目前是最小 `Bun.spawn` 风格。二期不应把 Bash 全量重做塞进通用化平台，但至少要学两件事：

- **输出治理**：长输出落盘 / offload，而不是直接塞上下文。
- **进程生命周期**：timeout、abort、后台任务、输出大小上限要统一设计。

### 2.4 权限流水线

Claude Code 的 `hasPermissionsToUseToolInner()` 是严格有序的短路链：

```text
1a 工具级 deny
1b 工具级 ask
1c tool.checkPermissions()
1d 工具实现拒绝
1e requiresUserInteraction
1f 内容级 ask
1g 安全护栏（.git/.claude/.vscode/shell config）
2a bypassPermissions
2b allow 规则
3 默认 ask
```

学习点不是“做 11 阶段权限系统”，而是：

- 安全护栏要**绕过免疫**：即使用户开 bypass，也不能写 `.git/`、shell 配置、工具自身配置。
- 权限不能只看 tool name，必须有 `capability + input` 两层。
- 拒绝不是普通 tool_result，连续拒绝会导致模型循环尝试，必须有 `DENIAL_LIMITS = { maxConsecutive: 3, maxTotal: 20 }`。

## 3. Context Assembly / Compact

### 3.1 源码坐标

| Claude Code 源码线索 | 角色 | helixent 对照 |
|---|---|---|
| `prompts.ts` | `getSystemPrompt()`，静态/动态边界 | [lead-agent.ts](file:///Users/bytedance/Documents/Codex/helixent/src/coding/agents/lead-agent.ts#L80-L101) |
| `claudemd.ts` | CLAUDE.md 多源加载、include、frontmatter | [lead-agent.ts](file:///Users/bytedance/Documents/Codex/helixent/src/coding/agents/lead-agent.ts#L55-L78) |
| `attachments.ts` | 每轮动态附件，1s timeout | helixent 暂无附件层 |
| `microCompact.ts` | 旧工具结果局部清理 | helixent 暂无 |
| `autoCompact.ts` | token 阈值自动压缩 | helixent 暂无 |
| `compact.ts` | full compact 摘要 | helixent 暂无 |
| `grouping.ts` | 按 API round 分组，PTL 重试 | helixent 暂无 |
| `postCompactCleanup.ts` | PostCompact Recovery | helixent 暂无 |

### 3.2 Context Assembly 结构

Claude Code 的上下文不是一条 prompt 字符串，而是多层装配：

```text
System Prompt
  -> 静态前缀：身份、规则、工具使用、风格
  -> 动态后缀：coordinator/fork/skills/MCP/cwd/git/token budget

User/System Context
  -> Git 状态、分支、最近日志、用户名
  -> CLAUDE.md 多源记忆

Attachments
  -> 每轮重算
  -> TODO reminder / plan reminder / skill discovery
  -> 1s timeout
```

`SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 的本质是 prompt cache 经济性：稳定内容尽量放前面，动态内容放后面，避免小变化击穿整段缓存。

### 3.3 Compact 状态机

| 层级 | Claude Code 机制 | helixent 二期判断 |
|---|---|---|
| Tool result budget | 限制单工具结果进入上下文的体积 | 必做，结合 `resultPolicy` |
| Snip | 用户/模型显式裁剪旧片段 | v3 |
| Microcompact | 清理旧工具结果，保留结构 | MVP 可做最小版 |
| Context collapse | 归档旧 API round | v3 |
| Autocompact | 接近阈值自动 full compact | 先做 manual `/compact` |
| Full compact | 9 段摘要 + recovery | manual `/compact` 必做 |

关键安全网：

- `adjustIndexToPreserveAPIInvariants()`：不能拆开 `tool_use` 和 `tool_result`。
- `groupMessagesByApiRound()`：PTL 重试时按 API 轮组丢弃，而不是按单条消息乱删。
- `calculateTokenWarningState()`：ok/warn/error/autocompact/blocking 四档。
- `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`：自动 compact 失败熔断。
- `querySource === "compact"` 时禁止再次触发 compact，防递归。
- PostCompact Recovery 注入 recent files、skills、todo、MCP instructions。

这说明 §1.10 `AgentSession.compactInProgress`、`consecutiveCompactFailures`、`currentSource` 不是“锦上添花”，而是 compact 能安全跑起来的宿主字段。

## 4. Coordinator / Swarm / Session / Bridge

### 4.1 Coordinator 源码模型

| Claude Code 源码线索 | 角色 |
|---|---|
| `coordinator/coordinatorMode.ts` | Normal / Coordinator 双模式 |
| `tools/AgentTool/` | 创建 Worker |
| `tools/SendMessageTool/` | 给 Worker 发后续消息 |
| `tools/TaskStopTool/` | 停止 Worker |
| `tools/TeamCreateTool/` | 创建团队 |
| `utils/teammateMailbox.ts` | JSON 文件邮箱 |
| `tools/shared/spawnMultiAgent.ts` | 多 agent 生成链 |
| `src/tasks/` | `TaskState` 联合类型 |

Coordinator 的关键不是“并发很多 agent”，而是**隔离 + 协议**：

- 协调者没有 fs/bash 权限，只能委派。
- Worker 零上下文启动，prompt 必须自包含。
- 结果通过 `<task-notification>` 作为 user message 注入。
- Research → Synthesis → Implementation → Verification 是明确工作流。
- 验证 Worker 用 fresh context，避免自我背书。

### 4.2 Swarm 调用链

```text
TeamCreateTool
  -> 生成 team name
  -> 创建 team-lead@team
  -> 写 ~/.claude/teams/{team}/config.json
  -> spawnMultiAgent()
       -> 解析模型
       -> 生成成员名
       -> 检测后端 tmux / iTerm2 / in-process
       -> 创建窗格或进程
       -> 构建 CLI 参数
       -> 注册成员
       -> 发送初始消息
```

队友通信路径：

```text
SendMessage(to)
  -> in-process pendingMessages
  -> local agent queuePendingMessage
  -> tmux/iTerm2 文件邮箱
  -> UDS / Bridge
  -> broadcast "*"
```

### 4.3 Session / Bridge 学习点

Session persistence 的核心链：

```text
enqueueWrite -> scheduleDrain -> drainWriteQueue
appendEntryToFile -> appendFileSync（退出兜底）
loadConversationForResume
  -> loadTranscriptFile
  -> parseJSONL
  -> buildConversationChain
  -> recoverOrphanedParallelToolResults
  -> deserializeMessagesWithInterruptDetection
```

Bridge 的核心状态：

- worker epoch 防双 worker 抢同一会话。
- JWT 过期前 5 分钟刷新。
- bridge pointer 支持崩溃恢复。
- capacity wake 用 `AbortController` 打断容量等待。

helixent 二期不应上 bridge，但 session persistence 里 `parentUuid → uuid` 链、append-only JSONL、退出同步写、orphan tool_result recovery 都值得 v3 预留。

## 5. UI / Services / Telemetry

### 5.1 UI 源码模型

| Claude Code 源码线索 | 角色 | helixent 对照 |
|---|---|---|
| `state/store.ts` | 35 行 `createStore` | React hook state |
| `state/AppStateStore.ts` | `DeepImmutable<AppState>` | 无统一 store |
| `state/onChangeAppState.ts` | 单一副作用咽喉 | 多处 hook 副作用 |
| `ink/reconciler.ts` | fork Ink reconciler | Ink 原生 |
| `ink/screen.ts` | Int32Array screen 双缓冲 | TUI scrollback flush |
| `ink/events/dispatcher.ts` | W3C 捕获/冒泡事件 | Ink 默认事件 |

短期学习点：

- 不需要复制 fork Ink。
- 可以学习 `createStore + selector`，但 helixent 规模暂时不够。
- 更现实的是统一 tool 渲染摘要：`message-text.ts`、`message-history.tsx`、Web trace 不应该各写一套 switch。

### 5.2 Services 源码模型

`queryModel()` 的真实形态是一条长流水线：

```text
熔断开关
  -> beta header 装配
  -> tool search / deferred tool 过滤
  -> schema 构建
  -> messages normalize
  -> header/cache latch
  -> paramsFromContext
  -> withRetry()
  -> raw SSE
  -> stream idle watchdog
```

最值得 helixent 吸收的最小集合：

- `withRetry()` 返回 `AsyncGenerator<SystemAPIErrorMessage, T>`，重试状态能流到 UI。
- `querySource` 控制 529 策略：main 可重试，compact/sub-agent 不烧重试。
- `STREAM_IDLE_TIMEOUT_MS = 90s`，SDK timeout 不等于流空闲 timeout。
- `x-client-request-id` 注入，便于 trace 与 provider 日志关联。
- 错误分类最小子集：prompt too long / 429 / 529 / network reset。

不建议吸收：

- 1P + Datadog 双通道遥测。
- GrowthBook 远程熔断。
- undercover / 模型代号混淆。
- 远程托管设置的“接受或退出”。

## 6. 对 helixent 的更具体落点

| 优先级 | 学到的 Claude Code 机制 | helixent 落点 | 原因 |
|---|---|---|---|
| P0 | `AgentSession` 分离 session / turn | `src/agent/session/*` 或 `src/agent/agent-session.ts` | 所有 compact/retry/sub-agent 的宿主 |
| P0 | `querySource` 贯穿 | model provider context + trace event | 529 重试、compact 递归防护都依赖 |
| P0 | `defineTool.capabilities` | `function-tool.ts` | 新工具不再到处改审批白名单 |
| P0 | `DENIAL_LIMITS` | approval middleware + Agent step 前检查 | 防拒绝循环 |
| P1 | `ToolSummary` | `tool-result-summary.ts` + TUI/Web | 消灭三处 switch |
| P1 | tool result storage/offload | `tool-result-runtime.ts` + ContextStore | 大输出不炸上下文 |
| P1 | `withRetry` | `foundation/models` | provider 统一错误策略 |
| P1 | token warning state | compact middleware | 给 `/compact` 和 blocking 提供依据 |
| P2 | append-only session JSONL | `src/agent/session-store/*` | resume/fork/v3 |
| P2 | pre/post tool hook 总线 | 扩展 middleware | plugin/v3 |
| P3 | bridge / remote control | 暂不做 | 与二期目标无关 |
| P3 | telemetry/growthbook | 不做或用户显式 opt-in | 开源透明定位 |

## 7. 结论

Claude Code 值得学的不是“把所有系统都堆进来”，而是几个反复出现的工程原则：

- **会话宿主显式化**：跨回合状态不能散落在 `Agent`、middleware、UI hook 里。
- **控制面字段贯穿**：`querySource`、permission mode、session id、parent session id 都会改变行为。
- **长会话优先安全网**：compact 不是摘要 prompt，而是 token 状态机 + API 不变量 + recovery + 熔断。
- **工具平台化**：tool 不是函数，而是 schema、权限、UI、结果策略、上下文修改、并发语义的组合体。
- **协议优先于耦合**：sub-agent、bridge、hook 都通过可记录/可恢复的消息协议连接，而不是互相拿对象引用。
- **失败即关闭**：权限、分类器、沙箱、自动模式、compact 都要有保守默认值。

下一步如果要真正进入实现，应该先做 P0：`AgentSession + querySource`、`defineTool.capabilities`、拒绝熔断器、`ToolSummary`。这些是从源码级学习里反复出现的共通地基。
