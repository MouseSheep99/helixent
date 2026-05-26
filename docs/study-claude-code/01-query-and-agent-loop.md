# 01 · Query Engine 与 Agent Loop

## 1. 概述

本主题对应 Claude Code 的"大脑"——`QueryEngine` + `query()` 双层异步生成器主循环、`coordinatorMode` 隐藏的多智能体协调器、以及 swarm/Task 工具构成的 sub-agent 生态。它在 Claude Code 中承担**会话状态宿主、回合级 ReAct 调度、工具并行执行、压缩流水线、错误恢复、querySource 元数据贯穿、parentSessionId 血统链**等多重职责。helixent 在 [`src/agent/agent.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts) 中已具备一个**单层、纯 ReAct、无会话宿主**的对照实现。本笔记对照三篇评论（01 query engine / 03 coordinator / 08 agent swarms）梳理结构性差距，并指引到二期 outline 的对应落点。

---

## 2. Claude 做法

### 2.1 query engine 主循环（评论 01）

- **双层架构**：`QueryEngine`（会话级，1296 行）持有消息历史、累计 usage、文件缓存；`query()`（回合级，1730 行）是一个 `while(true)` 异步生成器，跑"压缩 → 调 API → 工具执行 → 决策"四步。
- **AsyncGenerator 即通信协议**：所有事件通过 `yield` 流出，无回调；`return()` 即取消，天然背压。
- **预处理流水线 5 级**：tool result budget → snip → microcompact → context collapse → autocompact，全部在 `beforeModel` 之前。
- **`while(true)` 的"愚钝脚手架"**：所有智能交给 LLM，循环结构刻意简单。
- **错误恢复 5 类矩阵**：429 指数退避、529 前台重试/后台放弃、401 OAuth 刷新、`max_tokens` 三级升级、流空闲 90s watchdog。
- **消息分发 switch**：assistant / user / progress / stream_event / system / tombstone 一律通过同一 yield 管道。
- **不可变快照 + 可变状态**：跨回合保留 mutable 历史，但每次循环迭代取不可变快照，保证 prompt cache 字节稳定。

### 2.2 coordinator tt0 / querySource（评论 03）

- **隐藏的 Coordinator 模式**：编译标志 `COORDINATOR_MODE` + 环境变量 `CLAUDE_CODE_COORDINATOR_MODE` 双重门控。
- **协调者工具集架构级受限**：仅 `AgentTool` / `SendMessageTool` / `TaskStopTool`，无 fs/exec，强制委派。
- **完全上下文隔离**：Worker 零上下文启动，协调者必须写自包含 prompt（包含路径、行号、错误、完成标准）。
- **XML 通知伪装成 user message**：`<task-notification><task-id>...<status>completed</status><result>...</result></task-notification>` 作为 user 消息回写，LLM 自然识别。
- **Fork vs Fresh**：研究类 fork 父级缓存；验证类 fresh 防止"自我背书"。
- **四阶段工作流**：Research → Synthesis → Implementation → Verification；"不要委托理解"是写进 system prompt 的红线。
- **querySource 贯穿**（评论 01 + 15）：每次 `model.invoke` 带 `source: "main" | "compact" | "microcompact" | "sub-agent:<id>" | ...`；下游重试矩阵据此分类（前台 529 重试、后台 529 放弃），微压缩据此防递归（`compact` 内部不再压缩）。

### 2.3 agent swarms / Task 工具（评论 08）

- **基于文件的邮箱**：`~/.claude/teams/{team}/inboxes/*.json` + 锁文件序列化并发写入。
- **三种后端**：tmux > iTerm2 > 进程内，按检测优先级回退；进程内是 helixent 唯一相关的形态。
- **结构化消息类型**：`idle_notification` / `permission_request` / `permission_response` / `plan_approval_request` / `shutdown_request` / `shutdown_approved` 等带类型控制消息，超越纯文本。
- **agent 身份**：`{name}@{teamName}` 确定性 ID + `parent-session-id` CLI 标志贯穿血统。
- **TaskState 7 变体**：`LocalShellTaskState` / `LocalAgentTaskState` / `RemoteAgentTaskState` / `InProcessTeammateTaskState` / `LocalWorkflowTaskState` / `MonitorMcpTaskState` / `DreamTaskState`，由 `<task-notification>` 注入回主流程。
- **权限委托链**：worker 无 TTY → 通过邮箱发 `permission_request` → leader 弹窗 → 回写 `permission_response`。

---

## 3. 关键代码线索

> 引用编号 = 评论文件 § 章节。

- **`QueryEngine` 双层** —— `01-query-engine.md` §1 §2：`submitMessage()` 生命周期、`processUserInput()`、`getSystemContext()` / `getUserContext()`。
- **`query()` while(true) 主循环** —— `01-query-engine.md` §3：5 级预处理（snip / microcompact / context-collapse / autocompact / tool result budget）。
- **`normalizeMessagesForAPI()`** —— `01-query-engine.md` §10：消息合并、过滤、thinking block 三规则、yield-前-克隆。
- **`withRetry()` 错误恢复** —— `01-query-engine.md` §7：429/529/401/403/ECONNRESET 矩阵、`FallbackTriggeredError`、`UNATTENDED_RETRY`、`max_output_tokens` 三级升级。
- **`addToTotalSessionCost()` / `restoreCostStateForSession()`** —— `01-query-engine.md` §6：按模型分桶 usage、OpenTelemetry 计数器、recover 时 session id 校验防污染。
- **`coordinatorMode.ts:180-192` `<task-notification>` 模板** —— `03-coordinator.md` §3.2。
- **`AgentTool` / `SendMessageTool` / `TaskStopTool`** —— `03-coordinator.md` §2 协调者工具箱。
- **Scratchpad 共享目录** —— `03-coordinator.md` §5：跨 Worker 状态共享、目录内操作免确认。
- **Fork 机制** —— `03-coordinator.md` §6：父级 prompt cache 复用。
- **`spawnMultiAgent.ts`（1094 行）** —— `08-agent-swarms.md` §1：解析模型 → 唯一名称 → 后端检测 → 创建窗格/进程 → CLI 参数传播 → 注册 → 初始消息 → 后台任务注册。
- **`teammateMailbox.ts`（1184 行）** —— `08-agent-swarms.md` §2：JSON 文件 + 锁文件、10 次重试、5–100ms 退避。
- **`TaskState` 联合 7 变体** —— `08-agent-swarms.md` §9。
- **`SendMessageTool` 路由优先级** —— `08-agent-swarms.md` §10：进程内 → 本地代理 → tmux/iterm2 → UDS/Bridge → 广播。
- **`DreamTask` + `priorMtime` 回滚锁** —— `08-agent-swarms.md` §11：自动整理 MEMORY.md。

---

## 4. helixent 现状

### 4.1 主循环（agent.ts）

- 单层 `Agent` 类，**没有"会话级宿主"**：[file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L48-L91](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L48-L91)
- `stream()` 是一个简单 `for (let step = 1; step <= maxSteps; step++)` 循环，跑「`_think → yield assistant → 若无 tool_use 退出 → _act 并行执行 tools → 下一步`」：[file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L140-L171](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L140-L171)
- `_think()` 调 `model.stream()` 并把每个 snapshot 转换为 `progress` 事件：[file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L180-L216](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L180-L216)
- `_act()` 用 `Promise.race` 实现"先完成先 yield"的并行工具执行：[file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L222-L272](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L222-L272)
- `_appendMessage()` 仅 push 到 `messages`，**只增不减**：[file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L274-L276](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L274-L276)
- 错误处理仅一行：`return { ..., result: \`Error: ${message}\` }`，无 retry / 无 fallback：[file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L235-L238](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L235-L238)

### 4.2 事件协议（agent-event.ts）

- 仅两种事件：`message`（一次完整 assistant/tool 消息）和 `progress`（streaming 中间快照），无 `stream_event` / `system` / `tombstone` / `compact` 等子类型：[file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent-event.ts#L1-L45](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent-event.ts#L1-L45)

### 4.3 中间件 8 钩子（agent-middleware.ts）

- 钩子完备：`beforeAgentRun / beforeAgentStep / beforeModel / afterModel / beforeToolUse / afterToolUse / afterAgentStep / afterAgentRun`：[file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent-middleware.ts#L80-L136](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent-middleware.ts#L80-L136)
- 通过 `Object.assign(context, result)` 共享可变上下文，但**`AgentContext` 没有 `session` / `usage` / `parentSessionId` / `querySource` 等会话级字段**。

### 4.4 lead agent 装配（lead-agent.ts）

- 单一 `createCodingAgent` 函数把 cwd / AGENTS.md / 13 工具 / approval / skills / todo 全部硬编码：[file:///Users/bytedance/Documents/Codex/helixent/src/coding/agents/lead-agent.ts#L31-L120](file:///Users/bytedance/Documents/Codex/helixent/src/coding/agents/lead-agent.ts#L31-L120)
- 工具数组手写 13 项，无 sub-agent / delegate_task / send_message：[file:///Users/bytedance/Documents/Codex/helixent/src/coding/agents/lead-agent.ts#L103-L117](file:///Users/bytedance/Documents/Codex/helixent/src/coding/agents/lead-agent.ts#L103-L117)
- 系统 prompt 是字面模板，无 dynamic boundary：[file:///Users/bytedance/Documents/Codex/helixent/src/coding/agents/lead-agent.ts#L80-L101](file:///Users/bytedance/Documents/Codex/helixent/src/coding/agents/lead-agent.ts#L80-L101)

### 4.5 与 Claude 的核心差异速览

| 维度 | Claude Code | helixent |
|---|---|---|
| 主循环结构 | 双层（session + turn） | 单层（仅 turn） |
| 会话宿主对象 | `QueryEngine` 持有 usage / cache / history | 无；只在 `Agent.messages` 数组上累积 |
| AsyncGenerator | 全栈 yield，含 progress / system / tombstone | 仅 `message` / `progress` 两类 |
| 重试矩阵 | 429/529/401/403/ECONNRESET/PTL | 无（裸 throw 走 `Error:` tool_result） |
| max_tokens 三级升级 | 升 64K → 注入恢复消息 → 暴露 | 无 |
| querySource 标签 | 每次 model.invoke 必带 | 无 |
| parentSessionId 血统 | 跨 sub-agent telemetry trace | 无 |
| 协调者模式 | 工具集架构级受限 | 无；coding profile 平等持有所有工具 |
| sub-agent 委派 | `AgentTool` + `<task-notification>` | 无 |
| 消息分发 switch | 5+ 类 | 仅 push 到 `messages` |
| 不可变快照 | `cloneBeforeYield()` | 直接 mutable，依赖调用方约束 |

---

## 5. 差距与借鉴判断

| Claude 机制 | helixent 是否有 | 差距严重度 | 建议落点 |
|---|---|---|---|
| QueryEngine / query() 双层架构 | ❌ 仅单层 Agent | 高 | outline §1.10 AgentSession + Agent 双层 |
| AgentSession 持有跨回合 usage/contextStore/rejection/sourceMap | ❌ | 高 | outline §1.10.1–1.10.4 |
| querySource 元数据贯穿 model.invoke | ❌ | 高 | outline §1.10.2（main / compact / sub-agent / hook 标签） |
| parentSessionId 血统链 | ❌ | 中 | outline §1.10.1（与 telemetry / web /traces 联动） |
| 拒绝熔断器（连续 3 次 / 累计 20 次） | ❌ | 中 | outline §1.11 |
| while(true) + AsyncGenerator + return() 取消 | ✅ 已是 AsyncGenerator | 低 | outline §1.4 装配伪码不动 Agent 内部 |
| 5 级压缩流水线 | ❌ | 高 | outline §4（L0 offload / L1 microcompact / L4 manual /compact） |
| `withRetry()` 矩阵 | ❌ | 高 | outline §B1.6（foundation/models 加 withRetry 包装） |
| `max_output_tokens` 三级升级 | ❌ | 中 | outline §B1.6 / §4.14.11（v3 候选） |
| 流空闲 watchdog 90s | ❌ | 中 | outline §B1.6 |
| 不可变快照 + yield 前克隆 | ❌（直接 mutable） | 中 | 与 §1.10 配合在 ContextStore 落地 |
| 消息 normalize（thinking block 三规则） | ❌ | 中 | foundation/messages 后续补强（v3 候选） |
| Coordinator 工具集架构级受限 | ❌ | 中 | outline §6 / §B6.1 派生 `coordinatorProfile` |
| Worker 零上下文（fresh）vs Fork | ❌ | 中 | outline §6 / §B6.2 `delegate_task({ mode: "fresh" \| "fork" })` |
| `<task-notification>` XML user message | ❌ | 低 | outline §6 / §B6.3 |
| 4 阶段工作流（Research/Synthesis/Implementation/Verification） | ❌ | 低 | outline §B6.7（v3 候选） |
| Scratchpad 共享目录 | ❌ | 低 | outline §B6.6（v3 候选） |
| 邮箱 + 锁文件 IPC | ❌（仅进程内） | 低 | 不采纳（违反 helixent 进程内 MVP 定位） |
| TaskState 7 变体 | ❌ | 低 | v3 候选；MVP 仅 InProcessTeammateTaskState |
| 结构化控制消息（shutdown_request / permission_request） | ❌ | 低 | outline §B6.5（MVP 仅文本，控制消息留 v3） |
| DreamTask + priorMtime 回滚锁 | ❌ | 低 | v3 候选（L2 SessionMemory 时考虑） |
| Cost tracker 按模型分桶 + session 恢复 | ❌（仅 `usage` per message） | 中 | outline §1.10.1 AgentSession.usage Map |

---

## 6. 与 outline 章节关联

- **§1 背景与五道结构性门槛**：第 1 / 5 / 6 道门槛（agent 装配硬编码、单 agent 单线程、跨回合状态无宿主）正是本主题的对照面。
- **§1.10 AgentSession + querySource**（核心借鉴点）：
  - §1.10.1 数据结构 ← `01-query-engine.md` 双层架构
  - §1.10.2 querySource 贯穿规则 ← `01-query-engine.md` §3 + `15-services-api` 前台/后台重试矩阵
  - §1.10.3 装配落点（CLI/Web 启动从 `new Agent` 改为 `createAgentFromProfile → createAgentSession`）
  - §1.10.4 兼容承诺（Agent 类零侵入，session 是外部宿主）
- **§1.11 拒绝熔断器** ← `07-permission-pipeline.md` 拒绝循环安全网（与 query loop 主循环改动绑定）。
- **§1.12 借鉴点速览 B1.6 / B1.7 / B1.8** ← `01-query-engine.md` 重试矩阵 + `15-services-api.md` 粘性锁存 + `17-telemetry.md` parentSessionId trace。
- **§4 Offload & Compact**：`01-query-engine.md` §3 预处理流水线 + `11-compact-system.md` 5 层 pipeline 是其直接来源（本笔记不展开，详见 03 篇主题笔记）。
- **§6 Sub-agent 委派**：
  - §B6.1 `coordinatorProfile` 工具集受限 ← `03-coordinator.md` §2
  - §B6.2 `delegate_task({ mode })` ← `03-coordinator.md` §6
  - §B6.3 `<task-notification>` ← `03-coordinator.md` §3.2 + `08-agent-swarms.md` §9
  - §B6.4 `parentSessionId` 与 §1.10 共享
  - §B6.5 结构化控制消息 ← `08-agent-swarms.md` §10
  - §B6.6 Scratchpad ← `03-coordinator.md` §5（v3）
  - §B6.7 四阶段工作流 ← `03-coordinator.md` §4 + `08-agent-swarms.md` §8（v3）
- **§7 风险评估**：本主题没有直接 Risk-H 项；但 §1.10 落地时需要确认 `Agent` 类零侵入承诺（与 Risk-L1 并列保护测试基线）。

---

## 7. 对 helixent 二期的具体启示

- `[已纳入 §1.10]` **AgentSession 双层宿主落地**：参考 `01-query-engine.md` §1 双层架构，新增 `src/agent/session/` 承载 `usage` / `contextStore` / `rejection` / `compactInProgress`，CLI/Web 启动从"裸 `new Agent`"切换到"`createAgentFromProfile → createAgentSession`"，**`Agent` 类内部状态零侵入**。
- `[已纳入 §1.10.2]` **querySource 元数据贯穿 `model.invoke`**：参考 `03-coordinator.md` §3.2 + `15-services-api.md` 重试白名单，所有调用方（主循环、`compactConversation`、未来 sub-agent / hook agent）必须显式传 `source`；下游 microcompact / autocompact / 重试矩阵据此防递归并区分前后台 529 行为。
- `[已纳入 §1.11]` **拒绝熔断器进入主循环**：参考 `07-permission-pipeline.md` 的拒绝循环安全网，在 `agent.ts:stream()` 每步开头检查 `session?.rejection.tripped`，连续 3 次 / 累计 20 次拒绝后优雅退出，防止模型反复试探被拒工具浪费 token；`session` 不存在时短路保持 v0 行为。
- `[已纳入 §6 / §B6.1-B6.4]` **sub-agent MVP 走 `delegate_task` + `<task-notification>` 协议**：参考 `03-coordinator.md` §3.2 与 `08-agent-swarms.md` §9，仅启用进程内后端、默认 `mode: "fresh"` 零上下文、用 user-role tool_result 包 XML 回写、单层委派；coordinator profile 必须**架构级受限**到只装 `agent-orchestration` toolkit。
- `[v3 候选]` **`withRetry()` 重试矩阵 + 流空闲 watchdog**：参考 `01-query-engine.md` §7 + §8，二期可在 `foundation/models` 包一层 AsyncGenerator 重试管道（429/529/401/PTL/ECONNRESET），`max_output_tokens` 三级升级与 90s watchdog 留 v3，与 `querySource` 重试白名单联动。
- `[v3 候选]` **TaskState 联合 + 结构化控制消息**：参考 `08-agent-swarms.md` §9 §10，MVP 只实现 `InProcessTeammateTaskState`；`shutdown_request` / `permission_request` / `plan_approval_request` 等带类型控制消息留 v3，避免过早抽象。
- `[v3 候选]` **`<analysis>` 草稿本 + PostCompact Recovery + DreamTask**：参考 `01-query-engine.md` §3 与 `08-agent-swarms.md` §11，与 outline §4.14.5 / §4.14.7 同步推进；DreamTask + `priorMtime` 回滚锁等到 L2 SessionMemory 阶段再考虑。
- `[v3 候选]` **协调者四阶段工作流模板**：参考 `03-coordinator.md` §4 与 `08-agent-swarms.md` §8，作为推荐 system prompt 而非硬约束，避免锁死用户工作流；与 §B6.7 / §B6.8 "不要委托理解"原则配套。
