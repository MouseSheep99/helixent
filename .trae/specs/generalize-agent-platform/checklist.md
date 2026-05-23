# Verification Checklist

## Code structure

- [ ] `src/agent/profiles/types.ts` 导出 `AgentProfile` 接口，含 id/name/description/systemPrompt/tools/middlewareFactories/defaultMaxSteps/initialMessages 字段
- [ ] `src/agent/profiles/create.ts` 导出 `createAgentFromProfile()`，返回标准 `Agent` 实例
- [ ] `src/agent/profiles/registry.ts` 导出 `getBuiltinProfile` / `listBuiltinProfiles` / `registerBuiltinProfile`
- [ ] `src/coding/profiles/coding.ts` 导出 `codingProfile`，注册到 registry
- [ ] `src/coding/profiles/research.ts` 导出 `researchProfile`，注册到 registry

## Behavioral parity (coding)

- [ ] `createCodingAgent` 公开签名（参数列表 / 返回类型）未变
- [ ] 通过 `createCodingAgent` 装配的 agent 仍然加载 `AGENTS.md`（如存在）作为首条 user message
- [ ] coding agent tool 名集合包含 `bash, file_info, list_files, glob_search, grep_search, mkdir, move_path, read_file, write_file, str_replace, apply_patch, todo_write`（todo 工具命名以源码为准）
- [ ] 旧测试 212 个全部通过，无回归

## Research profile

- [ ] `getBuiltinProfile("research")` 返回的 tools **不**包含 `write_file / str_replace / apply_patch / mkdir / move_path`
- [ ] `getBuiltinProfile("research")` 返回的 tools 包含 `read_file / list_files / glob_search / grep_search / file_info / bash` 与 todo 工具
- [ ] research profile systemPrompt 包含明确的"只读 / 调研 / 不可写入"语义
- [ ] research profile 的 middleware 列表**不**包含 coding-approval middleware

## Registry

- [ ] `listBuiltinProfiles()` 返回数组至少含 `["coding", "research"]`
- [ ] `getBuiltinProfile("nonexistent")` 抛错，错误 message 包含 `Available:` 与已注册 id 列表

## CLI

- [ ] `helix --profile research` 能成功启动 TUI
- [ ] `helix --profile foo` 立即退出，stderr 含 `Unknown profile "foo"` 与可用列表
- [ ] `helix`（不带 profile）默认走 coding，行为与 v0 一致
- [ ] TUI header 显示当前 profile id（如 `Helixent · research`）

## Tests

- [ ] `bun run check` 全绿，pass 数 ≥ 224（v0 212 + 新增 ≥ 12）
- [ ] 新测试覆盖：profile create / registry / research 工具白名单 / coding parity
