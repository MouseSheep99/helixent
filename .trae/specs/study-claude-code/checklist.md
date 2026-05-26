# Checklist

- [x] `docs/study-claude-code/00-index.md` 存在，且包含覆盖全部 19 篇评论的四列映射总表（评论文件 / helixent 源码 / outline 章节 / 主题笔记编号）
- [x] `docs/study-claude-code/00-index.md` 顶部含 100 字左右导读，说明笔记目的与使用方式
- [x] `01-query-and-agent-loop.md` 存在，覆盖 01/03/08 三篇评论，对照 `src/agent/agent.ts`、`src/coding/agents/lead-agent.ts`，末尾启示 ≥3 条
- [x] `02-tools-and-permissions.md` 存在，覆盖 02/06/07 三篇，对照 `src/foundation/tools/*`、`src/coding/permissions/*`，末尾启示 ≥3 条
- [x] `03-context-and-compact.md` 存在，覆盖 10/11 两篇，明确与 outline §1.10 / §1.11 / §4 的对照关系，末尾启示 ≥3 条
- [x] `04-plugins-hooks-bridge.md` 存在，覆盖 04/05/13 三篇，明确对 MCP / sub-agent 的借鉴，末尾启示 ≥3 条
- [x] `05-session-startup-config.md` 存在，覆盖 09/12/16 三篇，对照 `src/cli/*` 与 config schema，末尾启示 ≥3 条
- [x] `06-ui-services-telemetry.md` 存在，覆盖 14/14b/15/17 四篇，对照 TUI / Web / trace，末尾启示 ≥3 条
- [x] 6 篇主题笔记每篇都遵循统一五段结构（Claude 做法 / 关键代码线索 / helixent 现状 / 差距与借鉴 / outline 关联）
- [x] 6 篇主题笔记末尾启示段每条都带 `[已纳入 §xx]` 或 `[v3 候选]` 标记
- [x] 全程零业务代码改动（仅在 `docs/study-claude-code/` 下新增 markdown）
- [x] 全程未修改 `.trae/documents/generalize-agent-platform-outline.md` 与既有 `generalize-agent-platform` spec
