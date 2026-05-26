# 02 · 工具系统、Bash 引擎与权限流水线

> 对照阅读：
> - `claude-reviews-claude/architecture/zh-CN/02-tool-system.md`
> - `claude-reviews-claude/architecture/zh-CN/06-bash-engine.md`
> - `claude-reviews-claude/architecture/zh-CN/07-permission-pipeline.md`
>
> 关联 outline：`generalize-agent-platform-outline.md` §2（Toolkit 配置体系）、§2.8（tool/permission 借鉴清单）、§1.11（拒绝熔断器）。
>
> 本笔记只做学习与对照，不修改任何业务代码。

---

## 1. 概述

Claude Code 把"工具"、"Bash 执行"、"权限决策"做成了三段强解耦但同源的子系统：

- **工具系统（`02-tool-system.md`）**：793 行的 `Tool<Input,Output,Progress>` 接口 + 42+ 个自包含工具目录 + `buildTool()` 失败即关闭工厂 + 装配期分区排序保 prompt cache 稳定 + 13 步执行流水线 + 大结果落盘。
- **Bash 引擎（`06-bash-engine.md`）**：~580KB 的 BashTool 子目录 + 持久会话快照 + 文件模式 stdout/stderr 合一 + AsyncGenerator 进度 + 三条后台化路径 + macOS seatbelt / Linux bubblewrap 双沙箱后端 + 设置文件无条件保护。
- **权限流水线（`07-permission-pipeline.md`）**：7 步评估（其中 1d–1g 为绕过免疫硬护栏）+ 6 种权限模式 + 7 个规则来源 + YOLO 两阶段 XML 分类器 + **拒绝熔断器（连续 3 次 / 单会话总计 20 次）** + OAuth/Settings/Keychain 一整套支撑。

helixent 当前在这三块上**只有最薄的雏形**：foundation 仅 `FunctionTool { name, description, parameters, invoke }`；coding 层 13 个工具直接 `defineTool`；bash 是一次性 `Bun.spawn`（无持久会话、无沙箱、无快照）；权限只有"工具名硬编码白名单 + askUser 弹窗"一道闸。借鉴空间集中在 outline §2 / §2.8 / §1.11 已经登记的条目上，但**有些 Claude Code 的复杂度（OS 沙箱、YOLO 分类器）属于"读得到、不抄"**。

---

## 2. Claude 做法

### 2.1 Tool System（02-tool-system.md）

1. **统一 `Tool` 接口**：793 行涵盖 identity / schema / call / permission / 行为标志 / UI 渲染。`buildTool()` 工厂为危险位提供"失败即关闭"默认（`isConcurrencySafe=false`、`isReadOnly=false`），开发者忘了声明就走最严档。
2. **行为标志优于继承**：`isReadOnly(input)` 接受 input 动态判断（如 `BashTool` 看命令 `ls` vs `rm` 决定是否只读）。
3. **assembleToolPool 分区排序**：内置工具按 name 排序作前缀，MCP 工具排序作后缀。一颗 MCP 工具插错位置就能让 prompt cache 全失效，把 $0.003 缓存命中变成 $0.036 全价调用。拒绝规则在送给模型之前就过滤掉，不到 canUseTool 才拦。
4. **ToolSearch 延迟加载**：MCP 工具数过多时，`shouldDefer` 工具发送 `defer_loading: true`，模型只看到名字不看到 schema；`alwaysLoad` 始终强制；`searchHint` 提供关键词；模型直接调用未加载工具时注入"先调 ToolSearchTool"提示。
5. **contextModifier**：工具可返回函数转换后续 `ToolUseContext`（如 `cd` 改 cwd），但**仅当 `isConcurrencySafe=false` 时生效**——并发工具改 ctx 会产生竞态。
6. **执行流水线 13 步**：lookup → abort 检查 → zod schema 校验 → tool.validateInput → BashTool 投机分类器 → PreToolUse hooks → canUseTool → tool.call → PostToolUse hooks → mapResult → processToolResult（大结果落盘）→ 应用 contextModifier → 注入 newMessages。
7. **大结果落盘**：每个工具自带 `maxResultSizeChars`（BashTool 30K / FileEditTool 100K / FileReadTool ∞ 自管），超限写磁盘 + 返回预览 + 路径 ref，模型用 FileReadTool 取回。
8. **FileStateCache 三工具共享**：Read/Edit/Write 共享按绝对路径键的 readFileState Map，在 Edit 前比较 mtime + 内容防止覆盖用户的外部编辑。

### 2.2 Bash Engine（06-bash-engine.md）

1. **入口 schema 严控**：`description / command / timeout / run_in_background / dangerouslyDisableSandbox` + 隐藏字段 `_simulatedSedEdit`。隐藏字段对模型不可见，仅用户在权限对话框批准后内部注入——防"无害命令搭配文件写入"绕过权限。
2. **runShellCommand AsyncGenerator**：`yield` 每秒进度，`return` 最终 ExecResult，调用方用 `Promise.race([resultPromise, progress])` 单 await 同时处理两路。
3. **三条后台化路径**：显式 `run_in_background:true` / 命令超时 / 助手模式 15 秒预算；`sleep` 命令禁止自动后台化。
4. **Shell 发现严选**：`CLAUDE_CODE_SHELL` → `$SHELL` → `which zsh/bash`，**只支持 bash / zsh**。
5. **stdout/stderr 合一文件模式**：`spawn(shell, args, { stdio: ['pipe', fd, fd] })`，POSIX 用 `O_APPEND` 保证写入原子；Windows 用 `'w'` 因 MSYS2 静默丢弃；`O_NOFOLLOW` 防符号链接攻击。
6. **CWD 持久化**：每条命令尾追加 `pwd -P >| /tmp/claude-XXXX-cwd`，子进程退出后同步 readFileSync 更新；NFC 规范化处理 macOS APFS NFD。
7. **Shell 快照**：首次命令前 `createAndSaveSnapshot()` 把 PATH/alias/function 落盘，之后命令 `source` 此快照避免每次跑完整 login shell。命令前禁 ExtGlob、`eval '<command>'` 包装让 alias 第二次解析时展开。
8. **大小看门狗**：后台任务直接写 fd（无 JS 介入），曾因循环追加填满 768GB 磁盘——现每 5s 轮询 size，超限 SIGKILL 整个进程树；用 `'exit'` 而非 `'close'` 检测子进程结束（避免被孙进程 fd 拖住）。
9. **OS 沙箱**：macOS 用 `sandbox-exec` (seatbelt)；Linux 用 `bubblewrap` + seccomp（命名空间隔离，不支持 glob）；WSL2 行 / WSL1 + Windows 不支持。**沙箱无条件拒绝写 settings.json**，并通过命令前后清扫防"裸 git 仓库"逃逸（在沙箱内植 `HEAD`/`config` 让外部 git 误认为仓库根，借 `core.fsmonitor` 逃逸）。
10. **零 token 侧信道**：`<claude-code-hint />` 标签写到 stderr，扫描后剥离再传给模型——传递元数据但不污染上下文。

### 2.3 Permission Pipeline（07-permission-pipeline.md）

1. **七步评估，严格有序**（`hasPermissionsToUseToolInner`）：
   - 1a 工具级 deny → 1b 工具级 ask → 1c 工具内容级 checkPermissions → **1d 工具实现拒绝 / 1e requiresUserInteraction / 1f 内容级 ask / 1g 安全护栏**（这四档**绕过免疫**，bypassPermissions 也照拦）→ 2a bypassPermissions → 2b 始终允许（支持 MCP 服务器级匹配）→ 3 默认 ask。
   - 1g 安全护栏覆盖 `.git/`、`.claude/`、`.vscode/`、shell 配置文件等"碰不得"路径。
2. **6 种权限模式**：`default / plan / acceptEdits / bypassPermissions / dontAsk / auto`。`acceptEdits` 仅文件编辑工具放行；`bypassPermissions` 仍触发 1d-1g；`dontAsk` 静默拒绝；`auto` 走 YOLO 分类器。`transitionPermissionMode()` 集中处理副作用（进入/离开 auto 模式时**剥离/恢复**危险权限规则如 `Bash(*)`）。
3. **7 个规则源**：`userSettings / projectSettings / localSettings / policySettings / flagSettings / cliArg / session`，按层级合并；`policySettings`（企业 MDM）**无法被低优先级覆盖**。
4. **规则格式**：`ToolName` / `ToolName(content)` / `Bash(npm test:*)` / `mcp__server1` / `Agent(Explore)`。
5. **YOLO 分类器（auto 模式）**三级快速路径：
   - L1 acceptEdits 快速路径（AgentTool/REPLTool 排除）
   - L2 安全工具白名单
   - L3 两阶段 XML 分类器：阶段 1 max_tokens=64 立即给 yes/no；阶段 2 仅在阻止时跑思维链。**分类器只看 tool_use 区块、剥离 assistant 文本**——防模型用诱导文本影响分类器。`tengu_iron_gate_closed` 标志控制 API 失败时关闭 vs 开放。
6. **拒绝熔断器（denialTracking.ts）**：
   ```
   DENIAL_LIMITS = { maxConsecutive: 3, maxTotal: 20 }
   ```
   超限时：交互模式回退到用户提示；无头模式抛 `AbortError` 终止会话。
7. **无头代理**：先跑 PermissionRequest hook 给决策机会，无 hook 决策→自动拒绝（hook 可 allow/deny/interrupt）。
8. **沙箱集成**：`autoAllowBashIfSandboxed` 启用时，沙箱化命令跳过 ask 规则，由 OS 内核兜底。
9. **OAuth 2.0 PKCE**：access token ~1h 过期；refresh 提前 5 分钟调度，generation counter 防过期刷新竞态，最多 3 次重试。
10. **Keychain stale-while-error**：`security` CLI 失败时继续用缓存数据；4096 字节 stdin 限制是未文档化坑（超限静默截断 → 凭证损坏）。

---

## 3. 关键代码线索

### 3.1 Tool System
- `Tool.ts`（793 行）：30+ 方法接口；`buildTool()` 失败即关闭默认。
- `tools.ts`：`getAllBaseTools()` 静态注册；`assembleToolPool(permissionContext, mcpTools)`（src/tools.ts:345-367）分区排序。
- `Tool.ts:321-336` `contextModifier` + 并发互斥。
- `services/tools/toolExecution.ts:337-490, 599-800+` `runToolUse` AsyncGenerator。
- `services/tools/toolExecution.ts:578-597` 延迟工具 schema 未发送时注入提示。
- `utils/toolResultStorage.ts` 大结果落盘。
- `tools/FileReadTool/FileReadTool.ts:337-718`（1184 行）六种输出类型 + file_unchanged 去重。
- `tools/FileEditTool/FileEditTool.ts:86-595`（626 行）8 项验证 + 过时写入守卫。

### 3.2 Bash Engine
- `tools/BashTool/BashTool.tsx:45-54` 输入 schema（含 `_simulatedSedEdit` 隐藏字段）。
- `tools/BashTool/BashTool.tsx:200-280` `runShellCommand` AsyncGenerator。
- `utils/Shell.ts`（475 行）shell 发现 / spawn / CWD 跟踪。
- `utils/ShellCommand.ts`（466 行）进程生命周期、后台化、超时、大小看门狗（`SIGKILL`）。
- `utils/bash/bashProvider.ts`（256 行）snapshot + extglob 关闭 + `eval '<cmd>'` 包装。
- `utils/sandbox/sandbox-adapter.ts`（986 行）seatbelt / bubblewrap 编排。
- `utils/bash/bashSecurity.ts`（~2600 行）命令安全分类。
- `utils/bash/readOnlyValidation.ts`（~1700 行）只读约束。
- `utils/bash/pathValidation.ts`（~1100 行）路径穿越检测。

### 3.3 Permission Pipeline
- `utils/permissions/permissions.ts`（1487 行）`hasPermissionsToUseToolInner` 7 步流水线 + `transitionPermissionMode`。
- `utils/permissions/permissionSetup.ts`（1533 行）模式初始化 / 危险权限检测。
- `utils/permissions/yoloClassifier.ts`（1496 行）两阶段 XML 分类器；紧凑 jsonl 记录排除 assistant 文本。
- `utils/permissions/PermissionMode.ts`（142 行）6 种模式枚举。
- `utils/permissions/PermissionRule.ts`（41 行）规则结构 `{toolName, ruleContent?}`。
- **`utils/permissions/denialTracking.ts:5-10`**（46 行）`DENIAL_LIMITS = { maxConsecutive: 3, maxTotal: 20 }` 拒绝熔断器。
- `utils/permissions/permissionsLoader.ts` 7 源加载。
- `utils/permissions/shadowedRuleDetection.ts`（~250 行）规则遮蔽冲突检测。
- `utils/sandbox/sandbox-adapter.ts` 复用：`autoAllowBashIfSandboxed`、settings 文件 `denyWrite`。
- `services/oauth/client.ts` PKCE + 刷新调度。
- `utils/secureStorage/` Keychain stale-while-error + 4096 字节 stdin 限制。

---

## 4. helixent 现状

> 行号采用读文件时实际看到的范围。文件较短的直接覆盖整个文件。

### 4.1 工具基础类型（foundation）
- [`FunctionTool` 接口](file:///Users/bytedance/Documents/Codex/helixent/src/foundation/tools/function-tool.ts#L8-L21)：仅 4 字段 `name / description / parameters / invoke`，**没有** `isReadOnly` / `isConcurrencySafe` / `summarize` / `capabilities` / `requiresUserInteraction` / `maxResultSizeChars` 等行为或元数据位。
- [`defineTool` 工厂](file:///Users/bytedance/Documents/Codex/helixent/src/foundation/tools/function-tool.ts#L31-L43)：直接透传 4 字段，没有失败即关闭默认。
- [`StructuredToolResult`](file:///Users/bytedance/Documents/Codex/helixent/src/foundation/tools/structured-tool-result.ts#L1-L15)：success `{ok,summary,data?}` / error `{ok,summary,error,code?,details?}` 二选一，**无大结果落盘 / preview ref**。
- [`getToolResultPolicy`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/tool-result-policy.ts#L14-L44)：按工具**名 switch** 给 `preferSummaryOnly / maxStringLength`，新增工具忘了登记会走 `DEFAULT_POLICY`（4000 字节硬上限），可能直接吞大 JSON。
- [`normalizeToolResult` / `formatToolResultForMessage`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/tool-result-runtime.ts#L58-L143)：归一化字符串/structured 结果 + `inferToolErrorKind` 按 code 后缀分类（`INVALID_*` / `*_NOT_FOUND` / `*_FAILED`）。

### 4.2 Bash 工具
- [`bashTool` 全文](file:///Users/bytedance/Documents/Codex/helixent/src/coding/tools/bash.ts#L5-L36)：`Bun.spawn(["zsh", "-c", command])`，无持久会话、无 snapshot、无 CWD 跟踪、无大小看门狗、无沙箱、无 AsyncGenerator 进度、无后台化、无沙箱、无 `description` 隐藏字段策略。signal abort → `proc.kill()`。
- 输出：`new Response(proc.stdout).text()` 一次性读完；非 0 退出返回字符串 `Error: Command ... failed ...`（不是 `errorToolResult`）。

### 4.3 文件写入工具
- [`applyPatchTool` 全文](file:///Users/bytedance/Documents/Codex/helixent/src/coding/tools/apply-patch.ts#L176-L232)：纯 unified diff 解析 + `Bun.file.write`；无 FileStateCache / 过时写入守卫 / 团队记忆密钥检测 / 设备文件检查。仅校验绝对路径 + 拒绝 `+++ /dev/null`。
- [`parsePatch` / `applyHunks`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/tools/apply-patch.ts#L32-L174)：context 行严格匹配 + hunk count 校验，错位直接抛错。

### 4.4 权限层
- [`createCodingApprovalMiddleware`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/permissions/coding-approval-middleware.ts#L19-L43)：唯一一个 middleware，逻辑共 25 行——按工具名命中 → 查 allowList → askUser → deny 时写一条 `User denied execution of tool: ${toolUse.name}` tool_result。
- [`CODING_TOOLS_REQUIRING_APPROVAL`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/permissions/requires-approval.ts#L1-L9)：硬编码 6 个工具名（bash/write_file/str_replace/apply_patch/mkdir/move_path）。
- [`ApprovalDecision`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/permissions/approval-types.ts#L1)：仅 `deny / allow_once / allow_always_project` 三档，无 plan/acceptEdits/auto 等模式。

### 4.5 缺失项盘点
- ❌ 无类似 `assembleToolPool` 的装配排序（lead-agent 直接 `tools: [...]` 数组）
- ❌ 无 ToolSearch / 延迟工具 / `defer_loading` 字段
- ❌ 无 contextModifier / 并发互斥
- ❌ 无大结果落盘机制（依赖 4000 字节硬截断）
- ❌ 无 FileStateCache 共享 / 过时写入守卫
- ❌ 无 Bash 持久会话 / CWD 跟踪 / shell 快照 / 大小看门狗 / OS 沙箱
- ❌ 无 7 步权限流水线、无绕过免疫安全护栏（`.git/` 等可写）
- ❌ 无 6 种权限模式
- ❌ 无 7 源规则合并（仅 `localSettings` 形态的 allowList）
- ❌ 无 YOLO 分类器
- ❌ **无拒绝熔断器**（model 反复尝试同一被拒工具，无安全网）—— outline §1.11 已登记
- ❌ Bash 没有 `ABORT_ERROR_MESSAGE` 类似常量，abort 只是 `proc.kill()`，对模型回写仍是 `Error: ...`
- ❌ tool description 必填策略未在类型层强约束（虽然事实上每个 zod schema 都把 description 列为字段）

---

## 5. 差距与借鉴判断

> 严重度：🔴 阻塞 / 🟡 中风险 / 🟢 锦上添花。建议落点列出 outline 章节或 v3 候选。

| Claude 机制 | helixent 是否有 | 差距严重度 | 建议落点 |
|---|---|---|---|
| 统一 `Tool` 30+ 字段接口 + buildTool 失败即关闭 | 仅 4 字段 | 🟡 | outline §2.4.1（加 capabilities/summarize/resultPolicy/requiresDescription） |
| 行为标志动态判定（`isReadOnly(input)`） | 无 | 🟢 | outline §2.8 B2.2 |
| assembleToolPool 分区排序保 prompt cache | 无 | 🟡（接 Anthropic 直连后会暴露） | outline §1.4 装配 step 2 + B2.3 |
| 拒绝规则发送前预过滤 | 中间件运行时拦 | 🟢 | outline §2.8 B2.11 |
| ToolSearch 延迟加载 + searchHint | 无 | 🟢（MCP 接入后才相关） | outline §模块 5 / B5.2 |
| contextModifier + 并发互斥 | 无 | 🟢 | v3 候选（cwd / set_env 工具时） |
| **大结果落盘 + preview ref** | 无（4000 字节硬截断） | 🔴 长会话必踩 | outline §4.4 L0 Offload + B2.4 共用 ContextStore |
| FileStateCache + 过时写入守卫 | 无 | 🟡 协作时会覆盖用户改 | v3 候选（B2.6） |
| Read 同范围 file_unchanged stub | 无 | 🟢 | v3（B2.7） |
| 内部注入字段（`_simulatedSedEdit`）模型不可见 | 无 | 🟢 当前没此场景 | outline §2.4.1 加 `internalParams?` 字段（B2.8） |
| Bash AsyncGenerator 进度 | 无（一次性读完） | 🟡 长命令体验差 | follow-up（B2.9） |
| Bash 持久会话 / shell snapshot / CWD 跟踪 | 无 | 🟡 影响多步 cd 类命令 | follow-up（独立迭代） |
| Bash 大小看门狗 SIGKILL | 无 | 🔴 同样会撑爆磁盘 | follow-up |
| Bash stdout/stderr 合一 + O_APPEND 原子 | 无（pipe 分开读） | 🟢 | follow-up |
| Bash 命令分类（search/read/silent/neutral）UI 折叠 | 无 | 🟢 | outline §2.4.1 `ToolSummary.kind`（B2.10） |
| 23 种 bash 注入检测 / OS 沙箱 / YOLO 分类器 | 无 | ❌ 不采纳 | outline §2.8 B2.15 标 ❌ |
| 7 步权限评估 + 1d-1g 绕过免疫硬护栏 | 1 步白名单 | 🟡 .git/.claude/ 当前可写 | outline §2.4.5 capability + B2.12（路径黑名单） |
| 6 种权限模式（plan / acceptEdits / dontAsk / auto） | 1 种（默认 ask） | 🟢 | v3 候选 |
| 7 源规则合并 + policy 不可下覆盖 | 仅 local allowList | 🟢 | v3 候选 |
| `requiresUserInteraction` 即使 bypass 也提示 | 无 | 🟢 | outline §2.4.1 加字段（B2.13） |
| 危险权限剥离/恢复（auto 模式） | 无 auto 模式 | ❌ | v3 候选（B2.14） |
| **拒绝熔断器（3/20）** | **无** | 🔴 模型可无限重试被拒工具 | **outline §1.11 已登记，必采纳** |
| 无头代理 PermissionRequest hook | 无 | 🟢 | v3（web/CI 场景） |
| OAuth PKCE / Keychain stale-while-error | 不适用（API key 直连） | ❌ | 不采纳 |
| Settings 多层 merge + 企业策略 | 单文件 allowList | 🟢 | v3 候选 |

---

## 6. 与 outline 章节关联

- **§2 Toolkit 配置体系**：核心承载 `defineTool` 字段扩展（capabilities / summarize / resultPolicy / requiresDescription / requiresUserInteraction / internalParams），把 7 处重复登记压到 2 处；capability-driven approval 替代硬编码白名单——直接对应 02-tool-system §1（buildTool）和 07-permission-pipeline §1c（工具内容级 checkPermissions）。
- **§2.8 借鉴清单**：B2.1-B2.15 已逐条登记 02 + 06 + 07 三篇的可迁移模式，含必采纳的 B2.4（大结果落盘共用 ContextStore）、B2.12（绕过免疫硬护栏）、B2.13（requiresUserInteraction），以及标 ❌ 的 B2.14/B2.15（auto 模式 / OS 沙箱 / 23 种 bash 注入检测——成本极高定位错配）。
- **§1.11 拒绝熔断器**：直接照搬 Claude 的 `DENIAL_LIMITS = { maxConsecutive: 3, maxTotal: 20 }`，落到 `RejectionCircuitState` + `coding-approval-middleware` 的 `beforeToolUse` 钩子 + `agent.ts:stream()` 每步开头检查 `session?.rejection.tripped`。这是 agent loop 的最后安全网。
- **§1.4 装配伪码 step 2**：建议补 `allTools.sort()` + 内置/MCP 分区，对应 02-tool-system §8（assembleToolPool）。
- **§4 Offload & Compact**：与 §2.8 B2.4 共用 `ContextStore`——大 tool result 不双轨（一份落盘 ref + 一份 microcompact 候选），避免管理成本。
- **§模块 5 MCP**：02-tool-system 的 ToolSearch、命名规范 `mcp__{server}__{tool}`、分区排序在 MCP 接入后才真正暴露价值。
- **§模块 6 sub-agent**：07-permission-pipeline 的 PermissionRequest hook（无头代理决策）对应 sub-agent 默认无 ask_user 时的"权限委托链"。

---

## 7. 对 helixent 二期的具体启示

- **必须在 §1.11 落地拒绝熔断器，且阈值与 Claude 对齐**：连续 3 次任意工具被 `decision === "deny"` → `session.rejection.tripped = true`；总计 20 次同样触发；任一 approve 决策清零连续计数。`coding-approval-middleware` 现在 deny 后只往 messages 塞一行字符串，模型会反复尝试，浪费 token 还烧 quota。`agent.ts:stream()` 每步开头检 `session?.rejection.tripped` 并优雅退出，发 trace event `rejection_circuit_tripped`。`[已纳入 §1.11]`

- **defineTool 必须在类型层显式要求 `description` 必填，并加入 `capabilities` + `summarize` 两个最小元数据位**：description 当前是事实上的约定（每个 zod schema 都加），但类型层无强制；`capabilities: Capability[]`（read_fs / write_fs / exec / network / ask_user / delegation）让 `coding-approval-middleware` 从硬编码 6 工具名切到 capability 集合命中，新增任何写文件/执行工具自动被审批拦截，不必改 `requires-approval.ts`；`summarize(input) → { title, detail, kind }` 则消灭 `tool-result-policy.ts`、`message-text.ts`、`message-history.tsx` 三处 `switch (name)`。`[已纳入 §2.4.1 / §2.4.5 / §2.8 B2.1]`

- **大结果落盘要与 §4 Offload 共用一个 ContextStore，避免双轨**：Claude Code 每个工具自带 `maxResultSizeChars`，超限走 `toolResultStorage`。helixent 当前 4000 字节硬截断会让大 grep / read_file 直接被吞。建议 `defineTool.resultPolicy.maxResultSize` + `OffloadMiddleware` 在 `afterToolUse` 触发时把 payload put 到 §4.4.2 的 `ContextStore`，把 `tool_result.content` 替换为 `[offloaded ref=off_xxx size=12000c tool=read_file]\n<前 200 字节预览>`。模型仍能看到轮廓，需要完整内容时由 v3 的 `read_offloaded(ref_id)` 工具按需取回。`[已纳入 §2.8 B2.4 + §4.4]`

- **绕过免疫硬护栏（路径黑名单）值得 MVP 采纳**：Claude 1g 步骤无条件拒绝写 `.git/`、`.claude/`、`.vscode/`、shell 配置——helixent 当前这些路径任何写工具都能改。建议 `coding-approval-middleware` 在 capability 命中前先做一次 absolute path 黑名单匹配（apply_patch / write_file / str_replace / move_path 的 input 中提取 path），命中直接返回 `decision === "deny"` + reason `"protected path"`。零额外配置、零模型成本，但能挡住灾难场景。`[已纳入 §2.8 B2.12]`

- **Bash 工具的安全 + 可观测性独立迭代，不进通用化二期**：持久会话 / shell snapshot / CWD 跟踪 / 大小看门狗 / AsyncGenerator 进度 / 文件模式 stdout-stderr 合一 / `ABORT_ERROR_MESSAGE` 这一组都很有价值（B2.9），但它们彼此耦合且与通用化（profile/toolkit/MCP/sub-agent/compact）正交。建议作为独立 follow-up（`src/coding/tools/bash/` 子目录化），先解决"abort 后回写信息友好"和"输出超过 30K 自动落盘"两个最小子集。`[v3 候选]`

- **`requiresUserInteraction` 字段也应同期加入**：成本极小（一个 boolean），收益是即使未来引入 `bypassPermissions` 模式（v3），`ask_user_question` 这种工具也能强制弹窗——避免静默自动应答。`[已纳入 §2.8 B2.13]`

- **`internalParams` 字段对未来 plan-mode / 模拟编辑预览很有用**：Claude 的 `_simulatedSedEdit` 是经典的"用户批准后内部注入参数，模型不可见"模式。helixent 当前没此场景，但 plan-mode（v3）落地时如要"用户预览补丁 → 批准 → 实际写入"会复用此模式。建议 `defineTool` 留 `internalParams?: ZodSchema` 字段，渲染给模型时与 `parameters` 合成 schema 时剥离 `internalParams` 描述。`[v3 候选]`

- **不要抄 OS 沙箱、不要抄 YOLO 分类器**：sandbox-adapter.ts 986 行 + bashSecurity.ts 2600 行 + yoloClassifier.ts 1496 行——成本极高且与 helixent 定位（轻量 ReAct 库 + 透明开源）不匹配。坚守 outline §2.8 B2.14 / B2.15 标 ❌ 的判断，**纵深防御只做应用层 + 路径黑名单 + 拒绝熔断器三层**，不进 OS 内核级。`[已纳入 §2.8]`

- **assembleToolPool 分区排序在接入 Anthropic 直连前可暂缓**：OpenAI 兼容路径目前 prompt cache 价值有限；但 `createAgentFromProfile` 装配 step 2 加一行 `allTools.sort((a,b) => a.name.localeCompare(b.name))` + 内置在前 / MCP 在后的两段 concat 是 0 成本预防——做了不亏。`[已纳入 §1.4 / §2.8 B2.3]`

---

## 附：源码定位速查

| 主题 | helixent 路径 | 行号 |
|---|---|---|
| FunctionTool 接口 | `src/foundation/tools/function-tool.ts` | L8-L21 |
| defineTool 工厂 | `src/foundation/tools/function-tool.ts` | L31-L43 |
| StructuredToolResult | `src/foundation/tools/structured-tool-result.ts` | L1-L15 |
| bashTool 实现 | `src/coding/tools/bash.ts` | L5-L36 |
| applyPatchTool | `src/coding/tools/apply-patch.ts` | L176-L232 |
| coding-approval-middleware | `src/coding/permissions/coding-approval-middleware.ts` | L19-L43 |
| requiresApproval 白名单 | `src/coding/permissions/requires-approval.ts` | L1-L9 |
| ApprovalDecision 三档 | `src/coding/permissions/approval-types.ts` | L1 |
| getToolResultPolicy | `src/agent/tool-result-policy.ts` | L14-L44 |
| normalizeToolResult / formatForMessage | `src/agent/tool-result-runtime.ts` | L58-L143 |

| Claude Code 关键坐标 | 路径 |
|---|---|
| `Tool` 接口 | `Tool.ts`（793 行）|
| `assembleToolPool` 分区排序 | `src/tools.ts:345-367` |
| `runToolUse` 13 步流水线 | `src/services/tools/toolExecution.ts:337-490, 599-800+` |
| BashTool 输入 schema | `src/tools/BashTool/BashTool.tsx:45-54` |
| `runShellCommand` AsyncGenerator | `src/tools/BashTool/BashTool.tsx:200-280` |
| `hasPermissionsToUseToolInner` 7 步 | `utils/permissions/permissions.ts`（1487 行）|
| YOLO 分类器 | `utils/permissions/yoloClassifier.ts`（1496 行）|
| **拒绝熔断器 DENIAL_LIMITS** | **`utils/permissions/denialTracking.ts:5-10`** |
| 沙箱适配 | `utils/sandbox/sandbox-adapter.ts`（986 行）|

