# Tasks

- [ ] Task 1: 定义 AgentProfile 类型与 runtimeContext 契约
  - [ ] 1.1 新建 `src/agent/profiles/types.ts`：导出 `AgentProfile`、`AgentProfileRuntimeContext`、`AgentProfileToolFactory`、`AgentProfileSystemPromptFactory`
  - [ ] 1.2 字段：`id` / `name` / `description` / `systemPrompt`（string | factory）/ `tools`（Tool[] | factory）/ `middlewareFactories?` / `defaultMaxSteps?` / `initialMessages?`（factory）
  - [ ] 1.3 在 `src/agent/index.ts` 重新导出新类型

- [ ] Task 2: 实现 createAgentFromProfile() 通用构造器
  - [ ] 2.1 新建 `src/agent/profiles/create.ts`：导出 `createAgentFromProfile({ profile, model, runtimeContext })`
  - [ ] 2.2 内部解析 systemPrompt / tools 的 string-vs-factory 形态，调 factory 时传入 `runtimeContext`
  - [ ] 2.3 装配 `Agent` 实例，写入 `name`、`prompt`、`tools`、`middlewares`、`maxSteps`、`messages`
  - [ ] 2.4 在 `src/agent/index.ts` re-export

- [ ] Task 3: 实现 profile registry
  - [ ] 3.1 新建 `src/agent/profiles/registry.ts`：维护 builtin profile Map
  - [ ] 3.2 导出 `registerBuiltinProfile(profile)`、`getBuiltinProfile(id)`、`listBuiltinProfiles()`
  - [ ] 3.3 unknown id 时抛 `Error`，message 包含 `Available: ...`

- [ ] Task 4: 抽出 coding profile（迁移现有 lead-agent.ts）
  - [ ] 4.1 新建 `src/coding/profiles/coding.ts`：导出 `codingProfile: AgentProfile`
  - [ ] 4.2 systemPrompt 用 factory 形态，从 `runtimeContext.cwd` 拼接现有 prompt 文本（保字面相同）
  - [ ] 4.3 tools factory 返回现有 12 个 coding 工具 + todo + 可选 ask_user_question
  - [ ] 4.4 middlewareFactories 包含 skills / todo / 可选 approval
  - [ ] 4.5 initialMessages factory 实现 AGENTS.md 自动加载逻辑（迁移自 lead-agent）
  - [ ] 4.6 在 `src/coding/profiles/index.ts` 导出
  - [ ] 4.7 修改 `src/coding/agents/lead-agent.ts`：内部改调 `createAgentFromProfile(codingProfile, ...)`，公开签名不变
  - [ ] 4.8 在 registry 引导处注册 coding profile（懒注册或 `src/coding/index.ts` 副作用导出）

- [ ] Task 5: 实现 research profile（非编码 validation）
  - [ ] 5.1 新建 `src/coding/profiles/research.ts`：导出 `researchProfile: AgentProfile`
  - [ ] 5.2 tools = `read_file / list_files / glob_search / grep_search / file_info / bash / todo`，可选 ask_user_question；**禁止** write_file / str_replace / apply_patch / mkdir / move_path
  - [ ] 5.3 systemPrompt 强调"调研模式：禁止任何写入/重命名/创建目录操作；如需修改，请提示用户切换到 coding profile"
  - [ ] 5.4 middlewareFactories 仅含 todo（无 approval —— 工具集本身就只读）
  - [ ] 5.5 在 `src/coding/profiles/index.ts` 导出并注册到 registry

- [ ] Task 6: CLI 支持 --profile 参数
  - [ ] 6.1 在 `src/cli/index.tsx` 顶层 commander 添加 `.option("-p, --profile <id>", "Agent profile to load", "coding")`
  - [ ] 6.2 启动时调用 `getBuiltinProfile(profile)`；catch 后用红字提示并 `process.exit(1)`
  - [ ] 6.3 把 profile 传入 `createAgentFromProfile`；当 profile === "coding" 时仍走 `createCodingAgent`（保兼容）；其余 profile 走通用路径
  - [ ] 6.4 TUI header（`src/cli/tui/components/header.tsx`）展示 `Helixent · ${profileId}`

- [ ] Task 7: 单元测试
  - [ ] 7.1 新建 `src/agent/profiles/__tests__/create.test.ts`：T1 string prompt / T2 factory prompt / T3 factory tools / T4 middleware 装配 / T5 maxSteps 默认值
  - [ ] 7.2 新建 `src/agent/profiles/__tests__/registry.test.ts`：T1 注册 + 取 / T2 unknown 抛错带列表 / T3 listBuiltinProfiles 返回 ["coding","research"]
  - [ ] 7.3 新建 `src/coding/profiles/__tests__/research.test.ts`：T1 研究 profile tool 名集合断言（白名单匹配 / 黑名单不存在）/ T2 systemPrompt 含 "research" 关键词 / T3 不含 approval middleware
  - [ ] 7.4 新建 `src/coding/profiles/__tests__/coding-parity.test.ts`：T1 通过 profile 路径装配的 coding agent 与 `createCodingAgent` 行为一致（tool 名集合相等、prompt 包含相同关键词）

- [ ] Task 8: 验收
  - [ ] 8.1 跑 `bun run check`，确认 v0 全部 212 个原测试通过 + 新测试 ≥ 12 条通过
  - [ ] 8.2 手动跑 `bun run dev --profile research` 验证 TUI 启动 / header 显示 / 工具列表正确
  - [ ] 8.3 手动跑 `bun run dev --profile foo` 验证错误退出
  - [ ] 8.4 手动跑 `bun run dev`（默认 coding）验证向后兼容

# Task Dependencies

- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 depends on Task 1, Task 2, Task 3
- Task 5 depends on Task 1, Task 2, Task 3
- Task 6 depends on Task 4, Task 5
- Task 7 可与 Task 4 / 5 并行（针对 1/2/3 的子测试可在 3 完成后立即并行）
- Task 8 depends on all of above
