# Tasks

- [x] Task 1: 建立 `docs/study-claude-code/` 学习笔记目录与索引文件
  - [x] SubTask 1.1: 创建 `docs/study-claude-code/00-index.md`，建立「评论文件 ↔ helixent 源码 ↔ outline 章节 ↔ 主题笔记编号」四列总表，覆盖全部 19 篇评论
  - [x] SubTask 1.2: 在 `00-index.md` 顶部加一段 100 字左右导读，说明笔记目的、使用方式、与 outline 的关系

- [x] Task 2: 输出主题笔记 01 - Query & Agent Loop（依据 01/03/08）
  - [x] SubTask 2.1: 通读 `claude-reviews-claude/architecture/zh-CN/01-query-engine.md`、`03-coordinator.md`、`08-agent-swarms.md`
  - [x] SubTask 2.2: 对照 `src/agent/agent.ts`、`src/coding/agents/lead-agent.ts` 标注现状
  - [x] SubTask 2.3: 写 `01-query-and-agent-loop.md`，按统一结构（Claude 做法 / 代码线索 / helixent 现状 / 差距与借鉴 / outline 关联）输出，末尾给出 ≥3 条具体启示（标 `[已纳入 §xx]` 或 `[v3 候选]`）

- [x] Task 3: 输出主题笔记 02 - Tools & Permissions（依据 02/06/07）
  - [x] SubTask 3.1: 通读 `02-tool-system.md`、`06-bash-engine.md`、`07-permission-pipeline.md`
  - [x] SubTask 3.2: 对照 `src/foundation/tools/*`、`src/coding/permissions/*`、`src/agent/tool-result-policy.ts` 标注现状
  - [x] SubTask 3.3: 写 `02-tools-and-permissions.md`，遵循统一结构与启示要求

- [x] Task 4: 输出主题笔记 03 - Context & Compact（依据 10/11）
  - [x] SubTask 4.1: 通读 `10-context-assembly.md`、`11-compact-system.md`
  - [x] SubTask 4.2: 对照 `src/agent/context-offload-middleware.ts`（若有）及 outline §1.10 / §1.11 / §4 章节
  - [x] SubTask 4.3: 写 `03-context-and-compact.md`，遵循统一结构与启示要求

- [x] Task 5: 输出主题笔记 04 - Plugins, Hooks & Bridge（依据 04/05/13）
  - [x] SubTask 5.1: 通读 `04-plugin-system.md`、`05-hook-system.md`、`13-bridge-system.md`
  - [x] SubTask 5.2: 对照 outline §5（MCP）与 §6（sub-agent / coordinator）章节及 helixent 现有 `src/community/`（若有）
  - [x] SubTask 5.3: 写 `04-plugins-hooks-bridge.md`，遵循统一结构与启示要求

- [x] Task 6: 输出主题笔记 05 - Session, Startup & Config（依据 09/12/16）
  - [x] SubTask 6.1: 通读 `09-session-persistence.md`、`12-startup-bootstrap.md`、`16-infrastructure-config.md`
  - [x] SubTask 6.2: 对照 `src/cli/index.tsx`、`src/cli/config/*`、helixent 启动流程
  - [x] SubTask 6.3: 写 `05-session-startup-config.md`，遵循统一结构与启示要求

- [x] Task 7: 输出主题笔记 06 - UI, Services & Telemetry（依据 14/14b/15/17）
  - [x] SubTask 7.1: 通读 `14-ui-state-management.md`、`14-ui-state-rendering.md`、`15-services-api-layer.md`、`17-telemetry-privacy-operations.md`
  - [x] SubTask 7.2: 对照 helixent `src/cli/tui/*`、`web/*`、trace 体系
  - [x] SubTask 7.3: 写 `06-ui-services-telemetry.md`，遵循统一结构与启示要求

- [x] Task 8: 收口校验
  - [x] SubTask 8.1: 回填 `00-index.md` 的「主题笔记编号」列，确保 19 篇评论每篇都指向某个主题笔记
  - [x] SubTask 8.2: 抽样检查 6 篇主题笔记末尾启示段是否各 ≥3 条，是否每条都带 `[已纳入 §xx]` 或 `[v3 候选]` 标记

# Task Dependencies

- Task 2 / 3 / 4 / 5 / 6 / 7 可并行（无相互依赖，仅共享 `00-index.md` 草表）
- Task 1 必须先于 Task 8（索引先存在再回填）
- Task 8 必须最后执行（依赖 Task 2–7 全部完成）
