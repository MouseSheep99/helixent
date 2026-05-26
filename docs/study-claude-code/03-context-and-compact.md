# 03 · 上下文装配与压缩系统

> 对照阅读：
> - `claude-reviews-claude/architecture/zh-CN/10-context-assembly.md`
> - `claude-reviews-claude/architecture/zh-CN/11-compact-system.md`
>
> 配套 outline 章节（重点）：
> - `.trae/documents/generalize-agent-platform-outline.md` §1（背景与五道结构性门槛）
> - `.trae/documents/generalize-agent-platform-outline.md` §1.10（AgentSession + querySource）
> - `.trae/documents/generalize-agent-platform-outline.md` §1.11（拒绝熔断器）
> - `.trae/documents/generalize-agent-platform-outline.md` §4（Offload & Compact 全部）
> - `.trae/documents/generalize-agent-platform-outline.md` §6（验收基线）

---

## 1. 概述

Claude Code 在每一次 API 调用之前都会**装配多层上下文**（system prompt、AGENTS.md/CLAUDE.md 记忆、附件、工具/技能定义），并通过**多层压缩流水线**（micro / session-memory / full）维持"无限对话"幻觉。这是它能稳定跑长会话的根因，也是 helixent 当前最大的能力空缺。

本笔记把两篇评论拆成两条线索：

1. **上下文装配（10-context-assembly）**：身份层（system prompt）+ 记忆层（CLAUDE.md 多源合并）+ 附件层（每轮临时注入）的"三层 + 动态边界"模型，配合 `lodash/memoize`、附件 1s 超时、`@include` 递归这些工程细节。
2. **压缩系统（11-compact-system）**：**微压缩**（每轮删除冷工具结果，可走 `cache_edits` 不破坏前缀缓存）→ **会话记忆压缩**（用后台预建摘要替换历史）→ **完整压缩**（LLM 摘要 + 9 段模板 + `<analysis>` 草稿本 + PostCompact 恢复）；外加 4 档 token 状态机、连续 3 次熔断、API 不变量保护、递归防护、PTL 重试等安全网。

helixent 的现状是：`Agent.messages` 只增不减；`prompt` 是单条字符串；AGENTS.md 仅在装配期一次性塞入首条 user message；没有任何压缩 / offload / 阈值告警。这意味着只要会话稍长就会撞模型上限。outline §4 把 L0 Offload + L1 Microcompact + L4 Manual `/compact` 列为 MVP 必做；§1.10/§1.11 则是为了给 §4 提供"宿主对象"和"安全网"才被新增。

---

## 2. Claude 做法

### 2.1 Context Assembly（评论 10）

#### 2.1.1 三层结构与缓存边界

| 层级 | 来源 | 生命周期 | 缓存策略 |
|------|------|----------|----------|
| **System Prompt** | `getSystemPrompt()` | 每会话 | 在 `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` 处分割：静态前缀 `scope: 'global'` 跨组织共享；动态后缀按会话 |
| **User/System Context** | `getUserContext()` + `getSystemContext()` | 每会话 | `lodash/memoize` —— Git 状态等只在会话开始计算一次 |
| **Attachments** | `getAttachments()` | 每轮 | 每轮重算，1 秒超时 |

#### 2.1.2 System Prompt 组装顺序

静态段落（可跨组织缓存）：身份、系统规则、任务执行、操作审慎、工具使用、语气风格、输出效率。
动态段落（按会话）：Fork agent 指令 / 技能发现 / 验证 agent 契约 → CLAUDE.md → 环境（model/cwd/platform/git） → 语言 → MCP 指令 → 草稿本路径 → Token 预算。

优先级链是**替换链**，不是合并：
```
overrideSystemPrompt > coordinatorMode > agentDefinition > customSystemPrompt > default sections
+ appendSystemPrompt 始终追加到末尾
```

#### 2.1.3 AGENTS.md / CLAUDE.md 注入

记忆系统是最复杂的子系统（`claudemd.ts` 1480 行），加载顺序按"低 → 高优先级"递增：

```
Managed   /etc/claude-code/CLAUDE.md       ← 组织策略
User      ~/.claude/CLAUDE.md              ← 个人全局
Project   CLAUDE.md, .claude/CLAUDE.md     ← 仓库签入（CWD → 根目录遍历）
Local     CLAUDE.local.md                  ← 个人项目（gitignore）
AutoMem   ~/.claude/memory/MEMORY.md       ← agent 自管
TeamMem   shared team memory               ← 组织同步
```

关键工程点：
- **目录向上遍历**：从 CWD 一路 `dirname()` 到根，离 CWD 越近后加载、优先级越高。
- **`@include` 递归**：`@./path.md` / `@~/path.md` / `@/abs.md`，最大深度 5，`processedPaths` 防循环。
- **frontmatter glob 门控**：`.claude/rules/*.md` 用 `paths:` 字段限制只在动到匹配文件时注入。
- **内容处理管线**：`parseFrontmatter → stripHtmlComments → truncateEntrypointContent → 标记 contentDiffersFromDisk`。
- **二进制保护**：100+ 文本扩展名白名单。

#### 2.1.4 Skills 接入

技能在装配期作为**动态附件 + system prompt 段落**双路注入：
- `skill_listing` / `skill_discovery` 附件按需出现。
- 已调用 skill 通过 `STATE.invokedSkills`（键 `${agentId ?? ''}:${skillName}`）保留，**压缩后仍可恢复**。
- 复合键防止跨 agent 的 skill 同名覆写。

#### 2.1.5 Attachments：30+ 类型 / 提醒系统 / 1s 超时

```typescript
const abortController = createAbortController()
const timeoutId = setTimeout(ac => ac.abort(), 1000, abortController)
```

提醒类附件用轮次调度避免每轮重复注入：

```typescript
TODO_REMINDER_CONFIG = { TURNS_SINCE_WRITE: 10, TURNS_BETWEEN_REMINDERS: 10 }
PLAN_MODE_ATTACHMENT_CONFIG = { TURNS_BETWEEN_ATTACHMENTS: 5, FULL_REMINDER_EVERY_N_ATTACHMENTS: 5 }
```

### 2.2 Compact System（评论 11）

#### 2.2.1 三层压缩

| 层 | 机制 | 触发 | 压缩量 | Cache 影响 |
|----|------|------|--------|-----------|
| **Microcompact** | 清除旧工具结果 | 每轮（时间 / 数量） | ~10–50K | 保留（cache_edits）或重建（直清） |
| **Session Memory** | 用预建摘要替换历史 | 自动压缩阈值 | 60–80% | 失效，但无 LLM 调用 |
| **Full Compact** | LLM 摘要整段对话 | 自动 / `/compact` | 80–95% | 失效，1 次 API 调用 |

#### 2.2.2 Microcompact 两条路径

- 候选工具集：`COMPACTABLE_TOOLS = { FILE_READ, SHELL, GREP, GLOB, WEB_SEARCH, WEB_FETCH, FILE_EDIT, FILE_WRITE }`。
- **路径 A（冷缓存）**：超过时间阈值 → 直接修改本地 messages，把旧工具结果替换成 `[Old tool result content cleared]`。
- **路径 B（热缓存，Ant 内部）**：保留本地 messages，把删除指令编码为 `cache_edits` 块，由 API 层注入 → 服务器端缓存副本删除而不破坏前缀。

#### 2.2.3 Full Compact 流水线

```
1. PreCompact 钩子
2. stripImagesFromMessages
3. stripReinjectedAttachments（移除 skill_discovery / skill_listing）
4. streamCompactSummary（带 PTL 重试）
5. formatCompactSummary（剥离 <analysis>，保留 <summary>）
6. 清除文件状态缓存（readFileState.clear）
7. PostCompact Recovery：
   - 最近读取 5 个文件（50K 预算 / 每文件 5K）
   - 已调用技能（25K 预算 / 每技能 5K）
   - 活跃计划 / plan-mode 指令
   - deferred_tools_delta / agent_listing_delta / mcp_instructions_delta
8. SessionStart 钩子重新跑
9. PostCompact 钩子
10. 重新追加会话元数据（保持 16KB 尾部窗口）
```

9 段摘要模板：主要请求与意图 / 关键技术概念 / 文件与代码段 / 错误与修复 / 问题解决 / 所有用户消息 / 待办任务 / 当前工作 / 可选下一步（含原文引用）。`<analysis>` 块在注入前被剥离，**给模型一个"大声思考"的草稿本，但不污染压缩后上下文**。

#### 2.2.4 安全网

- **自动压缩阈值**：`effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS(13_000)`；以 200K 模型为例约 167K 触发。
- **4 档状态机**：`isAboveWarningThreshold` / `isAboveErrorThreshold` / `isAboveAutoCompactThreshold` / `isAtBlockingLimit`，分别在 effectiveWindow − 20K / − 20K / − 13K / − 3K，超过 blocking 时禁止用户输入只允许 `/compact`。
- **熔断器**：`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`（评论引数据：BQ 2026-03-10 全球每天 250K 次浪费 API 调用）。
- **递归防护**：`querySource === 'compact' || 'session_memory' || 'marble_origami'` 一律不触发自动压缩。
- **API 不变量保护**：`adjustIndexToPreserveAPIInvariants()`（80+ 行），保证 `tool_use` ↔ `tool_result` 不被拆开 + 同 `message.id` 流式 chunks 一起保留。
- **PTL 重试**：摘要请求自身撞 prompt-too-long 时按 API 轮组从头丢弃，最多 3 次。

#### 2.2.5 Partial Compact 方向

| 方向 | 摘要部分 | 保留部分 | Cache |
|------|---------|---------|-------|
| `'from'` | 枢轴之后 | 更早 | **保留**（保留段是前缀） |
| `'up_to'` | 枢轴之前 | 更晚 | **失效** |

---

## 3. 关键代码线索

> 这些是后续实施 §4 时直接对照 / 移植的"原型坐标"。

| 机制 | Claude Code 文件 | 函数 / 常量 | helixent 落点 |
|------|------------------|-------------|--------------|
| 系统提示词动态边界 | `prompts.ts` | `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` | outline §1.12 B1.1 — `AgentProfile.systemPrompt` 升级为 `{ global, dynamic }` |
| `@include` 递归 | `claudemd.ts` | `MAX_INCLUDE_DEPTH = 5`, `processedPaths` | outline §1.12 B1.3 — `src/agent/skills/skill-reader.ts` 复用 |
| 附件 1s 超时 | `attachments.ts` | `setTimeout(ac => ac.abort(), 1000, ac)` | outline §1.12 B1.5 — todo / plan 提醒中间件 |
| Memoize Git 状态 | `context.ts` | `lodash/memoize` + `resetGetMemoryFilesCache('compact')` | §4.14.7/§4.14.8 — PostCompact `readFileState.clear` 等价 hook |
| Microcompact 候选 | `microCompact.ts` | `COMPACTABLE_TOOLS` 集合 | outline §4.5.1 候选规则（保守版：仅 read_fs） |
| 时间触发 MC | `timeBasedMCConfig.ts` | `evaluateTimeBasedTrigger` | outline §4.14.1 `staleAfterMs` |
| `cache_edits` API 层 | `apiMicrocompact.ts` | `createCacheEditsBlock` | outline §4.5.3 `emitCacheEdits` hook（v0 OpenAI 路径放空，给未来 anthropic 直连预留） |
| **API 不变量保护** | `sessionMemoryCompact.ts` | `adjustIndexToPreserveAPIInvariants` | **outline §4.14.2 `adjustBoundaryToPreserveInvariants`（必须采纳）** |
| 9 段摘要模板 | `prompt.ts` | 9 段 + `<analysis>` 草稿本 | outline §4.14.9 升级到 8 段（去掉 Claude 的"完整代码片段"，因 helixent 直接 offload） |
| 4 档 token 状态机 | `autoCompact.ts` | `calculateTokenWarningState` | outline §4.14.6 `TokenWarningState` |
| 熔断器 | `autoCompact.ts` | `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` | outline §4.14.3 `MAX_CONSECUTIVE_COMPACT_FAILURES` + §1.11 `REJECTION_LIMITS.consecutive=3` |
| 递归防护 | `autoCompact.ts` | `if (querySource === 'compact' \|\| 'session_memory') return false` | **outline §1.10 querySource 元数据 + §4.14.4 `compactInProgress`** |
| PostCompact Recovery | `compact.ts` | 50K 文件预算 / 25K 技能预算 / delta 注入 | outline §4.14.7 `restoreContextAfterCompact` |
| PostCompact Cleanup | `postCompactCleanup.ts` | `readFileState.clear()` | outline §4.14.8 `compact:done` 事件钩子 |
| 已调用技能复合键 | `STATE.invokedSkills` | `${agentId ?? ''}:${skillName}` | outline §4.15 B4.10 — recovery `buildActiveSkillsMessage` |
| API 轮次分组 | `grouping.ts` | `groupMessagesByApiRound` | outline §4.14.11（PTL 重试 v3） |

---

## 4. helixent 现状

### 4.1 Context Assembly 现状

**Code Reference**：[`src/coding/agents/lead-agent.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/agents/lead-agent.ts#L48-L101)

```48:101:src/coding/agents/lead-agent.ts
const agentsFile = Bun.file(`${cwd}/AGENTS.md`);
const messages: NonSystemMessage[] = [];
if (await agentsFile.exists()) {
  const agentsFileContent = await agentsFile.text();
  messages.push({
    role: "user",
    content: [{ type: "text", text: "> The `AGENTS.md` file has been automatically loaded. Here is the content:\n\n" + agentsFileContent }],
  });
}
...
return new Agent({
  prompt: `<agent name="Helixent" ...>...</agent>
<working_directory dir="${cwd}/" />
<tool_usage>...</tool_usage>
<notes>...</notes>`,
  messages,
  ...
});
```

观察点：
- **AGENTS.md 仅在装配期读一次**，作为首条 user message 注入；没有目录遍历、没有多源合并、没有 frontmatter。
- **system prompt 是单条字符串字面量**，无静态/动态分段，无缓存边界标记。
- **没有"附件"概念**：todo / plan / git 状态都没有按轮注入机制。

**Code Reference**：[`src/agent/skills/skills-middleware.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/skills/skills-middleware.ts#L70-L114)

```70:114:src/agent/skills/skills-middleware.ts
beforeModel: async ({ modelContext, agentContext }) => {
  if (agentContext.skills && agentContext.skills.length > 0) {
    ...
    return {
      prompt: modelContext.prompt + `\n<skill_system>...<skills>${skillsXML}</skills></skill_system>`,
    };
  }
}
```

观察点：
- skills 注入是**每轮 prepend 到 prompt 末尾**（不是 system 段落，不是附件）。
- 已调用 skill 没有保留状态，压缩后无法恢复（仍是 v0 不存在压缩的事实）。

### 4.2 Compact 现状

**Code Reference**：[`src/agent/agent.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L173-L205)

```173:205:src/agent/agent.ts
private async *_think(): AsyncGenerator<AgentEvent, AssistantMessage> {
  const modelContext: ModelContext = {
    prompt: this.prompt,
    messages: this.messages,    // ← 直接透传全量 messages，无压缩
    tools: this.tools,
    signal: this._abortController?.signal,
  };
  ...
}
```

**Code Reference**：[`src/agent/agent.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L274-L276)

```274:276:src/agent/agent.ts
private _appendMessage(message: NonSystemMessage) {
  this.messages.push(message);   // ← 只增不减
}
```

观察点：
- `messages` 数组**只 push 不裁剪**；`_think()` 直接把全量数组喂给 model。
- 没有 token 估算、没有阈值检查、没有 `/compact` slash command、没有 ContextStore。
- Tool 失败只在 [`agent.ts#L235-L238`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L235-L238) catch 后塞为 `Error: ${message}` 字符串；模型可能反复重试同一被拒工具，没有熔断。

---

## 5. 差距与借鉴判断

| 维度 | Claude Code | helixent | 差距 | 借鉴判断 |
|------|-------------|----------|------|----------|
| System prompt 分段 | 静态 + 动态边界 + scope 缓存 | 单字符串字面量 | 大 | ⭐⭐ MVP（outline §1.12 B1.1） |
| AGENTS.md 多源 + 目录遍历 | 6 层 + 自下而上 | 仅 cwd 单文件 | 中 | ⭐ 可选（outline §1.12 B1.2） |
| `@include` 递归 | 深度 5 + 循环防护 | 无 | 中 | ⭐ 可选（outline §1.12 B1.3） |
| Attachments 系统 | 30+ 类型 + 1s 超时 + 轮次提醒 | 无 | 大 | ⭐ todo 提醒先做（outline §1.12 B1.5） |
| 已调用 skill 压缩后保留 | `${agentId}:${skillName}` 复合键 | 无（也无压缩） | — | ⭐ 与 §4.14.7 一起做 |
| **Microcompact** | 候选工具集 + cache_edits + 时间触发 | 无 | 大 | ⭐⭐⭐ **必做**（outline §4.5 + §4.14.1） |
| **API 不变量保护** | `adjustIndex…` 80+ 行 | 无 | 大 | ⭐⭐⭐ **必做**（outline §4.14.2） |
| **L0 Offload 无损搬家** | 部分（cache_edits 分流） | 无 | 大 | ⭐⭐⭐ **必做**（outline §4.4 飞书设计原则） |
| **L4 Manual `/compact`** | `compactConversation` 完整管线 | 无 | 大 | ⭐⭐⭐ **必做**（outline §4.6） |
| 9 段摘要 + `<analysis>` 草稿本 | 是 | — | — | ⭐⭐ MVP（outline §4.14.9 升 8 段） |
| PostCompact Recovery | 7 类内容注入 | — | — | ⭐⭐⭐ **必做**（outline §4.14.7） |
| 4 档 token 状态机 | 是 | 无 | 大 | ⭐⭐ MVP（outline §4.14.6） |
| 熔断器（连续 3 次） | autocompact 失败 3 次禁用 | 无 | 中 | ⭐⭐⭐ **必做**（outline §4.14.3 + §1.11） |
| **递归防护 querySource** | `'compact' / 'session_memory' / 'marble_origami'` | 无 model.invoke metadata | 大 | ⭐⭐⭐ **必做**（outline §1.10 + §4.14.4） |
| 拒绝熔断 | 评论 11 未直述，但与 7-permission 一致：连续拒绝触发回退 | approval 拒绝只塞 `Error: ...` 字符串 | 大 | ⭐⭐⭐ **必做**（outline §1.11，依据见下文） |
| Session Memory 后台摘要 | 是 | 无 | — | ⏳ v3（outline §4.13） |
| Autocompact（自动 LLM 摘要） | 是 | 无 | — | ⏳ v3 |
| Partial Compact `'from' / 'up_to'` | 是 | 无 | — | ⏳ v3（outline §4.14.10） |
| PTL 重试 | 3 次按 API 轮组截断 | 无 | — | ⏳ v3（outline §4.14.11） |
| `cache_edits` API 集成 | Anthropic 内部 | OpenAI 兼容路径无对应 | — | hook 预留（outline §4.5.3） |

---

## 6. 与 outline 章节关联

### 6.1 §1.10 AgentSession + querySource — 来源依据

**为什么 outline 要新增 §1.10？** 因为评论 11 中的两个机制都依赖一个"会话级宿主对象"才能干净落地：

1. **递归防护**（评论 11 §"递归防护"）：
   > `if (querySource === 'session_memory' || querySource === 'compact') return false`
   >
   要让 microcompact 中间件能在压缩自身的 `model.invoke` 期间**自动让路**，必须给每次 model 调用打上 `source` 标签。helixent 当前 [`agent.ts#L181-L186`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L181-L186) 构造的 `ModelContext` 没有 metadata 字段，所以 outline §1.10.2 给 `ModelInvokeMetadata` 加了 `{ source, sessionId, parentSessionId }` 三元组。

2. **跨回合状态宿主**（评论 11 §"自动压缩触发逻辑"）：
   > `consecutiveAutocompactFailures` / `compactInProgress` 这些字段在 Claude Code 是会话级状态。
   >
   helixent 的 [`Agent`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L48-L361) 类**只承载回合级状态**（messages / streaming / abortController），没有清晰的"会话宿主"。如果硬塞到 Agent 字段，会破坏一期 212 测试的"Agent 类零修改"承诺。outline §1.10.1 因此引入 `AgentSession` 作为外部宿主，承载 `usage / contextStore / rejection / consecutiveCompactFailures / compactInProgress / currentSource`。

3. **重试矩阵分类**（来自评论 15 services-api，与压缩相关）：前台/后台 query 的 529 重试白名单需要 `querySource` 来分流，避免 compact 调用被反复放大。outline §1.10.2 顺手把这个能力打通。

**因此 §1.10 不是凭空加的章节，而是 §4 落地的前置宿主**：

- §4.14.4 递归防护直接读 `session.currentSource`。
- §4.14.3 熔断计数器存放在 `session.consecutiveCompactFailures`。
- §4.4.2 ContextStore 装在 `session.contextStore` 上（一会话一 store，进程退出即丢，符合 MVP 的内存版定位）。

### 6.2 §1.11 拒绝熔断器 — 来源依据

**为什么 outline 要新增 §1.11？** 来源是评论 11（autocompact 熔断思路）+ 评论 7（permission-pipeline 拒绝循环数据）的合流：

1. 评论 11 给出了"连续 N 次失败 → 关停昂贵操作"的工程模板（`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`，BQ 数据印证）。
2. 评论 7 描述了 Claude Code 在 permission pipeline 中对**反复拒绝同一工具**的截断处理。
3. helixent 现状是 [`agent.ts#L235-L238`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L235-L238) 把任何工具异常（含 approval 中间件返回的 `Error: Tool use rejected by user`）塞成字符串，模型看到后**很可能立即用相同参数重试**，把 token 烧光。

outline §1.11 把这两条合并为统一阈值：

```typescript
REJECTION_LIMITS = { consecutive: 3, total: 20 }
```

- **连续 3 次** → 强制终止（与 Claude Code 的 autocompact 熔断同档）。
- **单 session 累计 20 次** → 兜底，防止"拒绝 → 接受 → 再拒绝"的拉锯把状态消耗殆尽。
- 状态字段挂在 `session.rejection`（依赖 §1.10）。
- 只在 [`agent.ts:stream()`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L140-L171) 的每步开头加一个 `if (session?.rejection.tripped) { yield systemNote(...); return; }`，是除 §4 外**唯一**会动 `agent.ts` 的地方。

### 6.3 §4 全部对应

| outline §4 子节 | 评论 11 章节 | 评论 10 章节 |
|----------------|--------------|--------------|
| §4.1 概念区分（Offload / Microcompact / SessionMemory / Autocompact / Manual） | "三层压缩架构"表 | — |
| §4.4 L0 Offload | （飞书原则补充，评论 11 cache_edits 是其工程范式） | — |
| §4.5 L1 Microcompact | "第一层：微压缩" + 候选工具集 | — |
| §4.6 L4 Manual `/compact` | "第三层：完整压缩"流水线 + 9 段摘要 | "组装流水线"步骤 4 normalizeMessagesForAPI |
| §4.7 ThresholdPolicy | "自动压缩触发逻辑" + 4 档告警状态 | — |
| §4.8 Trace Events | （评论 11 无直接对应，飞书"观测指标"） | — |
| §4.14.1 时间触发微压缩 | `timeBasedMCConfig.ts` | — |
| §4.14.2 API 不变量保护 | `adjustIndexToPreserveAPIInvariants` 80+ 行 | — |
| §4.14.3 熔断器 | `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` | — |
| §4.14.4 递归防护 | `querySource` 拦截 | — |
| §4.14.5 `<analysis>` 草稿本 | `formatCompactSummary` 剥离 | — |
| §4.14.6 4 档 token 状态机 | `calculateTokenWarningState` | — |
| §4.14.7 PostCompact Recovery | "压缩后恢复"7 类内容 | "已调用 Skill 保留" `STATE.invokedSkills` |
| §4.14.8 postCompactCleanup hook | `postCompactCleanup.ts` `readFileState.clear` | "记忆文件变更检测" `contentDiffersFromDisk` |
| §4.14.9 9 段摘要模板（升级到 8 段） | `prompt.ts` 9 段 | — |
| §4.14.10 Partial Compact 方向 | `partialCompactConversation` `'from'/'up_to'` | — |
| §4.14.11 PTL 重试 | `truncateHeadForPTLRetry` | — |
| §4.15 B4.10 已调用技能复合键 recovery | — | `STATE.invokedSkills = ${agentId}:${skillName}` |

### 6.4 §6 验收基线对应

outline §6 验收基线中下列条目直接对接本笔记的差距分析：

- **长会话不再撞 token 上限**：连续 30+ 步 read_file 后 input_tokens 比 v0 减少 ≥ 30% — 由 §4.4 Offload 实现。
- **Offload 工作**：12K 字 read_file 结果在第 N+2 轮后被替换为 `[offloaded ref=off_xxx ...]` — §4.4.3 OffloadMiddleware。
- **Manual /compact 可用**：TUI 输入 `/compact` 后 messages 数显著减少且能继续对话 — §4.6。
- **AgentSession 贯穿**：所有 model.invoke metadata 含 `source / sessionId`；sub-agent 调用含 `parentSessionId` — §1.10。
- **querySource 重试分类**：mock 后台 querySource 撞 529 不重试 — §1.10.2。
- **拒绝熔断器**：连续 3 次工具拒绝后 agent 主循环必然终止，trace event 含 `rejection_circuit_tripped` — §1.11。
- **API 不变量保护**：构造孤儿 tool_result，断言 microcompact 不会拆 tool_use/result 对 — §4.14.2。
- **递归防护**：summary 调用期间 microcompact 不触发 — §4.14.4。
- **PostCompact Recovery**：`/compact` 后 messages 必含 AGENTS.md + todo snapshot — §4.14.7。

---

## 7. 对 helixent 二期的具体启示

> 每条标注 `[已纳入 §xx]`（outline 已落到对应小节）或 `[v3 候选]`（仅记录、不进二期）。

- **把 `AgentSession` 作为压缩 / 熔断 / 多 agent 协作的统一宿主**：所有跨回合状态（usage / contextStore / rejection / compactInProgress / currentSource）从 `Agent` 字段中剥离，挂到 session；`Agent` 类零修改承诺得以保留。`querySource` 元数据在每次 `model.invoke` 上贯穿，下游中间件只读、不改主循环。`[已纳入 §1.10]`

- **拒绝熔断器（连续 3 / 累计 20）作为 ReAct loop 的安全网**：在 approval 中间件 `beforeToolUse` 累计 `consecutive/total`，批准时清零；`agent.ts:stream()` 每步开头读 `session.rejection.tripped` 优雅退出。这是除 §4 外**唯一**会触碰 `agent.ts` 的修改点，影响面极小。`[已纳入 §1.11]`

- **MVP 压缩做"先无损后有损"三件套：L0 Offload + L1 Microcompact + L4 Manual `/compact`**。L0 用 `OffloadMiddleware.afterToolUse` 把超阈值 tool_result 搬到 `InMemoryContextStore`，原位留 ref + 200 字摘要；L1 在 `beforeModel` 只改本次副本（接受 OpenAI 路径 cache miss，留 `emitCacheEdits` hook 给未来 anthropic 直连）；L4 用一次禁用工具的 `model.invoke` + 8 段 `<summary>` 模板 + PostCompact Recovery 注入 AGENTS.md / todo / 最近文件 / 已用技能。`[已纳入 §4.4 / §4.5 / §4.6 / §4.14.5 / §4.14.7 / §4.14.9]`

- **必须采纳 API 不变量保护与递归防护**：`adjustBoundaryToPreserveInvariants` 防止 microcompact 拆开 tool_use/tool_result 对（API 直接 400 是硬错误）；`session.currentSource === 'compact'` 时 microcompact 自动让路，避免摘要请求自我吞噬。`[已纳入 §4.14.2 / §4.14.4]`

- **4 档 token 告警状态机驱动 TUI/Web 视觉与压缩行为**：`ok / warn / error / blocking` 四级映射到 status-dot 颜色 + Web 顶部预算条；`blocking` 档禁止用户输入，仅放行 `/compact`。MVP 用 `char/4` 估算 + API usage 校准（B4.6 `tokenCountWithEstimation`），不引入 tiktoken 依赖。`[已纳入 §4.14.6 / §4.15 B4.6]`

- **System prompt 分段 + AGENTS.md 多源加载**：把 `AgentProfile.systemPrompt` 升级为 `{ global, dynamic }`，static 部分供未来 prompt cache 命中；`loadAgentsMdMessage` 抽 helper 支持 user/project/local 三层目录遍历，coding 与 research profile 共用。`[已纳入 §1.12 B1.1 / B1.2 / §1.5]`

- **L2 SessionMemory 后台摘要、L3 Autocompact 自动触发、L5 Context Collapse、Partial Compact `'from' / 'up_to'`、PTL 重试、cache_edits 真直连、`read_offloaded(ref_id)` 工具、跨 session 持久化 ContextStore（FS / Redis）**：MVP 全部不做，作为 v3 候选项保留接口与 hook。`[v3 候选]`

- **附件系统的轮次提醒（todo / plan）与 `@include` 递归记忆**：评论 10 的"提醒每 N 轮注入一次"对 helixent 的 todoSystem 是低成本增强；`@include` 可与现有 `src/agent/skills/skill-reader.ts` 复用同一 markdown loader，深度上限 5 + 循环防护套现成模式即可。`[v3 候选]`（节流路径下不进二期）
