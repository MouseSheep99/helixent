# Claude Code 学习笔记 · 索引

## 导读

本目录是基于 [`claude-reviews-claude`](https://github.com/openedclaude/claude-reviews-claude) 仓库 19 篇中文架构评论（已 clone 到 `/Users/bytedance/Documents/Codex/claude-reviews-claude`）整理的 helixent 二期借鉴笔记。每篇主题笔记按统一结构产出：**Claude 做法 → 关键代码线索 → helixent 现状 → 差距与借鉴判断 → 与 outline 章节关联**，末尾给出可执行启示。补充篇 `07-source-level-deep-dive.md` 进一步按源码文件、函数、状态机、调用链粒度重读这些评论中的源码坐标。**笔记仅作学习与对照之用，不修改任何业务代码**。配套阅读：`.trae/documents/generalize-agent-platform-outline.md`。

## 19 篇评论 ↔ helixent 源码 ↔ outline 章节 ↔ 主题笔记 总表

| # | 评论文件 | 覆盖主题 | helixent 对应代码 | 对应 outline 章节 | 主题笔记 |
|---|----------|----------|--------------------|--------------------|----------|
| 00 | `00-overview.md` | Claude Code 总体架构 | 全栈 | §0 / §1 | 01–06（贯穿） |
| 01 | `01-query-engine.md` | 主循环 / 异步生成器 / nO 引擎 | [`agent.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts) | §1, §1.10 | 01 |
| 02 | `02-tool-system.md` | 工具定义 / capability / executor | [`function-tool.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/foundation/tools/function-tool.ts), [`coding/tools/`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/tools/) | §2, §2.8 | 02 |
| 03 | `03-coordinator.md` | tt0 协调器 / querySource 来源贯穿 | [`agent.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts), [`lead-agent.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/agents/lead-agent.ts) | §1.10, §6 | 01 |
| 04 | `04-plugin-system.md` | plugin loader / marketplace | 暂无（社区扩展点缺失） | §5 | 04 |
| 05 | `05-hook-system.md` | hook 总线 / pre-/post-tool | [`agent-middleware.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent-middleware.ts) | §5 | 04 |
| 06 | `06-bash-engine.md` | bash 持久会话 / 输出截断 / 引用栈 | [`bash.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/tools/bash.ts) | §2.8 | 02 |
| 07 | `07-permission-pipeline.md` | 权限链 / 11 阶段流水线 / risk score | [`coding-approval-middleware.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/permissions/coding-approval-middleware.ts), [`requires-approval.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/permissions/requires-approval.ts) | §1.11, §2.8 | 02 |
| 08 | `08-agent-swarms.md` | sub-agent / Task 工具 / I2A 协调 | 暂无 | §6 | 01 |
| 09 | `09-session-persistence.md` | session 落盘 / replay / fork | 无（仅内存） | §5 (v3 候选) | 05 |
| 10 | `10-context-assembly.md` | system prompt 拼装 / AGENTS.md 注入 | [`lead-agent.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/agents/lead-agent.ts) | §1, §4 | 03 |
| 11 | `11-compact-system.md` | autocompact / microcompact / offload | [`agent.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts) | §4, §1.10 | 03 |
| 12 | `12-startup-bootstrap.md` | 启动序列 / lazy init | [`cli/index.tsx`](file:///Users/bytedance/Documents/Codex/helixent/src/cli/index.tsx), [`cli/bootstrap/`](file:///Users/bytedance/Documents/Codex/helixent/src/cli/bootstrap/) | §3 | 05 |
| 13 | `13-bridge-system.md` | bridge / IPC / fork 隔离 | 暂无 | §6 | 04 |
| 14 | `14-ui-state-management.md` | UI store / 选择器 / 不可变 | [`tui/app.tsx`](file:///Users/bytedance/Documents/Codex/helixent/src/cli/tui/app.tsx), [`tui/hooks/`](file:///Users/bytedance/Documents/Codex/helixent/src/cli/tui/hooks/) | §3.1 | 06 |
| 14b | `14-ui-state-rendering.md` | 渲染层 / Ink / 节流 | [`tui/components/`](file:///Users/bytedance/Documents/Codex/helixent/src/cli/tui/components/), [`message-text.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/cli/tui/message-text.ts) | §3.1 | 06 |
| 15 | `15-services-api-layer.md` | services / API 抽象 / 重试 | [`community/anthropic/`](file:///Users/bytedance/Documents/Codex/helixent/src/community/anthropic/), [`community/openai/`](file:///Users/bytedance/Documents/Codex/helixent/src/community/openai/) | §3.1 | 06 |
| 16 | `16-infrastructure-config.md` | config schema / 环境层级 | [`cli/config/schema.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/cli/config/schema.ts), [`cli/settings/`](file:///Users/bytedance/Documents/Codex/helixent/src/cli/settings/) | §5 | 05 |
| 17 | `17-telemetry-privacy-operations.md` | 遥测 / 隐私 / 运营开关 | 暂无 | §3.1 (v3 候选) | 06 |

> 列「主题笔记」对应本目录的 `01-…`～`06-…` 文件编号。

## 源码级补充

- [07-source-level-deep-dive.md](file:///Users/bytedance/Documents/Codex/helixent/docs/study-claude-code/07-source-level-deep-dive.md)：按 `QueryEngine/query/Tool/runToolUse/Bash/Permission/Compact/Session/Bridge/UI/API` 的源码文件、函数、状态机和调用链重读 Claude Code 评论，并给出 helixent P0/P1/P2/P3 迁移落点。
- [08-real-source-backed-deep-dive.md](file:///Users/bytedance/Documents/Codex/helixent/docs/study-claude-code/08-real-source-backed-deep-dive.md)：基于 `/Users/bytedance/Documents/Codex/claude-code-analysis/src` 真实源码行号，补充 `QueryEngine.submitMessage()`、`queryLoop()`、`Tool`、`hasPermissionsToUseToolInner()`、`BashTool`、`compactConversation()`、`MCPServerConnection` 等源码级证据。
