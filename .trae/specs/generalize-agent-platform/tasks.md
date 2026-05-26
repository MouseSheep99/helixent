# Tasks

## Phase 1 — 地基（模块 1+2，无依赖外部）

- [ ] Task 1: Toolkit 抽象与 capability 模型
  - [ ] 1.1 新建 `src/agent/toolkits/types.ts`：导出 `Capability`（联合类型 `"read_fs" | "write_fs" | "exec" | "network" | "ask_user" | "delegation"`）、`Toolkit` 接口（id/description/tools/capabilities/requiresApproval?）
  - [ ] 1.2 新建 `src/agent/toolkits/registry.ts`：`registerToolkit` / `getToolkit(id)` / `listToolkits()` / `resolveToolkits(refs)` 支持 `string | Toolkit` 混合引用
  - [ ] 1.3 在 `src/agent/index.ts` 导出新类型与函数

- [ ] Task 2: 内置 5 个 builtin toolkit
  - [ ] 2.1 `src/coding/toolkits/coding-fs-readonly.ts`：read_file / list_files / glob_search / grep_search / file_info，capability `["read_fs"]`
  - [ ] 2.2 `src/coding/toolkits/coding-fs-write.ts`：write_file / str_replace / apply_patch / mkdir / move_path，capability `["write_fs"]`
  - [ ] 2.3 `src/coding/toolkits/coding-shell.ts`：bash，capability `["exec"]`
  - [ ] 2.4 `src/agent/toolkits/agent-core.ts`：todo + ask_user_question 工厂（后者依赖 runtime context），capability `["ask_user"]`
  - [ ] 2.5 在 `src/coding/toolkits/index.ts` / `src/agent/toolkits/index.ts` 副作用导出注册

- [ ] Task 3: defineTool 支持 requiresDescription
  - [ ] 3.1 修改 `src/foundation/tools/function-tool.ts`：`defineTool` 接受 `requiresDescription?: boolean = true`；当 false 时不强制 zod schema 要求 description
  - [ ] 3.2 不动现有 12 个工具（保持 description 必填，无 breaking）
  - [ ] 3.3 单测：默认行为 / opt-out 行为

- [ ] Task 4: AgentProfile 抽象与 createAgentFromProfile
  - [ ] 4.1 `src/agent/profiles/types.ts`：导出 `AgentProfile` / `AgentProfileRuntimeContext` / `AgentProfileToolkitRef`（`string | Toolkit`）
  - [ ] 4.2 `src/agent/profiles/create.ts`：实现 `createAgentFromProfile`，内部解析 systemPrompt / toolkit / middlewareFactories / initialMessages 的 string-vs-factory 形态，扁平化 toolkit tools 并按 name 去重，把 capability 集合放进 runtimeContext
  - [ ] 4.3 单测：T1 string prompt / T2 factory prompt / T3 toolkit ref string / T4 toolkit ref object / T5 tool 去重 / T6 maxSteps 默认 / T7 initialMessages factory

- [ ] Task 5: Profile registry
  - [ ] 5.1 `src/agent/profiles/registry.ts`：`registerProfile` / `getBuiltinProfile` / `listBuiltinProfiles`
  - [ ] 5.2 unknown id 抛错，message 含 `Available: ...`
  - [ ] 5.3 单测：T1 注册取出 / T2 unknown 错误 / T3 list 排序

## Phase 2 — Coding parity 与 capability approval

- [ ] Task 6: Capability-based approval middleware
  - [ ] 6.1 `src/coding/permissions/coding-approval-middleware.ts`：增加 `requiresCapabilities?: Set<Capability>` 字段；保留旧 `requiresApproval: string[]` 但标 deprecated
  - [ ] 6.2 工具元数据来源：从 runtimeContext.toolCapabilities Map（toolName → Set<Capability>）查询
  - [ ] 6.3 单测：capability 命中走原有审批流；无命中且不在旧 list 则放行

- [ ] Task 7: Coding profile（迁移现状）
  - [ ] 7.1 `src/coding/profiles/coding.ts`：导出 `codingProfile`，`toolkit: ["coding-fs-readonly", "coding-fs-write", "coding-shell", "agent-core"]`
  - [ ] 7.2 systemPrompt factory：从 runtimeContext.cwd 拼接现有字面文本
  - [ ] 7.3 initialMessages factory：迁移 AGENTS.md 自动加载逻辑
  - [ ] 7.4 middlewareFactories：skills / todo / 可选 capability-approval（含 `write_fs` + `exec`）
  - [ ] 7.5 注册到 builtin profile registry

- [ ] Task 8: 改造 createCodingAgent 为薄壳
  - [ ] 8.1 修改 `src/coding/agents/lead-agent.ts`：内部 `createAgentFromProfile(codingProfile, runtimeContext)`，公开签名 / 返回类型不变
  - [ ] 8.2 跑 v0 完整测试 212 个，确保无回归
  - [ ] 8.3 新增 `src/coding/profiles/__tests__/coding-parity.test.ts`：T1 工具集等同 v0 / T2 systemPrompt 字面包含同关键词 / T3 AGENTS.md 注入逻辑保持

## Phase 3 — Research profile 与 CLI

- [ ] Task 9: Research profile
  - [ ] 9.1 `src/coding/profiles/research.ts`：`toolkit: ["coding-fs-readonly", "coding-shell", "agent-core"]`，**不**含 `coding-fs-write`
  - [ ] 9.2 systemPrompt 强调"调研模式：禁写入"
  - [ ] 9.3 middlewareFactories：仅 todo / skills（无 approval）
  - [ ] 9.4 注册
  - [ ] 9.5 单测 `research.test.ts`：T1 tool 白名单 / T2 黑名单不存在 / T3 systemPrompt 含 "research" / "read-only" / T4 无 approval middleware

- [ ] Task 10: CLI --profile 参数
  - [ ] 10.1 修改 `src/cli/index.tsx`：commander 加 `.option("-p, --profile <id>", "Agent profile to load", "coding")`
  - [ ] 10.2 提取启动逻辑到 `bootstrapAgentFromProfile(profileId, ...)`，coding 走兼容路径（`createCodingAgent`），其余走 `createAgentFromProfile(getBuiltinProfile(id), ...)`
  - [ ] 10.3 invalid id：catch 后红字打印并 `process.exit(1)`
  - [ ] 10.4 修改 `src/cli/tui/components/header.tsx`：标题加 ` · ${profileId}` 后缀
  - [ ] 10.5 单测：commander parser / header 渲染含 profile id

## Phase 4 — MCP toolkit MVP

- [ ] Task 11: MCP stdio client
  - [ ] 11.1 `src/community/mcp/stdio-client.ts`：spawn 子进程 / 实现 JSON-RPC over stdio / 实现 `initialize` / `tools/list` / `tools/call`
  - [ ] 11.2 错误隔离：超时 5s / 启动失败 → warn + 空 toolkit
  - [ ] 11.3 abort signal 透传：agent abort 时 kill 子进程

- [ ] Task 12: mcpToolkit 工厂
  - [ ] 12.1 `src/community/mcp/toolkit.ts`：导出 `mcpToolkit({ command, args, env?, id? })`，返回 `Toolkit`
  - [ ] 12.2 把 MCP tool schema 转为 zod schema（最小可用：string/number/boolean/object 字段）
  - [ ] 12.3 capability 默认 `["network"]`（保守，所有 MCP 视为外部副作用）
  - [ ] 12.4 单测：mock stdio 子进程，验证装载 / 调用 / 失败隔离

- [ ] Task 13: CLI 配置 mcpServers
  - [ ] 13.1 修改 `src/cli/config/schema.ts`：可选字段 `mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>`
  - [ ] 13.2 CLI 启动时把 config.mcpServers 传给 runtimeContext，profile 中可通过 `runtimeContext.mcpServers["weather"]` 取配置并 build mcpToolkit
  - [ ] 13.3 单测：config schema 解析

## Phase 5 — Sub-agent 委派 MVP

- [ ] Task 14: delegate_task 工具与 orchestration toolkit
  - [ ] 14.1 `src/agent/orchestration/delegate-task.ts`：实现 `delegate_task` 工具，参数 `{ profile_id, prompt, max_steps? }`
  - [ ] 14.2 内部用 runtimeContext 中的 model + getBuiltinProfile(profile_id) + spawn 新 Agent，跑完返回最后一条 assistant text
  - [ ] 14.3 通过 runtimeContext.delegationDepth 实现 1 层限制；> 0 时拒绝并返回 `delegation_depth_exceeded`
  - [ ] 14.4 `src/agent/orchestration/toolkit.ts`：`agent-orchestration` toolkit，capability `["delegation"]`
  - [ ] 14.5 单测：T1 委派成功返回最后 text / T2 1 层限制触发 / T3 profile 不引用 toolkit 时无该 tool

## Phase 6 — Web 只读 profile UI

- [ ] Task 15: /api/profiles 端点
  - [ ] 15.1 修改 `web/server.ts`：新增 GET `/api/profiles` 路由，返回 `listBuiltinProfiles()` 序列化（id / name / description / toolkitIds / systemPromptPreview）
  - [ ] 15.2 systemPromptPreview = systemPrompt(若 string) 或调 factory 用空 runtimeContext 后取前 200 字
  - [ ] 15.3 单测：route 返回 200 + JSON shape

- [ ] Task 16: Web /agents 视图
  - [ ] 16.1 `web/public/index.html` 新增"Agents" tab 入口（左侧栏紧贴 Skills 之下）
  - [ ] 16.2 `web/public/app/agents.js`：fetch /api/profiles → 渲染卡片列表（id / name / description / toolkit chip / systemPrompt preview）
  - [ ] 16.3 cache busting v=trace-lens-workbench-74
  - [ ] 16.4 当前 session profile 标 "Active"（先用 URL query / 默认 coding 占位）
  - [ ] 16.5 frontend-smoke 测试追加：确认入口 + cache=74

## Phase 7 — 验收

- [ ] Task 17: bun run check 全绿
  - [ ] 17.1 跑 `bun run check`，预期 ≥ 230 pass（v0 212 + 新增 ≥ 18）
  - [ ] 17.2 修复任何回归

- [ ] Task 18: 手测 happy path
  - [ ] 18.1 `helix`（默认 coding）—— 行为同 v0
  - [ ] 18.2 `helix --profile research` —— 工具列表只含只读
  - [ ] 18.3 `helix --profile foo` —— 立即退出
  - [ ] 18.4 web 启动后访问 /agents 看到 2 个内置 profile
  - [ ] 18.5 让 coding agent 调 `delegate_task({ profile_id: "research", prompt: "..." })`，sub-agent 完成后返回文本

# Task Dependencies

- Phase 2 (T6-T8) depends on Phase 1 (T1-T5)
- Phase 3 (T9-T10) depends on Phase 1 + T7
- Phase 4 (T11-T13) depends on Phase 1（独立于 Phase 2/3，可并行）
- Phase 5 (T14) depends on Phase 1 + T5（registry）+ Phase 3（research profile 用作委派 fixture）
- Phase 6 (T15-T16) depends on Phase 3（CLI 路径需要 profile 已注册）
- Phase 7 (T17-T18) depends on **all** above

# 并行执行建议

- 完成 Phase 1 后，可并行启动：
  - 子 agent A：Phase 2（T6-T8）
  - 子 agent B：Phase 4（T11-T13）
- T8（coding parity）完成后 Phase 3 可启动
- T16（Web UI）独立可在 T15 完成后立即并行
