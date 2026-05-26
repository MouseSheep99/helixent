# Verification Checklist

## Phase 1 — 地基

### Toolkit 抽象
- [ ] `src/agent/toolkits/types.ts` 导出 `Capability` 联合类型，包含 `"read_fs" | "write_fs" | "exec" | "network" | "ask_user" | "delegation"`
- [ ] `src/agent/toolkits/types.ts` 导出 `Toolkit` 接口，含 id / description / tools / capabilities / requiresApproval?
- [ ] `src/agent/toolkits/registry.ts` 导出 `registerToolkit / getToolkit / listToolkits / resolveToolkits`
- [ ] `resolveToolkits` 支持 `string | Toolkit` 混合引用并按 tool name 去重

### Builtin toolkits
- [ ] `coding-fs-readonly` 工具集 = read_file / list_files / glob_search / grep_search / file_info（5 个），capability 含 `read_fs`
- [ ] `coding-fs-write` 工具集 = write_file / str_replace / apply_patch / mkdir / move_path（5 个），capability 含 `write_fs`
- [ ] `coding-shell` 工具集 = bash（1 个），capability 含 `exec`
- [ ] `agent-core` 工具集含 todo（todo 工具名以源码为准），可选 ask_user_question；capability 含 `ask_user`
- [ ] 模块导入即触发注册（副作用导出验证）

### defineTool relax
- [ ] `defineTool` 接受 `requiresDescription?: boolean`，默认 true
- [ ] 当 `requiresDescription: false`，工具 zod schema 不强制 description 必填
- [ ] 现有 12 个工具未修改，`description` 仍为 zod 必填字段

### Profile 抽象
- [ ] `AgentProfile` 类型导出，含 id / name / description / systemPrompt / toolkit / middlewareFactories? / defaultMaxSteps? / initialMessages?
- [ ] `createAgentFromProfile({ profile, model, runtimeContext })` 返回标准 `Agent` 实例
- [ ] systemPrompt / toolkit / initialMessages 支持 string-vs-factory 双形态
- [ ] toolkit 解析后 tools 按 name 去重
- [ ] runtimeContext 注入 `toolCapabilities: Map<string, Set<Capability>>`

### Profile registry
- [ ] `registerProfile / getBuiltinProfile / listBuiltinProfiles` 导出
- [ ] `getBuiltinProfile("nonexistent")` 抛错，message 含 `Available:` + 已注册 id 列表

## Phase 2 — Coding parity

### Capability approval
- [ ] `createCodingApprovalMiddleware` 接受 `requiresCapabilities: Set<Capability>` 字段
- [ ] capability 命中时走原有 askUser 流程
- [ ] 旧 `requiresApproval: string[]` 字段保留并标 `@deprecated`，仍可工作

### Coding profile
- [ ] `src/coding/profiles/coding.ts` 导出 `codingProfile`
- [ ] codingProfile.toolkit 引用 4 个 toolkit id（含 fs-readonly / fs-write / shell / agent-core）
- [ ] codingProfile.systemPrompt factory 接收 cwd，输出包含 v0 字面相同关键词（`Helixent`、`leading_agent`、`<working_directory dir=`、`<tool_usage>`、`<notes>`）
- [ ] codingProfile.initialMessages factory 仍能加载 AGENTS.md（如存在）作为首条 user message

### lead-agent 薄壳
- [ ] `createCodingAgent` 公开签名 / 返回类型不变
- [ ] 内部实现走 `createAgentFromProfile(codingProfile, runtimeContext)`
- [ ] v0 全部 212 个测试无回归

## Phase 3 — Research + CLI

### Research profile
- [ ] `getBuiltinProfile("research")` 返回 profile，工具集 = read_file / list_files / glob_search / grep_search / file_info / bash / ask_user_question / todo
- [ ] research profile **不**含 write_file / str_replace / apply_patch / mkdir / move_path
- [ ] systemPrompt 包含 "research" / "read-only" 或等价中文 "调研" / "只读" / "禁写入"
- [ ] middlewareFactories 不含 coding-approval middleware

### CLI
- [ ] `helix` 不带 profile 默认 coding，行为同 v0
- [ ] `helix --profile research` 启动成功
- [ ] `helix --profile foo` 退出码 1，stderr 含 `Unknown profile "foo"` + 可用列表
- [ ] TUI header 显示 `Helixent · ${profileId}`

## Phase 4 — MCP

### Stdio client
- [ ] `mcpStdioClient.connect()` 成功 spawn 子进程并完成 `initialize` 握手
- [ ] `tools/list` 返回的 tool 数组被装成 helixent `Tool` 实例
- [ ] `tools/call` 路由到子进程
- [ ] 启动失败 / 5s 超时 → warn 日志 + 空 tool 数组（不抛异常）
- [ ] agent abort 时子进程被 kill

### mcpToolkit
- [ ] `mcpToolkit({ command, args, env? })` 返回 Toolkit
- [ ] capability 默认含 `network`
- [ ] config schema 接受 `mcpServers?: Record<...>`

## Phase 5 — Sub-agent

### delegate_task
- [ ] 工具名为 `delegate_task`，参数 `{ profile_id, prompt, max_steps? }`
- [ ] 调用后 spawn 新 `Agent`，使用 `getBuiltinProfile(profile_id)`
- [ ] sub-agent 完成后返回最后一条 assistant message text
- [ ] sub-agent 内再调 `delegate_task` 返回 `delegation_depth_exceeded` 错误
- [ ] profile 未引用 `agent-orchestration` toolkit 时 tools 不含 `delegate_task`

## Phase 6 — Web /agents

### API
- [ ] GET `/api/profiles` 返回 `{ profiles: [...] }`，每项含 id / name / description / toolkitIds / systemPromptPreview / builtIn:true
- [ ] systemPromptPreview 长度 ≤ 200

### UI
- [ ] index.html 新增 "Agents" 入口，紧贴 Skills 之下
- [ ] /agents 视图渲染至少 2 张卡片（coding + research）
- [ ] cache busting v=trace-lens-workbench-74

## Phase 7 — 验收

### 自动测试
- [ ] `bun run check` 全绿，pass 数 ≥ 230（v0 212 + 新增 ≥ 18）
- [ ] 无 TypeScript 错误
- [ ] 无 ESLint 错误

### 手测 happy path
- [ ] `helix` 默认启动等价 v0
- [ ] `helix --profile research` 工具列表正确（仅只读 + bash + todo + ask_user_question）
- [ ] `helix --profile foo` 立即退出 + 错误信息
- [ ] web 启动 → /agents 看到 2 个 builtin profile 卡片
- [ ] coding agent 调 delegate_task("research", ...) 可成功返回 sub-agent 文本

### 文档
- [ ] AGENTS.md 中"Architecture (4 layers)"段落更新为提及 profile / toolkit 抽象
- [ ] 实施完成后将本 spec 目录归档到 `.trae/specs/generalize-agent-platform/`（已存在，无需移动）
