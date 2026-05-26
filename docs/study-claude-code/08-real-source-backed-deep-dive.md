# 08 · Claude Code 真实源码配套深读

## 0. 源码来源

本篇基于用户提供的源码分析仓库：

- 本地路径：`/Users/bytedance/Documents/Codex/claude-code-analysis`
- 源码目录：`/Users/bytedance/Documents/Codex/claude-code-analysis/src`
- GitHub：`https://github.com/liuup/claude-code-analysis/tree/main/src`

与 `01`–`07` 不同，本篇直接引用 `src` 下真实文件和行号，把 Claude Code 的关键机制拆成：会话引擎、query loop、工具系统、权限系统、Bash 引擎、compact/session、UI/bridge/swarm/MCP，以及对 helixent 的迁移优先级。

## 1. QueryEngine 与 Query Loop

### 1.1 真实源码坐标

| 文件 | 关键位置 | 作用 |
|---|---:|---|
| [QueryEngine.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/QueryEngine.ts#L184-L207) | L184-L207 | 会话级持久状态：`mutableMessages`、`abortController`、`permissionDenials`、`totalUsage`、`readFileState` 等 |
| [QueryEngine.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/QueryEngine.ts#L209-L1156) | L209-L1156 | `submitMessage()` 会话编排核心 |
| [QueryEngine.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/QueryEngine.ts#L1186-L1295) | L1186-L1295 | `ask()` SDK/headless 便捷入口，创建 `QueryEngine` 并 `yield* engine.submitMessage()` |
| [query.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/query.ts#L203-L217) | L203-L217 | `queryLoop` 状态对象 |
| [query.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/query.ts#L241-L1729) | L241-L1729 | 真正 ReAct 主循环 |
| [claude.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/services/api/claude.ts#L1017-L2892) | L1017-L2892 | `queryModel()` API 层核心 |
| [withRetry.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/services/api/withRetry.ts#L170-L517) | L170-L517 | `withRetry()` 异步生成器重试状态机 |
| [messages.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/utils/messages.ts#L1989-L2238) | L1989-L2238 | `normalizeMessagesForAPI()` |
| [messages.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/utils/messages.ts#L5133-L5252) | L5133-L5252 | `ensureToolResultPairing()` |

### 1.2 核心调用链

```text
ask()
  -> new QueryEngine(config)
  -> engine.submitMessage()
       -> processUserInput()
       -> 构造 system prompt / context / permission wrapper
       -> query()
            -> queryLoop()
                 -> compact / token budget / context projection
                 -> deps.callModel()
                      -> queryModelWithStreaming()
                      -> queryModel()
                      -> withRetry()
                 -> 收 assistant/tool_use
                 -> run tools
                 -> 追加 user tool_result
                 -> 若有 tool_use 继续下一轮
```

### 1.3 学到的关键点

- `QueryEngine` 与 `queryLoop` 是明确分层：前者是 session 级宿主，后者是 turn/loop 级执行器。
- `QueryEngine.submitMessage()` 不是简单把用户消息塞给模型，它同时做输入处理、权限包装、持久化、usage 累计、SDK 输出转换、结构化输出、最大轮数处理。
- `queryLoop` 显式维护 `autoCompactTracking`、`maxOutputTokensRecoveryCount`、`hasAttemptedReactiveCompact`、`pendingToolUseSummary`、`stopHookActive`、`transition` 等状态，避免状态散落到 UI 或 provider。
- `withRetry()` 是 `AsyncGenerator`，重试过程能 yield `api_error` 等 UI 可见状态，不是 provider 内部静默 retry。
- `normalizeMessagesForAPI()` 与 `ensureToolResultPairing()` 是稳定性核心；API 前必须修复/保证 `tool_use` / `tool_result` 配对，否则复杂 compact/fallback 下很容易 400。

### 1.4 对 helixent 的直接启发

- helixent 的 [Agent](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts) 应拆出 `AgentSession`，否则 compact、usage、querySource、permission denial、readFileState 都会无处安放。
- `ModelProvider.stream()` 外应有统一 `withRetry()` 包装层，且 retry event 应能流到 TUI/Web trace。
- `foundation/messages` 需要增加 API 前 normalization / pairing guard，而不是默认相信内部 messages 永远合法。

## 2. Tool 抽象、工具池与执行语义

### 2.1 真实源码坐标

| 文件 | 关键位置 | 作用 |
|---|---:|---|
| [Tool.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/Tool.ts#L123-L138) | L123-L138 | `ToolPermissionContext` |
| [Tool.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/Tool.ts#L158-L300) | L158-L300 | `ToolUseContext` |
| [Tool.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/Tool.ts#L321-L336) | L321-L336 | `ToolResult<T>` |
| [Tool.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/Tool.ts#L362-L695) | L362-L695 | `Tool<Input, Output, P>` 大接口 |
| [Tool.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/Tool.ts#L743-L792) | L743-L792 | `buildTool()` 默认值 |
| [tools.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/tools.ts#L193-L250) | L193-L250 | `getAllBaseTools()` / `getTools()` |
| [tools.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/tools.ts#L345-L367) | L345-L367 | `assembleToolPool()` 稳定排序与去重 |
| [queryHelpers.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/utils/queryHelpers.ts#L102-L222) | L102-L222 | SDK/消息辅助与 progress 节流 |

### 2.2 Tool 接口真正包含什么

Claude Code 的 `Tool` 不是 `name + schema + invoke`，而是完整运行时契约：

- identity：名称、描述、prompt、schema。
- validation：`validateInput`。
- permission：`checkPermissions`、`isReadOnly`、`isConcurrencySafe`、`isDestructive`。
- execution：`call`。
- rendering：CLI/TUI UI、结果摘要。
- context：`ToolUseContext`、`contextModifier`。
- result：`ToolResult<T>` 可携带 data、messages、metadata、上下文修改器。

`buildTool()` 的默认值偏 fail-closed：未声明并发安全、只读、安全分类时，默认走保守路径。

### 2.3 `assembleToolPool()` 的关键价值

`assembleToolPool()` 做三件事：

- 内置工具稳定排序。
- MCP 工具稳定排序并拼到后缀。
- 用 `uniqBy` 去重。

这不是审美问题，而是 prompt cache 经济性：工具 schema 顺序抖动会导致大块 prompt cache 失效。

### 2.4 对 helixent 的迁移点

- `defineTool()` 应扩展为接近 Claude 的工具契约：`capabilities`、`summarize`、`resultPolicy`、`requiresUserInteraction`、`isReadOnly(input)`。
- `Toolkit` 装配时必须稳定排序，尤其 MCP 工具要在内置工具后缀，避免每次 server 增减工具击穿内置工具缓存。
- helixent 的 [function-tool.ts](file:///Users/bytedance/Documents/Codex/helixent/src/foundation/tools/function-tool.ts) 可以先做“小 Tool 接口”，不必一次复制 30+ 方法。

## 3. Permission Pipeline 与 Bash 引擎

### 3.1 权限源码坐标

| 文件 | 关键位置 | 作用 |
|---|---:|---|
| [permissions.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/utils/permissions/permissions.ts#L473-L956) | L473-L956 | `hasPermissionsToUseTool()` 外层：模式转换、auto/headless |
| [permissions.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/utils/permissions/permissions.ts#L1158-L1319) | L1158-L1319 | `hasPermissionsToUseToolInner()` 有序短路链 |
| [PermissionRule.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/utils/permissions/PermissionRule.ts#L29-L39) | L29-L39 | `PermissionRuleValue` |
| [shellRuleMatching.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/utils/permissions/shellRuleMatching.ts#L90-L184) | L90-L184 | shell exact/prefix/wildcard 规则 |
| [yoloClassifier.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/utils/permissions/yoloClassifier.ts#L364-L364) | L364 | auto 模式 classifier 工具 lookup |

### 3.2 权限短路链

```text
hasPermissionsToUseTool()
  -> hasPermissionsToUseToolInner()
       -> 整工具 deny
       -> 整工具 ask
       -> tool.checkPermissions()
       -> 工具实现 deny
       -> requiresUserInteraction
       -> 内容级 ask
       -> safetyCheck
       -> bypassPermissions
       -> 整工具 allow
       -> passthrough/ask
  -> dontAsk / auto / headless fallback
```

关键结论：

- `bypassPermissions` 不是跳过所有安全检查，安全护栏仍优先。
- headless/异步 agent 不能弹窗时，先走 `PermissionRequest` hook；无 hook 决策则 auto-deny。
- `auto` 模式先走 `acceptEdits` 快路径和 allowlist，再走 YOLO classifier。

### 3.3 Bash 源码坐标

| 文件 | 关键位置 | 作用 |
|---|---:|---|
| [BashTool.tsx](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/tools/BashTool/BashTool.tsx#L227-L259) | L227-L259 | Bash input schema |
| [BashTool.tsx](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/tools/BashTool/BashTool.tsx#L420-L825) | L420-L825 | Bash `buildTool()` 定义 |
| [BashTool.tsx](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/tools/BashTool/BashTool.tsx#L826-L1143) | L826-L1143 | `runShellCommand()` 状态机 |
| [bashPermissions.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/tools/BashTool/bashPermissions.ts#L1663-L1827) | L1663-L1827 | `bashToolHasPermission()` AST/legacy 双路径 |
| [bashPermissions.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/tools/BashTool/bashPermissions.ts#L1845-L2557) | L1845-L2557 | Bash 主权限流程 |
| [readOnlyValidation.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/tools/BashTool/readOnlyValidation.ts#L1876-L1990) | L1876-L1990 | `checkReadOnlyConstraints()` |
| [Shell.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/utils/Shell.ts#L181-L442) | L181-L442 | `exec()` spawn / sandbox / task output |
| [ShellCommand.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/utils/ShellCommand.ts#L32-L47) | L32-L47 | `ShellCommand.status` |
| [ShellCommand.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/utils/ShellCommand.ts#L114-L382) | L114-L382 | `ShellCommandImpl` lifecycle |

### 3.4 Bash 状态机

```text
BashTool.call()
  -> runShellCommand()
       -> Shell.exec()
       -> 2s 初始阈值
       -> 若完成：return result
       -> TaskOutput 轮询
       -> yield progress
       -> timeout / explicit background / assistant 15s background / user background
       -> completed | backgrounded | killed
```

`ShellCommand.status` 明确为：

- `running`
- `backgrounded`
- `completed`
- `killed`

后台任务还有输出大小 watchdog，避免命令写满磁盘。

### 3.5 对 helixent 的迁移点

- 权限链先迁结构，不迁 YOLO classifier。
- Bash 先迁 lifecycle：`ShellCommand` 包装、timeout、abort、background、progress、output watchdog。
- Bash 安全规则不要一次性复制 2000 行；优先迁 exact/prefix/wildcard、deny 优先、compound command 不被宽泛 allow 放行。

## 4. Compact / Context / Session

### 4.1 Compact 源码坐标

| 文件 | 关键位置 | 作用 |
|---|---:|---|
| [autoCompact.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/services/compact/autoCompact.ts#L33-L145) | L33-L145 | token 阈值 / warning state |
| [autoCompact.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/services/compact/autoCompact.ts#L160-L239) | L160-L239 | `shouldAutoCompact()` 递归/冲突来源排除 |
| [autoCompact.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/services/compact/autoCompact.ts#L241-L350) | L241-L350 | `autoCompactIfNeeded()` |
| [compact.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/services/compact/compact.ts#L325-L338) | L325-L338 | `buildPostCompactMessages()` |
| [compact.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/services/compact/compact.ts#L387-L763) | L387-L763 | `compactConversation()` |
| [compact.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/services/compact/compact.ts#L1136-L1396) | L1136-L1396 | `streamCompactSummary()` |
| [microCompact.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/services/compact/microCompact.ts#L253-L293) | L253-L293 | `microcompactMessages()` |
| [microCompact.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/services/compact/microCompact.ts#L422-L530) | L422-L530 | time-based microcompact |
| [apiMicrocompact.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/services/compact/apiMicrocompact.ts#L63-L153) | L63-L153 | API native context edits |

### 4.2 Compact 调用链

```text
queryLoop before API
  -> microcompactMessages()
       -> time-based microcompact
       -> cached microcompact / cache_edits
  -> autoCompactIfNeeded()
       -> shouldAutoCompact()
       -> trySessionMemoryCompaction()
       -> compactConversation()
            -> PreCompact hooks
            -> streamCompactSummary()
            -> clear readFileState
            -> post-compact attachments
            -> SessionStart hook
            -> compact boundary
            -> PostCompact hook
            -> buildPostCompactMessages()
```

关键机制：

- `shouldAutoCompact()` 会排除 `session_memory`、`compact`、`context-collapse` 等来源，防递归 compact。
- `AutoCompactTrackingState` 有 `consecutiveFailures`，连续 3 次失败后 circuit break。
- `compactConversation()` 不只是总结，还负责 hooks、readFileState 清理、attachments 恢复、boundary 写入。
- `streamCompactSummary()` 优先 forked agent 共享 prompt cache，失败回退普通 `queryModelWithStreaming()`。

### 4.3 Context 源码坐标

| 文件 | 关键位置 | 作用 |
|---|---:|---|
| [attachments.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/utils/attachments.ts#L743-L1003) | L743-L1003 | `getAttachments()` |
| [attachments.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/utils/attachments.ts#L1777-L1862) | L1777-L1862 | nested memory attachments |
| [attachments.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/utils/attachments.ts#L2334-L2424) | L2334-L2424 | relevant memory prefetch |
| [attachments.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/utils/attachments.ts#L3020-L3199) | L3020-L3199 | compact file reference / post-compact file attachments |
| [claudemd.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/utils/claudemd.ts#L790-L1075) | L790-L1075 | `getMemoryFiles()` |
| [claudemd.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/utils/claudemd.ts#L1088-L1130) | L1088-L1130 | memory cache reset / hook reason |

### 4.4 Session 源码坐标

| 文件 | 关键位置 | 作用 |
|---|---:|---|
| [sessionStorage.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/utils/sessionStorage.ts#L198-L257) | L198-L257 | 主 session / subagent session 路径 |
| [sessionStorage.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/utils/sessionStorage.ts#L1391-L1449) | L1391-L1449 | `recordTranscript()` 去重与链写入 |
| [sessionStorage.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/utils/sessionStorage.ts#L1823-L1919) | L1823-L1919 | compact preservedSegment 重链 |
| [sessionStorage.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/utils/sessionStorage.ts#L3480-L3659) | L3480-L3659 | session load / compact boundary 恢复 |
| [sessionStoragePortable.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/utils/sessionStoragePortable.ts#L284-L466) | L284-L466 | portable path resolve |
| [sessionStoragePortable.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/utils/sessionStoragePortable.ts#L717-L793) | L717-L793 | 大 JSONL chunk scan |
| [toolResultStorage.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/utils/toolResultStorage.ts#L390-L412) | L390-L412 | `ContentReplacementState` |
| [toolResultStorage.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/utils/toolResultStorage.ts#L960-L988) | L960-L988 | resume 后恢复 replacement state |

### 4.5 对 helixent 的迁移点

- Compact 不能只做“总结 prompt”，必须包括 boundary、PostCompact Recovery、API pairing 不变量、递归防护、失败熔断。
- append-only JSONL + compact boundary 是 resume/fork 的基础，可先预留 schema，不必二期全做。
- `ContentReplacementState` 的“第一次替换冻结、resume 恢复精确文本”对 prompt cache 很关键，适合未来工具大结果 offload。

## 5. UI / Bridge / Swarm / MCP

### 5.1 UI 源码坐标

| 文件 | 关键位置 | 作用 |
|---|---:|---|
| [AppStateStore.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/state/AppStateStore.ts#L89-L184) | L89-L184 | 全局 `AppState` |
| [AppState.tsx](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/state/AppState.tsx#L37-L71) | L37-L71 | `AppStateProvider` / hooks |
| [screen.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/ink/screen.ts#L356-L415) | L356-L415 | packed terminal `Screen` |
| [screen.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/ink/screen.ts#L289-L300) | L289-L300 | `CellWidth` |
| [reconciler.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/ink/reconciler.ts#L110-L143) | L110-L143 | props apply |
| [reconciler.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/ink/reconciler.ts#L224-L227) | L224-L227 | custom React host reconciler |

### 5.2 Bridge 源码坐标

| 文件 | 关键位置 | 作用 |
|---|---:|---|
| [types.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/bridge/types.ts#L81-L115) | L81-L115 | `BridgeConfig` |
| [types.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/bridge/types.ts#L178-L190) | L178-L190 | `SessionHandle` |
| [replBridge.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/bridge/replBridge.ts#L70-L83) | L70-L83 | `ReplBridgeHandle` / `BridgeState` |
| [remoteBridgeCore.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/bridge/remoteBridgeCore.ts#L166-L256) | L166-L256 | env-less/v2 bridge init |
| [remoteBridgeCore.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/bridge/remoteBridgeCore.ts#L278-L280) | L278-L280 | `FlushGate` |

### 5.3 Swarm / Task 源码坐标

| 文件 | 关键位置 | 作用 |
|---|---:|---|
| [tasks/types.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/tasks/types.ts#L12-L19) | L12-L19 | `TaskState` union |
| [tasks/types.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/tasks/types.ts#L37-L46) | L37-L46 | `isBackgroundTask()` |
| [spawnInProcess.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/utils/swarm/spawnInProcess.ts#L59-L90) | L59-L90 | in-process spawn config/output |
| [spawnInProcess.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/utils/swarm/spawnInProcess.ts#L104-L204) | L104-L204 | `spawnInProcessTeammate()` |
| [inProcessRunner.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/utils/swarm/inProcessRunner.ts#L471-L514) | L471-L514 | runner config/result |
| [inProcessRunner.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/utils/swarm/inProcessRunner.ts#L543-L604) | L543-L604 | mailbox / task claim |

### 5.4 MCP 源码坐标

| 文件 | 关键位置 | 作用 |
|---|---:|---|
| [types.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/services/mcp/types.ts#L124-L161) | L124-L161 | `McpServerConfig` union |
| [types.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/services/mcp/types.ts#L180-L227) | L180-L227 | `MCPServerConnection` union |
| [types.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/services/mcp/types.ts#L252-L258) | L252-L258 | `MCPCliState` |
| [MCPConnectionManager.tsx](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/services/mcp/MCPConnectionManager.tsx#L31-L48) | L31-L48 | reconnect/toggle context |
| [client.ts](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/services/mcp/client.ts#L595-L607) | L595-L607 | `connectToServer()` transport factory |

### 5.5 对 helixent 的迁移点

- UI store 可学 `createStore + selector`，但不要急着迁 custom Ink reconciler。
- Bridge 暂不进二期，但 `FlushGate` 和 transport 注入思想可用于 Web/TUI trace 同步。
- Swarm 二期若做 sub-agent，优先学 `spawnInProcessTeammate + AbortController + TaskState`，不要先碰 tmux/iTerm2。
- MCP 的 `MCPServerConnection` union、transport factory、tool wrapping、elicitation retry 很适合作为 helixent MCP MVP 参考。

## 6. 迁移优先级

| 优先级 | 从真实源码确认的机制 | helixent 建议落点 |
|---|---|---|
| P0 | `QueryEngine` session 状态与 `queryLoop` 分层 | `AgentSession` / `createAgentSession()` |
| P0 | `querySource` + 529 后台不重试 | provider request context / trace |
| P0 | `Tool` 元数据与 `buildTool()` fail-closed 默认值 | `defineTool` 扩展 |
| P0 | `hasPermissionsToUseToolInner()` 有序权限链 | approval middleware 重构 |
| P0 | denial circuit | approval deny tracking + agent step guard |
| P1 | `withRetry()` AsyncGenerator | foundation/models retry wrapper |
| P1 | `normalizeMessagesForAPI()` / pairing guard | foundation/messages |
| P1 | `assembleToolPool()` 稳定排序 | Toolkit/MCP 装配 |
| P1 | Bash `ShellCommand` lifecycle | coding bash tool v2 |
| P1 | compact boundary + PostCompact Recovery | compact MVP |
| P2 | append-only session JSONL | resume/fork v3 |
| P2 | in-process swarm teammate | sub-agent v2.5/v3 |
| P2 | MCP connection union + transport factory | MCP MVP |
| P3 | bridge remote control | 暂不做 |
| P3 | custom Ink renderer | 暂不做 |

## 7. 修正后的结论

这次配套 `claude-code-analysis/src` 后，可以把之前“评论级判断”修正为“源码 backed 判断”：

- 二期最先做的不是 MCP，也不是 Web UI，而是 `AgentSession + Tool contract + Permission pipeline + Retry/Compact safety`。
- Claude Code 的工程复杂度主要来自长会话和高风险工具的安全网：message pairing、compact boundary、readFileState、permission chain、Bash lifecycle、retry event。
- helixent 可以借鉴结构，不应该全量复制实现：尤其 Bash 安全、custom Ink、bridge、telemetry 这些是长期复杂系统，不能塞进二期 MVP。
- MCP 接入要参考源码里的 connection union、transport factory、tool wrapping、elicitation，而不是只做“spawn server + tools/list”。
