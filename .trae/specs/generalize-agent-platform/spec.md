# Generalize Agent Platform Spec

## Why

一期 helixent 已具备稳定的 ReAct 循环（[`Agent`](src/agent/agent.ts)）、tool / skill / approval / todo middleware，以及 TUI 与 Web 双前端。但走向"通用化 agent 平台"还有 **四道结构性门槛**：

1. **agent 装配硬编码**：[`createCodingAgent`](src/coding/agents/lead-agent.ts) 把 cwd / AGENTS.md 自动注入 / 12 个 coding 工具 / approval 策略全部写死，新 agent = 改源码
2. **toolkit 配置零散**：每个 tool 单独定义且都重复 `description` 必填字段，permissions 用硬编码字符串数组（[`CODING_TOOLS_REQUIRING_APPROVAL`](src/coding/permissions)），缺乏"工具组 / capability"分层
3. **生态封闭**：12 个内置工具是天花板，无法接入 MCP server 暴露的第三方工具
4. **单 agent 单线程**：lead agent 不能委派 sub-agent，复杂任务无法编排

本期定位为**通用化 agent 平台 v2**，**一次性**铺好 4 条线的地基（你提到的 A/B/C/D 全部）+ 优化 toolkit 配置体验，但**先做 MVP 切片**保证 2-3 周可落地：每条线只做最小可用版本，留出后续 v3 扩展空间。

***

## What Changes

### 五大模块

#### 模块 1: AgentProfile 抽象（A 方向 MVP）

* 新增 `AgentProfile` 数据类型：`id` / `name` / `description` / `systemPrompt` / `toolkit` / `middlewareFactories` / `defaultMaxSteps` / `initialMessages`

* `createAgentFromProfile({ profile, model, runtimeContext })` 通用构造器

* profile registry：`getBuiltinProfile(id)` / `listBuiltinProfiles()` / `registerProfile(profile)`

* 内置 2 个 profile：`coding`（迁移现状）+ `research`（只读 validation）

* CLI 加 `--profile <id>` 参数

#### 模块 2: Toolkit 配置体系（**优化点**）

* 新增 `Toolkit` 抽象：把"一组 tool + 共享元数据"打包

  ```ts
  interface Toolkit {
    id: string;                          // "coding-fs", "coding-shell", ...
    description: string;
    tools: Tool[];
    capabilities: Set<Capability>;        // "read_fs" | "write_fs" | "exec" | "network" | "ask_user"
    requiresApproval?: string[];         // 默认要审批的工具名（可被 profile 覆盖）
  }
  ```

* 内置 5 个 toolkit：

  * `coding-fs-readonly`：read\_file / list\_files / glob\_search / grep\_search / file\_info

  * `coding-fs-write`：write\_file / str\_replace / apply\_patch / mkdir / move\_path

  * `coding-shell`：bash

  * `agent-core`：todo / ask\_user\_question

  * `community-mcp`：动态 toolkit（模块 4）

* profile 通过 `toolkit: ["coding-fs-readonly", "coding-shell", "agent-core"]` 声明工具

* **去重 description 必填**：`defineTool` 增加 `requiresDescription?: boolean = true`，coding 类工具保持要求，简单工具可关闭

* **Capability 化的 approval**：approval middleware 改读 `capability`（如 "write\_fs" / "exec"）而不是硬编码工具名，新工具自动被覆盖

* 旧 `CODING_TOOLS_REQUIRING_APPROVAL` 标记 deprecated，从 capability 派生

#### 模块 3: Profile 管理界面（B 方向 MVP）

* Web 端新增 `/agents` 路由（左侧栏新增"Agents"入口）

* **只读视图（MVP）**：列出所有 builtin profile，展示其名称 / 描述 / toolkit 组成 / system prompt 预览

* **不在 MVP**：增删改 profile / YAML 加载 / 表单编辑器（留 v3）

* `/api/profiles` GET 端点：返回 `listBuiltinProfiles()` 序列化结果

* TUI 层新增 `/agents` slash command 列出 profile（命令式，无 UI）

#### 模块 4: MCP 协议接入（C 方向 MVP）

* 新增 `src/community/mcp/`：MCP Stdio client（仅 stdio transport，先不做 SSE/HTTP）

* 新增 `mcpToolkit(serverConfig)` 工厂：把 MCP server 暴露的 tools 包装为 `Toolkit`

* profile 可声明 `toolkit: [..., mcpToolkit({ command, args })]`

* CLI 配置 schema 加 `mcpServers: Record<string, McpServerConfig>`，与 Claude Desktop 配置兼容

* MVP 仅支持 1 个 server / 1 套配置；多 server 留 v3

#### 模块 5: Sub-agent 委派（D 方向 MVP）

* 新增内置工具 `delegate_task`：参数为 `{ profile_id, prompt, max_steps? }`

* 内部 spawn 一个新 `Agent`（用 profile + 同 model），跑完后把最后一条 assistant message 文本作为 tool\_result 返回

* **MVP 限制**：只支持 1 层委派（sub-agent 不能再调 `delegate_task`）；不并发；同步等待完成；与 ask\_user\_question 互斥（sub-agent 默认不能问用户）

* profile 可选择是否把 `delegate_task` 加入工具集（`agent-orchestration` toolkit）

***

## Impact

* **保持向后兼容**：所有 v0 行为不变（212 测试持续通过、TUI/Web 现有功能保形）

* **影响代码（新增）**：

  * `src/agent/profiles/` —— types / create / registry

  * `src/agent/toolkits/` —— types / registry / builtin toolkits

  * `src/coding/profiles/` —— coding / research

  * `src/community/mcp/` —— stdio client + toolkit factory

  * `src/agent/orchestration/` —— delegate\_task 工具

  * `web/public/app/agents.js` + `web/public/agents.html` 片段 —— 只读 profile 列表

* **影响代码（修改）**：

  * `src/coding/agents/lead-agent.ts` —— 变薄壳，调 `createAgentFromProfile`

  * `src/coding/permissions/coding-approval-middleware.ts` —— 改读 capability

  * `src/foundation/tools/function-tool.ts` —— `defineTool` 加 `requiresDescription`

  * `src/cli/index.tsx` —— `--profile` option + MCP 配置加载

  * `src/cli/config/schema.ts` —— 加 `mcpServers`

  * `web/server.ts` —— `/api/profiles`

* **不影响**：foundation messages 类型 / Web trace 渲染 / 所有 v0 文档

***

## ADDED Requirements

### Requirement: AgentProfile abstraction

系统 SHALL 提供 `AgentProfile` 数据类型与 `createAgentFromProfile()` 构造器作为构造任意 agent 的统一入口。

#### Scenario: Construct any agent from a profile

* **WHEN** 调用方提供 profile（含 id / systemPrompt / toolkit 引用 / middlewareFactories）和 model，调用 `createAgentFromProfile({ profile, model, runtimeContext })`

* **THEN** 返回标准 `Agent` 实例，使用 profile 描述的 prompt / tools / middlewares 装配，复用 ReAct 循环

#### Scenario: Dynamic profile fields

* **WHEN** profile 的 `systemPrompt` / `tools` / `initialMessages` 是 factory 函数形式

* **THEN** 装配时调用该 factory，传入 `runtimeContext`（含 cwd / askUser / askUserQuestion / approvalPersistence）求值

### Requirement: Profile registry

系统 SHALL 提供 `getBuiltinProfile(id)` / `listBuiltinProfiles()` / `registerProfile(profile)`。

#### Scenario: Get built-in profiles

* **WHEN** 调用 `getBuiltinProfile("coding")` / `getBuiltinProfile("research")`

* **THEN** 返回对应 profile 对象

#### Scenario: Unknown profile error

* **WHEN** 调用 `getBuiltinProfile("nonexistent")`

* **THEN** 抛 `Error`，错误 message 包含 `Available: coding, research, ...`

### Requirement: Toolkit abstraction

系统 SHALL 提供 `Toolkit` 类型作为"一组工具 + capability + 默认审批策略"的打包单位。

#### Scenario: Reference toolkit by id in profile

* **WHEN** profile 的 `toolkit` 字段为 `["coding-fs-readonly", "coding-shell", "agent-core"]`

* **THEN** 装配时按 id 解析为 toolkit，扁平化合并 `tools`，并将 `capabilities` / `requiresApproval` 注入 runtime context

#### Scenario: Capability-based approval

* **WHEN** profile 装配出的工具集中某工具 capability 含 `write_fs` 或 `exec`

* **THEN** approval middleware 默认拦截该工具调用，无需手工维护工具名白名单

#### Scenario: Toolkit deduplication

* **WHEN** profile 同时引用 `coding-fs-readonly` 和 `coding-fs-write`

* **THEN** 装配后 tools 数组按工具 name 去重，不抛错

### Requirement: Builtin profiles (coding + research)

系统 SHALL 内置至少 2 个 profile：`coding` / `research`。

#### Scenario: Coding profile parity

* **WHEN** 通过 profile 路径装配 coding agent

* **THEN** 工具集等同于一期（12 个 coding 工具 + todo + 可选 ask\_user\_question），AGENTS.md 自动注入逻辑保持，approval middleware 通过 capability 触发

#### Scenario: Research profile capability surface

* **WHEN** 加载 research profile

* **THEN** 工具集 = `{ read_file, list_files, glob_search, grep_search, file_info, bash, ask_user_question, todo }`，**不**含 mutating 工具

* **AND** systemPrompt 强调"只读调研模式"

* **AND** 不挂 approval middleware（capability 中无 write\_fs / exec 写入语义）

### Requirement: CLI profile selection

CLI SHALL 支持 `--profile <id>`，默认 `coding`。

#### Scenario: Default

* **WHEN** `helix` 不带 `--profile`

* **THEN** 装配 coding profile

#### Scenario: Explicit

* **WHEN** `helix --profile research`

* **THEN** 装配 research profile，TUI header 显示 `Helixent · research`

#### Scenario: Invalid

* **WHEN** `helix --profile foo`

* **THEN** 退出码 1，stderr 含 `Unknown profile "foo". Available: coding, research`

### Requirement: Profile read-only Web UI

Web 端 SHALL 提供 `/agents` 视图展示所有 builtin profile（只读）。

#### Scenario: List profiles

* **WHEN** 用户点击左侧"Agents" 入口

* **THEN** 显示 profile 卡片列表：每张卡片含 id / name / description / toolkit ids / systemPrompt 摘要前 200 字

* **AND** 当前 session 使用的 profile 标识为 "Active"

#### Scenario: Profile API

* **WHEN** GET `/api/profiles`

* **THEN** 返回 JSON `{ profiles: [{ id, name, description, toolkitIds, systemPromptPreview, builtIn: true }] }`

### Requirement: MCP toolkit (stdio)

系统 SHALL 提供 `mcpToolkit({ command, args, env? })` 工厂，把 MCP stdio server 暴露的 tools 包装为 Toolkit。

#### Scenario: Load MCP server tools

* **WHEN** profile 含 `toolkit: [mcpToolkit({ command: "node", args: ["./my-mcp.js"] })]`

* **THEN** 启动时 spawn 子进程，发起 MCP `tools/list`，把返回的工具转换为 helixent `Tool` 实例

* **AND** sub-agent 调用工具时通过 MCP `tools/call` 路由到子进程

#### Scenario: MCP server failure isolation

* **WHEN** MCP server 启动失败 / 超时

* **THEN** 不阻塞 agent 启动，仅日志 warning 并把该 toolkit 视为空集

#### Scenario: CLI config integration

* **WHEN** `~/.helixent/config.json` 含 `mcpServers: { "weather": { command: "...", args: [...] } }`

* **THEN** CLI 启动时按需加载（profile 引用了相应 mcpToolkit 才加载）

### Requirement: Sub-agent delegation

系统 SHALL 提供 `delegate_task` 工具，实现 1 层 sub-agent 委派。

#### Scenario: Delegate with profile

* **WHEN** lead agent 调用 `delegate_task({ profile_id: "research", prompt: "总结当前 src/agent 模块" })`

* **THEN** spawn 新 `Agent` 用 research profile 运行，结束后将最后一条 assistant text content 作为 tool\_result 返回

#### Scenario: One-level depth limit

* **WHEN** sub-agent 自身又调用 `delegate_task`

* **THEN** tool 返回错误 `delegation_depth_exceeded`，不再 spawn

#### Scenario: Excluded by default

* **WHEN** profile 未在 `toolkit` 中声明 `agent-orchestration`

* **THEN** 工具集中无 `delegate_task`

### Requirement: Tool description-required relax

`defineTool` SHALL 接受 `requiresDescription?: boolean`（默认 true）。

#### Scenario: Default behavior

* **WHEN** 工具未指定 `requiresDescription`

* **THEN** 行为同一期，工具 zod schema 中 `description` 字段保持必填

#### Scenario: Opt-out

* **WHEN** 工具显式 `requiresDescription: false`

* **THEN** zod schema 不再要求 description 字段（用于不需要解释的极简工具）

***

## MODIFIED Requirements

### Requirement: Coding agent

`createCodingAgent` 公开签名保持不变，内部实现 SHALL 改为 `createAgentFromProfile(codingProfile, runtimeContext)`。

#### Scenario: Behavior parity

* **WHEN** 跑 `bun run check`

* **THEN** v0 全部 212 测试通过

* **AND** lead-agent 所有现有行为（AGENTS.md / 12 工具 / approval / skills / todos）保持

### Requirement: Coding approval middleware

`createCodingApprovalMiddleware` SHALL 接受 `requiresCapabilities: Set<Capability>` 替代 `requiresApproval: string[]`。

#### Scenario: Capability-driven approval

* **WHEN** 工具的 capability 集与 `requiresCapabilities` 有交集

* **THEN** middleware 拦截并询问用户

* **AND** 旧 `requiresApproval: string[]` 字段保留，作为兼容路径（标 deprecated）

***

## REMOVED Requirements

无。本期所有删除项以 deprecated 方式过渡（`requiresApproval: string[]`），不实际删除任何 v0 公开接口。

***

## Out of Scope（留 v3）

* Profile 文件加载（`~/.helix/profiles/*.yaml` / 用户编辑器）

* Profile **可写** Web UI（增删改、表单编辑、一键启动）

* MCP HTTP / SSE transport

* 多 MCP server 并行

* Sub-agent 多层 / 并行委派

* Sub-agent 与 lead 之间的事件流双向同步（trace 嵌套展示）

* 长期 / 跨 session 记忆系统

* Profile 切换不重启（session 内热切换）

