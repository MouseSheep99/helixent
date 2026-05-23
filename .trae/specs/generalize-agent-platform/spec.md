# Generalize Agent Platform Spec

## Why

一期 helixent 已具备稳定的 ReAct 循环（[`Agent`](src/agent/agent.ts)）、tool / skill / approval / todo 中间件，以及 TUI 和 Web 两个前端。但**装配 agent** 的逻辑高度耦合到 coding 场景：[`createCodingAgent`](src/coding/agents/lead-agent.ts) 硬编码了 `cwd`、`AGENTS.md` 自动注入、12 个 coding 工具、coding-only 的 approval 策略。要让 helixent 走向通用化 agent 平台，必须先把"一个 agent 是什么"抽象成数据，让"换一种 agent" 变成 **配置切换** 而非改源码。

本期定位为**通用化的地基**：仅做声明式 profile 抽象与 1 个非编码内置 profile 验证泛化，**不**引入 MCP / sub-agent / 长期记忆 —— 这些为下期目标。

## What Changes

- **新增 `AgentProfile` 抽象**：纯数据结构，描述一个 agent 的全部装配信息
  - `name` / `description`
  - `systemPrompt`（`string | (ctx) => string`）
  - `tools`（`Tool[]` 或 `(ctx) => Tool[]`）
  - `middlewareFactories`（`((ctx) => AgentMiddleware)[]`）
  - `defaultMaxSteps?`
- **Profile registry**：`getBuiltinProfile(id)` / `listBuiltinProfiles()`
- **2 个内置 profile**：
  - `coding`（迁移自现有 `lead-agent.ts`，行为完全等价）
  - `research`（**新增非编码 profile**：只读工具子集 + ask_user_question + bash 只读用法限制；validation 用例）
- **CLI 新增 `--profile <id>` 参数**：默认 `coding`，向后兼容
- **`createAgentFromProfile()` 通用构造器**：单一入口
- `createCodingAgent` 保留旧签名作 thin wrapper，不破坏现有调用方

## Impact

- **保持向后兼容**：现有所有 v0 行为不变（coding agent 行为、TUI/Web 前端、所有 v0 测试 212 pass 维持）
- **影响代码**：
  - 新增 `src/agent/profiles/`（types.ts / create.ts / registry.ts / __tests__/）
  - 新增 `src/coding/profiles/coding.ts`（迁移 prompt + tools 列表）
  - 新增 `src/coding/profiles/research.ts`
  - 修改 `src/coding/agents/lead-agent.ts`（变薄壳）
  - 修改 CLI 入口加 commander option
- **不影响**：foundation 层 / agent 层核心 ReAct 循环 / web 前端 / 所有 v0 文档

## ADDED Requirements

### Requirement: Agent Profile abstraction

系统 SHALL 提供 `AgentProfile` 类型和 `createAgentFromProfile()` 构造函数，作为构造任意 agent 的统一入口。

#### Scenario: Construct any agent from a profile

- **WHEN** 调用方提供 `AgentProfile`（含 name / systemPrompt / tools / middlewareFactories）和 `model`，调用 `createAgentFromProfile({ profile, model, runtimeContext })`
- **THEN** 返回标准 `Agent` 实例，使用 profile 描述的 prompt、tools、middlewares 装配，并复用现有 ReAct 循环

#### Scenario: Dynamic profile fields

- **WHEN** profile 的 `systemPrompt` 或 `tools` 是 function 形式
- **THEN** 在装配时调用该 function，传入 `runtimeContext`（含 `cwd`、可选 `askUser` 等）求值

### Requirement: Profile registry

系统 SHALL 提供 `getBuiltinProfile(id)` 和 `listBuiltinProfiles()` 用于查询内置 profile。

#### Scenario: Get built-in coding profile

- **WHEN** 调用 `getBuiltinProfile("coding")`
- **THEN** 返回 coding profile 对象（含 ≥ 12 个 coding 工具）

#### Scenario: Get built-in research profile

- **WHEN** 调用 `getBuiltinProfile("research")`
- **THEN** 返回 research profile 对象，**且不包含**任何 mutating 工具（`write_file` / `str_replace` / `apply_patch` / `mkdir` / `move_path`）

#### Scenario: Unknown profile error

- **WHEN** 调用 `getBuiltinProfile("nonexistent")`
- **THEN** 抛出 `Error` 并提示已注册的 profile 列表

### Requirement: Research profile (non-coding validation)

系统 SHALL 提供至少一个非编码内置 profile 以验证 profile 抽象能装配本质不同的 agent。

#### Scenario: Research profile capability surface

- **WHEN** 加载 `research` profile
- **THEN** tools 集合等于 `{ read_file, list_files, glob_search, grep_search, file_info, bash, ask_user_question, todo }`，**不**包含 `write_file / str_replace / apply_patch / mkdir / move_path`
- **AND** system prompt 强调"只做调研与解释，不可对文件做任何写入或重命名"

### Requirement: CLI profile selection

CLI SHALL 支持 `--profile <id>` 参数选择 agent profile。

#### Scenario: Default profile

- **WHEN** 用户运行 `helix` 不带 `--profile`
- **THEN** 装配 `coding` profile（向后兼容现有行为）

#### Scenario: Explicit profile via CLI

- **WHEN** 用户运行 `helix --profile research`
- **THEN** 装配 research profile，TUI header 显示 `Helixent · research`

#### Scenario: Invalid profile id

- **WHEN** 用户运行 `helix --profile foo`
- **THEN** CLI 立即退出并打印 `Unknown profile "foo". Available: coding, research`

## MODIFIED Requirements

### Requirement: Coding agent

`createCodingAgent` 公开签名保持不变，内部实现 SHALL 改为通过 `createAgentFromProfile(codingProfile, ...)` 构造。

#### Scenario: Behavior parity

- **WHEN** 跑现有完整测试套件 `bun run check`
- **THEN** 一期所有 212 个测试用例全部通过（无回归）
- **AND** lead-agent 仍能装配 AGENTS.md、12 个 coding 工具、approval middleware

## REMOVED Requirements

无。本期仅做加法 / 重构，不移除任何现有能力。

## Out of Scope（非本期）

以下能力虽然属于"通用化 agent" 大方向，本期**不**实现，预留给后续 spec：

- **MCP（Model Context Protocol）集成** —— 接入第三方 tool server
- **Sub-agent 委派** —— lead agent 嵌套调用 sub-agent
- **长期 / 跨 session 记忆** —— 持久化向量库或 SQLite knowledge
- **Profile 文件加载** —— 从 `~/.helix/profiles/*.yaml` 加载用户自定义 profile（本期 profile 仍为 TS 代码）
- **多 profile 同时运行** —— 单 session 切换 / 多 agent 协同
