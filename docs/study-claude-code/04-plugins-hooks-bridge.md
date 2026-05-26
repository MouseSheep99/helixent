# 04 · 插件 / 钩子 / 桥接：Claude Code 的"扩展三件套"对照笔记

> 评论来源：
> - [`04-plugin-system.md`](file:///Users/bytedance/Documents/Codex/claude-reviews-claude/architecture/zh-CN/04-plugin-system.md)
> - [`05-hook-system.md`](file:///Users/bytedance/Documents/Codex/claude-reviews-claude/architecture/zh-CN/05-hook-system.md)
> - [`13-bridge-system.md`](file:///Users/bytedance/Documents/Codex/claude-reviews-claude/architecture/zh-CN/13-bridge-system.md)
>
> 配套阅读：[`generalize-agent-platform-outline.md`](file:///Users/bytedance/Documents/Codex/helixent/.trae/documents/generalize-agent-platform-outline.md) §5 MCP / §6 sub-agent。

---

## 1. 概述

这三套子系统在 Claude Code 中代表 **"打开生态"** 的三条路径，但在 helixent 当前代码中**几乎完全空缺**：

| 子系统 | Claude Code 体量 | helixent 现状 | 性质 |
|---|---|---|---|
| **Plugin System** | 44 个文件 / 18,856 行；`pluginLoader.ts` 113K + `marketplaceManager.ts` 96K | **完全没有**——既没有外部 plugin 加载机制，也没有 marketplace / blacklist | 功能缺失 |
| **Hook System** | 20 种事件，`hooks.ts` 5,023 行 + `hooks/` 17,931 行；shell / HTTP / agent / fn 四种实现 | **有最小可用版**：[`agent-middleware.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent-middleware.ts) 提供 8 钩子接口 | 概念对齐，能力差距大 |
| **Bridge System** | `bridge/` 目录约 11,700 行；轮询-分发循环 / Epoch 冲突 / JWT 刷新 / 32 会话容量 | **完全没有**——helixent 是单进程 CLI/TUI，无远程控制通道 | 功能缺失 |

> 三套都不是 helixent 二期 MVP 的优先项；笔记目的是把"Claude 做了什么、helixent 已有什么、之间差几条街"梳理清楚，并给二期 / v3 的取舍留底。

---

## 2. Claude 做法

### 2.1 Plugin System — 完整应用商店

**Manifest 驱动**：每个插件根目录必有 `.claude-plugin/plugin.json`，由 `schemas.ts` 中 60K 字节的 Zod schema 校验，可声明：

```jsonc
{
  "name": "my-plugin",
  "commands": ["commands/*.md"],     // slash 命令（带 YAML frontmatter）
  "agents":   ["agents/*.md"],        // 子 agent 定义
  "hooks":    { ... },                // 注册到 hook 总线
  "mcpServers": { ... },              // 自动启动的 MCP server
  "skills":   ["skills/*/SKILL.md"],  // 提示即代码
  "outputStyle": "styles/custom.md"
}
```

**四级发现优先级**：内置 → 项目 `.claude/` → 用户 `~/.config/claude-code/plugins/` → 官方 marketplace（GCS bucket）。

**生命周期**：`pluginLoader.ts`（代码库第二大文件）做并行加载、错误隔离（一插件崩溃不影响其它）、循环依赖检测；`installedPluginsManager.ts` 做声明式 reconcile（"期望状态 → 实际状态 → diff"）；`zipCache.ts` 用内容哈希做跨版本/跨用户去重。

**信任与黑名单**：`workspace trust` 弹窗未通过时不加载第三方插件；marketplace 可远程下发黑名单按 ID 停用插件；`孤儿插件过滤` 检测 source 仓库已删的悬空引用。

**Skill 来源 6 层**：`commands_DEPRECATED` / `skills` / `plugin` / `managed` / `bundled` / `mcp` —— skills 与 plugin 并不是包含关系，而是**正交来源**。

### 2.2 Hook System — 20 事件的拦截总线

`PreToolUse` 是最重要的事件，单点决定整个工具调用的命运：

| 决定 | 形式 | 效果 |
|---|---|---|
| `allow` | `permissionDecision` | 跳过弹窗自动批准 |
| `deny` | `permissionDecision` | 拦截工具，向 model 返回错误 |
| `ask` | `permissionDecision` | 强制弹用户确认 |
| 改参数 | `updatedInput` | 在执行前篡改 tool input |
| 终止会话 | `continue: false` | 整个 agent 循环立即停止 |

**四种实现形态**：shell command / HTTP webhook / 子 agent 调用 / SDK 内 JS 回调。

**协议轻量**：stdin 传 JSON（`session_id` / `cwd` / `tool_name` / `tool_input`），stdout 严格 JSON 校验（Zod）+ 可选纯文本 fallback；**退出码作控制流**：0 成功 / 1 非阻塞 / **2 阻塞强终止**。

**异步唤醒**：hook 可以返回 `{ async: true, asyncRewake: true }` 在后台跑，完成时用 `task-notification` 把结果"反向注入"对话流。

**聚合策略**：多个 hook 同时命中时，**Deny 优先 / preventContinuation 优先 / 最后 updatedInput 覆盖 / 上下文消息拼接**，让安全审计 hook 能否决其他放任 hook。

**安全防御**：hook 必须等 workspace trust 弹窗通过才加载，避免 `.claude/settings.json` 的隐藏后门。

### 2.3 Bridge System — claude.ai 远程控制 CLI 的 IPC 协议

**双模式**：
- 独立桥接 `claude remote-control`（`bridgeMain.ts`，3000 行）：长期运行；轮询服务器；每个会话 spawn 子进程 `claude --print --sdk-url ...`，NDJSON 双向流转。
- REPL 桥接 `/remote-control`（`replBridge.ts`，2407 行）：进程内桥；交互模式中让 web 用户接管。

**协议三代演进**：
- v1：HybridTransport（WebSocket 读 + HTTP POST 写 + OAuth）
- v2：SSE + CCRClient（GET stream 读 + POST 写 + 带 `session_id` 的 JWT + 心跳 + Worker epoch）
- v3：无环境桥 `remoteBridgeCore.ts`，OAuth → worker_jwt 一步换发，去掉整套 register/poll/ack/heartbeat。

**关键机制**：
- **Epoch 冲突解决**：每次 `/bridge` 调用递增 `worker_epoch`，旧 epoch 心跳被服务器返回 409 → 桥接自毁传输层重连，避免双 worker 抢同一会话。
- **崩溃恢复指针**：`writeBridgePointer(dir, { sessionId, environmentId, source })`，重启时按 `reuseEnvironmentId` 幂等续接；环境过期则归档旧会话开新会话。
- **JWT 刷新调度**：过期前 5 分钟换签；v2 需要重建整条传输层（因为 epoch 变）。
- **CapacityWake**：`AbortController` 中断容量满时的休眠 sleep，让空位出现就立刻接活。
- **回调注入隔离**：Agent SDK 包对 `bridge` 的依赖通过函数参数注入，避免拉入整棵 REPL 树。

---

## 3. 关键代码线索

### Plugin（Claude）
- `utils/plugins/pluginLoader.ts`（113K）—— 发现 / 校验 / 注册全生命周期。
- `utils/plugins/marketplaceManager.ts`（96K）—— GCS bucket marketplace + auto-update + blacklist。
- `utils/plugins/schemas.ts`（60K）—— 整个 manifest 的 Zod 校验入口。
- `utils/plugins/dependencyResolver.ts`（12K）—— 插件依赖图。
- `utils/plugins/zipCache.ts`（14K）—— 内容哈希缓存。

### Hook（Claude）
- `utils/hooks.ts`（5023 行）—— hook 总线 + matcher 闭包预编译。
- `hooks/`（17931 行）—— 20 种事件的具体处理器。

### Bridge（Claude）
- `bridge/bridgeMain.ts`（3000 行）—— 独立模式主循环。
- `bridge/replBridge.ts`（2407 行）—— 进程内 REPL 模式。
- `bridge/remoteBridgeCore.ts`（1009 行）—— v3 无环境桥。
- `bridge/sessionRunner.ts`（551 行）—— 子进程 spawn + stdin token 注入。
- `bridge/replBridgeTransport.ts`（371 行）—— v1/v2 传输抽象。

---

## 4. helixent 现状

### 4.1 Plugin —— 完全没有

helixent 当前**没有任何 plugin loader / marketplace 概念**。所有能力都在编译期固化：
- 工具集硬编码在 [`createCodingAgent`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/agents/lead-agent.ts) 的 `tools: [...]` 数组（13 项）。
- Skill 系统已经存在（[`src/agent/skills/`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/skills/)），但只支持**单一目录加载**，没有"项目 / 用户 / marketplace"多层级；也没有 manifest 驱动。
- 没有 `@/community/mcp`，无法接入第三方工具（outline §5 才规划落地）。
- 无 trust gate / blacklist / 孤儿过滤。

### 4.2 Hook —— 最小可用版（middleware）

helixent 已经有一套**与 hook 思想对齐**但形态更简单的 middleware 总线，定义见 [`agent-middleware.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent-middleware.ts)：

```ts
// 8 个生命周期钩子（节选）
beforeAgentRun / afterAgentRun
beforeAgentStep(step) / afterAgentStep(step)
beforeModel(modelContext) / afterModel(message)
beforeToolUse(toolUse) / afterToolUse(toolUse, toolResult)
```

执行机制由 [`agent.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L278-L360) 内的 8 个 `_beforeXxx`/`_afterXxx` 方法逐项串行调用：

```ts
private async _beforeToolUse(toolUse) {
  for (const middleware of this.middlewares) {
    if (!middleware.beforeToolUse) continue;
    const result = await middleware.beforeToolUse({ agentContext: this._context, toolUse });
    if (result && typeof result === "object" && "__skip" in result) {
      return { skip: true, result: result.result };  // ← 等价 Claude 的 deny+inject
    }
    if (result) Object.assign(this._context, result);
  }
  return { skip: false };
}
```

与 Claude `PreToolUse` 对照：
| Claude 决定 | helixent 现状 |
|---|---|
| `allow` | 隐式（不返回 `__skip` 即放行） |
| `deny` + 注入错误 | 通过 [`createCodingApprovalMiddleware`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/permissions/coding-approval-middleware.ts) 返回 `{ __skip, result: "Tool use rejected by user" }` |
| `ask` | approval middleware 内部 `askUser()` callback 实现 |
| `updatedInput`（改参数） | **目前不支持**——`beforeToolUse` 不返回新的 `toolUse.input`，仅可改 `agentContext` |
| `continue: false` | **目前不支持**——middleware 无法直接终止整个 stream（仅可 `agent.abort()` 外部触发） |

返回值合并规则也比 Claude 简单：所有 hook 是 `Promise<Partial<AgentContext>>`，按顺序 `Object.assign` —— **无 deny-优先 / 无聚合策略 / 无异步唤醒**。

### 4.3 Bridge —— 完全没有

helixent 仅有：
- 单进程 CLI/TUI（`src/cli/tui/app.tsx`），交互通过 Ink 渲染。
- Web server（`web/server.ts`，未在本任务上下文中读取，但依索引表它只做只读 trace）。
- Provider 直连：[`src/community/anthropic/index.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/community/anthropic/index.ts) 与 [`src/community/openai/index.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/community/openai/index.ts) 都只导出 `model-provider`，是**进程内的 HTTP 客户端**，与 Claude 的 bridge "remote-control 远程协议" 完全不在一个层级。

没有 NDJSON IPC / 无 worker epoch / 无 JWT 刷新 / 无崩溃恢复 / 无远程控制 token。

---

## 5. 差距与借鉴判断

| 能力 | Claude Code | helixent 现状 | 差距 | 借鉴判断 |
|---|---|---|---|---|
| Plugin manifest 驱动 | ✅ 60K Zod schema | ❌ **完全没有** | 极大 | **不采纳**（过早抽象；helixent 用户基数和扩展者数量都不到引入 plugin 的临界点） |
| Plugin 多源发现（项目/用户/市场） | ✅ 4 级 | ⚠️ skills 单目录 | 大 | **部分借鉴**：skills 升级到 3 级（项目 > 用户 > 内置）= [B5.11] |
| Marketplace + GCS + 黑名单 | ✅ 完整 | ❌ | 极大 | **不采纳**（运营成本远超 helixent 二期收益） |
| 错误隔离（一插件崩不影响其他） | ✅ | ⚠️ middleware 抛错会冒泡 | 中 | **部分借鉴**（middleware loop 可加 try-catch + telemetry） |
| Hook 8 个生命周期钩子 | ✅ 20 个 | ✅ 8 个 | 小 | 概念已对齐 |
| Hook updatedInput（改 tool input） | ✅ | ❌ | 中 | **二期可补**：`beforeToolUse` 返回值扩展支持 `{ updatedInput }` |
| Hook continue:false（终止会话） | ✅ | ❌ | 小 | **二期可补**：与 outline §1.11 拒绝熔断器配合 |
| Hook 退出码 0/1/2 协议 | ✅ shell hook | ❌ | — | helixent middleware 是 JS 闭包，不需要退出码 |
| Hook 异步 + 反向唤醒 | ✅ task-notification | ❌ | 大 | **v3 候选**：与 sub-agent / 后台压缩配合时再考虑 |
| Hook 多源聚合（Deny 优先） | ✅ | ❌ | 中 | **二期可补**：approval 与未来其它 middleware 冲突时需要 |
| Hook 工作区信任 | ✅ | ❌ | 中 | **v3 候选**：与 plugin/MCP 一起做 |
| Bridge 远程控制 | ✅ | ❌ | 极大 | **不采纳**（helixent 不是云产品） |
| Bridge NDJSON IPC | ✅ | ❌ | 大 | **v3 候选**：spawn 子进程做 sub-agent 隔离时可借鉴（[B3.1]） |
| Bridge Epoch 冲突解决 | ✅ | ❌ | — | 不需要（无并发 worker 抢会话场景） |
| Bridge 崩溃恢复指针 | ✅ | ❌ | 大 | **v3 候选**：与 session 持久化（评论 09）一起做 |

> **核心结论**：plugin 与 bridge 在 helixent 二期都**不做**。hook（middleware）只在能力上做小幅补强（`updatedInput` / `continue:false` / 错误隔离 / Deny 聚合）。

---

## 6. 与 outline 章节关联

### 6.1 与 §5 MCP（模块 5）

outline §5 把 **MCP** 视为 helixent **唯一的"第三方扩展"通道**，刻意绕开整套 plugin 系统：

| Claude 概念 | outline §5 落点 |
|---|---|
| Plugin 提供的 `mcpServers` 字段 | 直接合入 `mcpToolkit({ command, args, env })` 工厂（B5.1 / §模块 5 头节） |
| Plugin manifest 驱动 | **不做**（[B5.7] / [B5.8] 明确标 ❌） |
| Skill 多源 6 层 | 仅借鉴 3 级（项目 / 用户 / 内置）= [B5.11] |
| MCP 6 种 transport | MVP 仅 stdio，HTTP 留 v3 = [B5.3] |
| Workspace trust gate | **保留**：未信任目录不加载第三方 skills/MCP = [B5.13] |
| MCP server reconcile（声明式） | v3 候选 = [B5.12] |
| ToolSearch 延迟加载 | MVP 工具 ≥ 30 时启用 = [B5.2] |
| 代际计数器（防过期初始化覆盖） | MCP server 重连用 = [B5.5] |

要点：outline 把 plugin 的"manifest 集中声明 hooks/mcpServers/skills/agents"**拆成 4 个独立轴**——profile（agent 装配）、middleware（hook）、mcpToolkit（MCP）、skills 目录。这避免了 plugin manifest 这种"包山包海"的强耦合点。

### 6.2 与 §6 sub-agent 委派（模块 6）

outline §6 给 sub-agent 设了**严格的 1 层深度限制**，部分动机正是为了避免 Claude bridge 那套"多 worker 抢会话 / Epoch 冲突 / JWT 刷新"的复杂度：

| Claude 概念 | outline §6 落点 |
|---|---|
| Bridge spawn 子进程 + NDJSON | **不采纳**：MVP 仅进程内 spawn 新 `Agent` 实例（[B6.10] 标 ❌） |
| 协调者工具集架构级受限 | **采纳**：派生 `coordinatorProfile`，toolkit 只装 `agent-orchestration` = [B6.1] |
| Worker fresh / fork 模式 | **采纳**：`delegate_task({ mode: "fresh" \| "fork" })`，默认 `fresh` = [B6.2] |
| `<task-notification>` XML 结果回传 | **采纳**：sub-agent 完成时 lead 收到 user-role tool_result = [B6.3] |
| `{name}@{teamName}` 确定性 ID + parentSessionId | **采纳**：`{profileId}#{shortHash}` + §1.10 已含 = [B6.4] |
| Skill executionContext: fork | **等价于** sub-agent 一次 run = [B6.11] |
| 1 层 vs 多层 | outline §模块 6 明文限制 **1 层**，防止递归爆炸（§5 决策表） |
| Scratchpad 共享目录 | v3 候选 = [B6.6] |
| Research → Synth → Impl → Verify 四阶段 | v3 prompt 模板 = [B6.7] |
| 权限委托链 | v3 = [B6.9] |

要点：1 层深度限制让 helixent 无需引入 Epoch / 崩溃恢复 / 多代 worker 协议，**用 90% 的简化拿到 80% 的能力**。这是 outline 显式做的取舍。

---

## 7. 对 helixent 二期的具体启示

> 末尾启示按"是否已纳入 outline / v3 候选"标注。

- **middleware 增强 `updatedInput` 与 `continue:false` 两个返回形态**：当前 [`BeforeToolUseResult`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent-middleware.ts#L73-L78) 只支持 `{ __skip, result }`；可扩展为 `{ updatedInput: P }` 与 `{ stop: true, reason }`。前者让 approval middleware 在拒绝场景下还能"建议改写参数"；后者让拒绝熔断器（outline §1.11）有 middleware 内的"软退出口"，不必依赖 `agent.abort()` 外部触发。**[已纳入 §1.11，但 hook 协议扩展未明示，建议补到二期 spec]**

- **middleware loop 加 try/catch + 隔离日志**：Claude plugin 的"一个崩溃不影响其他"是个低成本但价值大的稳定性保险。当前 [`agent.ts:278-360`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L278-L360) 的 8 个 `_beforeXxx`/`_afterXxx` 方法直接 `await middleware.xxx(...)` 无捕获——任意中间件抛异常都会冒泡到主循环。建议在每个 `for (middleware of ...)` 内部 try/catch，把错误转成 trace event（`middleware_error`）而不是中断整个 step。**[v3 候选]**

- **Hook 多源聚合策略写入 spec**：Claude 的 "Deny 优先 / 最后 updatedInput 覆盖 / 上下文拼接" 在 helixent 二期会很快撞到——profile 一旦同时挂 `skills` / `todo` / `approval` / `offload` / `microcompact` 5 类 middleware，行为冲突解决就成了真问题。**建议在 outline §1 末尾补一节 "middleware 聚合规则"**：明确 `__skip` 的优先级、context 字段冲突时谁覆盖谁、以及哪些字段是 append 还是 replace。**[v3 候选]**

- **skills 多源加载（项目 > 用户 > 内置）**：Claude plugin 来源 4 级 + skills 来源 6 层是被实战验证的"用户定制 / 项目共享 / 安装管控"分层模型。helixent 当前 [`createSkillsMiddleware(skillsDirs)`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/skills/) 只接 `string[]` 单层数组，建议扩成有优先级的 3 级，并在合并时按 name 去重保留高优先级版本。**[已纳入 §5 / B5.11]**

- **plugin 与 bridge 明确不做、写入 outline §8**：当前 outline §8 "Out of Scope" 只列了"profile 文件加载 / web 表单编辑 / MCP HTTP"等，**plugin manifest 与 bridge 远程控制都没出现**。建议补上一句"v3 也不引入 plugin manifest / marketplace / bridge 远程控制；扩展能力以 MCP + skills 多源为唯一通道"，避免后续 reviewer 把它们当成"被遗漏的能力"反复提案。**[v3 候选 — 建议改为"显式排除"]**

- **bridge 的 NDJSON IPC + 崩溃恢复指针留给 v3 sub-agent 进程隔离**：如果二期之后真要做 sub-agent 跨进程隔离（例如 web 后端 spawn worker、CI 场景），Claude bridge 的 `sessionRunner.ts` 是非常成熟的参考——子进程 stdin 注 token / stdout 解析 NDJSON / `bridgePointer` 崩溃恢复。outline [B3.1] / [B3.2] 已经把它标为 v3，但**没和 §6 sub-agent 串起来**；建议 v3 做"sub-agent 进程隔离"时直接复用这一套。**[v3 候选]**

- **hook 异步反向唤醒 = 后台 compact / session memory 的最佳形态**：Claude `task-notification` 回写让 hook 能挂在后台跑、跑完反向唤醒主循环。helixent outline §模块 4 的 L2 SessionMemory 与 L3 Autocompact 都标了 v3，**它们的实现形态本质上就是"后台 hook + 反向唤醒"**。建议 v3 做这两层时，hook 协议直接演进到支持 `{ async: true, rewake: true }` 而不是另起一套机制。**[v3 候选]**
