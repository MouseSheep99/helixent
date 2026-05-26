# Study Claude Code Spec

## Why

二期 `generalize-agent-platform` 大纲已大量引用 `claude-reviews-claude` 仓库（19 篇中文架构评论），但目前我对 Claude Code 内部机制的理解**只是片段化对照**，没有形成系统认知。继续展开 spec / 落地实施前，需要**一次系统化学习**：把 19 篇评论吃透、对照 `helixent` 源码标注差距、为后续每条改造决策建立可追溯的依据。

本 spec 的产物**只是学习笔记**（docs 目录下的 markdown），不动任何业务代码。

## What Changes

* **新增** `docs/study-claude-code/` 学习笔记目录（在 helixent 仓内，便于跟代码一起 review）
* **新增** 一份模块对照总表 `00-index.md`，列出 19 篇评论与 helixent 源码模块的映射关系 + 每篇笔记的「关键概念 / 借鉴价值 / 当前落点」三栏
* **新增** 6 篇主题学习笔记，按照与 helixent 改造关系的紧迫度分组：
  1. `01-query-and-agent-loop.md`：query engine（01）+ coordinator（03）+ agent swarms（08）→ helixent `Agent` / `AgentSession`
  2. `02-tools-and-permissions.md`：tool system（02）+ permission pipeline（07）+ bash engine（06）→ helixent `defineTool` / approval middleware
  3. `03-context-and-compact.md`：context assembly（10）+ compact system（11）→ helixent `ContextOffloadMiddleware` 二期方案
  4. `04-plugins-hooks-bridge.md`：plugin（04）+ hook（05）+ bridge（13）→ helixent MCP 接入与 sub-agent 委派
  5. `05-session-startup-config.md`：session persistence（09）+ startup（12）+ infra config（16）→ helixent CLI / config schema
  6. `06-ui-services-telemetry.md`：UI state（14/14b）+ services API（15）+ telemetry（17）→ helixent TUI / Web / trace
* **不**做：源码迁移、生成 PR、跑测试、修改 outline 或既有 spec

## Impact

* Affected specs：仅与既有 `generalize-agent-platform` outline **互为参考**（笔记里允许引用 outline 章节号），不修改 outline 本身
* Affected code：**零代码改动**，只新增 7 个 markdown 文件
* Affected docs：`docs/study-claude-code/*.md`（新增）

## ADDED Requirements

### Requirement: Study notes directory

系统 SHALL 在 `docs/study-claude-code/` 下沉淀 Claude Code 学习笔记，作为后续 spec / 实施的知识底座。

#### Scenario: Notes are markdown only
- **WHEN** 学习产出落盘
- **THEN** 仅在 `docs/study-claude-code/` 下创建 `.md` 文件，不创建任何其他类型文件，不修改业务代码

### Requirement: Module mapping index

笔记 SHALL 提供一份 `00-index.md`，建立 19 篇评论 ↔ helixent 源码 ↔ generalize-agent-platform outline 的三向映射表。

#### Scenario: Each review is mapped
- **WHEN** 检查 `00-index.md`
- **THEN** 19 篇评论每篇都有对应行，列出：评论文件名、覆盖主题、对应 helixent 源码路径（若有）、对应 outline 章节号（若有）、所属学习笔记编号

### Requirement: Six thematic notes

笔记 SHALL 按 6 个主题各产出一篇深度笔记（编号 01–06），每篇遵循统一结构：**Claude 做法 → 关键代码线索 → helixent 现状 → 差距与借鉴判断 → 与 outline 章节关联**。

#### Scenario: Note 01 covers query/agent loop
- **WHEN** 阅读 `01-query-and-agent-loop.md`
- **THEN** 涵盖 query engine（01）、coordinator（03）、agent swarms（08）三篇，并明确指出对 helixent `src/agent/agent.ts`、`src/coding/agents/lead-agent.ts` 的借鉴点

#### Scenario: Note 02 covers tools/permissions
- **WHEN** 阅读 `02-tools-and-permissions.md`
- **THEN** 涵盖 tool system（02）、permission pipeline（07）、bash engine（06）三篇，并对照 `src/foundation/tools/*`、`src/coding/permissions/*`

#### Scenario: Note 03 covers context/compact
- **WHEN** 阅读 `03-context-and-compact.md`
- **THEN** 涵盖 context assembly（10）、compact system（11）两篇，并明确与 outline §1.10 / §1.11 / §4 章节的对照关系

#### Scenario: Note 04 covers plugins/hooks/bridge
- **WHEN** 阅读 `04-plugins-hooks-bridge.md`
- **THEN** 涵盖 plugin（04）、hook（05）、bridge（13）三篇，并明确对 helixent MCP 接入与 sub-agent 委派的借鉴点

#### Scenario: Note 05 covers session/startup/config
- **WHEN** 阅读 `05-session-startup-config.md`
- **THEN** 涵盖 session persistence（09）、startup bootstrap（12）、infra config（16）三篇，并对照 `src/cli/*`、配置 schema

#### Scenario: Note 06 covers UI/services/telemetry
- **WHEN** 阅读 `06-ui-services-telemetry.md`
- **THEN** 涵盖 UI state（14、14b）、services API（15）、telemetry（17）四篇，并对照 helixent TUI、Web、trace

### Requirement: Each note has actionable takeaway

每篇主题笔记 SHALL 在末尾给出一段「**对 helixent 二期的具体启示**」，至少 3 条 bullet，每条标明：是否已纳入 outline、若纳入对应章节号、若未纳入给出 v3 候选标记。

#### Scenario: Takeaway is concrete
- **WHEN** 检查任一主题笔记末尾段
- **THEN** 启示 bullet 形如「`[已纳入 §1.10]` AgentSession.querySource 贯穿（参考 03-coordinator §3.2）」或「`[v3 候选]` 跨 session 持久化记忆（参考 09-session-persistence §4）」

## MODIFIED Requirements

无（不修改既有 spec / outline / 代码）。

## REMOVED Requirements

无。
