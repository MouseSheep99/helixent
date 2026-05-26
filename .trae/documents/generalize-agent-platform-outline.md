# 通用化 Agent 平台 v2 — 实施大纲（Outline）

> 仅列大纲，不展开 spec / tasks / checklist 细节。  
> 目标：吸收 Claude Code 源码学习后的关键承重结构，把二期从"功能拼装"升级为"通用 Agent 运行时平台"；仍保持最小 MVP，不复刻 Claude Code 全量系统。

---

## 1. 背景与结构性门槛

二期最初关注的是 4 个显性方向：profile、界面、MCP、sub-agent，再加 tools 配置优化。读完 Claude Code 源码后，判断需要把优先级前移一层：先补**运行时地基**，再做生态接入和界面收口。

因此本轮规划按 5 类问题组织：

| 层级 | 解决什么 | 对应模块 |
|---|---|---|
| Runtime 地基 | 会话状态、请求来源、拒绝/compact/retry 等跨回合状态放哪里 | 模块 0 / 模块 1 |
| Tool 平台化 | 新 tool 如何低成本接入、审批、摘要、结果治理 | 模块 2 |
| Context 安全网 | 长会话、大工具结果、manual compact 如何不炸上下文 | 模块 4 |
| Ecosystem 接入 | MCP 和 sub-agent 如何接入但不污染核心 | 模块 5 / 模块 6 |
| Experience 收口 | CLI/Web 如何展示 profile、trace 和运行状态 | 模块 3 |

| # | 门槛 | 当前痛点 | 落点 |
|---|---|---|---|
| 1 | **跨回合状态无宿主** | usage / context-store / 拒绝计数 / compact 状态只能塞 Agent 字段或全局 | **模块 0** AgentSession + querySource |
| 2 | agent 装配硬编码 | [`createCodingAgent`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/agents/lead-agent.ts) 把 cwd / AGENTS.md / 工具 / approval 全部写死 | **模块 1** AgentProfile |
| 3 | toolkit 配置零散 | 新增 tool 要改多处；approval、TUI 摘要、结果策略彼此割裂 | **模块 2** Tool Contract + Toolkit |
| 4 | **权限与拒绝缺安全网** | 模型反复尝试被拒工具；权限只靠工具名/能力点不够表达输入级风险 | **模块 2** Permission Chain + Rejection Circuit |
| 5 | **上下文不可压缩** | `Agent.messages` 只增不减；无 offload / compact / message invariant guard | **模块 4** Offload & Compact MVP |
| 6 | 生态封闭 | 内置工具是天花板，MCP 连接状态与工具包装还没有统一模型 | **模块 5** MCP |
| 7 | 单 agent 单线程 | lead 不能委派 sub-agent，且缺少 parentSession / querySource 血统 | **模块 6** delegate_task |

**模块 3** Web `/agents` 只读视图降为体验收口：它展示平台能力，但不再作为二期的前置承重模块。

---

## 2. 模块切片总览

> 前面 5.5 已详细分类 Claude Code 可借鉴点；本章只保留二期模块大纲，不展开过多源码细节。

| 模块 | 名称 | 核心问题 | 二期边界 |
|---|---|---|---|
| 模块 0 | Runtime Session 地基 | 跨回合状态、请求来源、重试/拒绝/compact 状态归属 | 新增轻量 `AgentSession`，不重写 Agent loop |
| 模块 1 | AgentProfile 抽象 | 把 coding agent 的硬编码装配外移 | 保持 `createCodingAgent` 零回归 |
| 模块 2 | Tool Contract + Toolkit | 工具接入、审批、摘要、结果策略统一 | 最小扩展 `defineTool`，不搬 Claude 全量 Tool 接口 |
| 模块 3 | Profile 只读 Web UI | 让 profile/toolkit 可观察 | 后移，不阻塞 runtime 地基 |
| 模块 4 | Offload & Compact MVP | 大结果和长会话不再无限涨 | L0 offload + L1 microcompact + manual compact |
| 模块 5 | MCP toolkit | 第三方工具接入 | MVP 仅 stdio，但保留连接状态 union |
| 模块 6 | Sub-agent 委派 | lead 可委派研究/验证任务 | 同步 1 层，session-aware，不做 swarm |

### 模块 0 · Runtime Session 地基（Claude Code 学习后新增）

**目标**：先给二期能力一个稳定宿主，避免后续 profile / compact / MCP / sub-agent 各自造状态。

**包含**：
- `AgentSession`：会话 id、父会话 id、usage、rejection、compact 状态、context store。
- `querySource`：区分 main / compact / microcompact / sub-agent / hook-agent。
- message invariant guard：防止 `tool_use` / `tool_result` 被 compact 或 fallback 拆坏。
- 最小 model retry 事件：让 429/529/网络错误的重试状态可观察。

**不包含**：
- 不重写 [`Agent`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts) 主循环。
- 不做完整 session JSONL 持久化。
- 不做 Claude Code 的 full `QueryEngine` 复刻。

**验收导向**：
- model request metadata 能看到 `sessionId/source`。
- sub-agent 能带 `parentSessionId`。
- 后台 `querySource` 遇 529 不反复重试。
- compact / tool fallback 前后消息不变量保持合法。

### 模块 1 · AgentProfile 抽象（A 方向 MVP）

#### 1.1 现状盘点：[`src/agent/`](file:///Users/bytedance/Documents/Codex/helixent/src/agent) 全景

| 子模块 | 文件 | 角色 |
|---|---|---|
| 主类 | [`agent.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L48-L361) | `Agent` 类，承载 ReAct 主循环 |
| 事件 | [`agent-event.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent-event.ts) | `AgentEvent`：`message` / `progress` |
| 中间件 | [`agent-middleware.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent-middleware.ts#L1-L136) | 8 钩子接口 + Params 类型 |
| 工具结果归一 | [`tool-result-runtime.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/tool-result-runtime.ts#L1-L187) | `normalizeToolResult` / `formatToolResultForMessage` |
| 工具结果策略 | [`tool-result-policy.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/tool-result-policy.ts#L1-L45) | 按工具名分配 `preferSummaryOnly` / `maxStringLength` |
| 工具结果摘要 | [`tool-result-summary.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/tool-result-summary.ts#L1-L28) | TUI 用的 `summarizeToolResultText` |
| Skill 子系统 | `skills/` | `createSkillsMiddleware(dirs)` 注入 `<skill_system>` prompt |
| Todo 子系统 | `todos/` | `createTodoSystem()` 返回闭包共享的 `{ tool, middleware }` |

[`Agent`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L48-L361) 类自身**已经足够通用**：
- 只依赖 `foundation`（Model / Message / Tool）
- 构造参数：`{ name?, model, prompt, messages, tools, middlewares, maxSteps }`
- `AgentContext` 是装配后共享的可变对象（被 middleware 通过 `Object.assign` 改写）：
  ```ts
  interface AgentContext {
    prompt: string;
    messages: NonSystemMessage[];
    tools?: Tool[];
    skills?: SkillFrontmatter[];          // skills middleware 注入
    requestedSkillName?: string | null;   // CLI slash command 写入
  }
  ```
- ReAct 主循环 [`stream(message)`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L140-L171)：
  ```
  appendMessage(user)
  → beforeAgentRun
  → for step in 1..maxSteps:
      → beforeAgentStep(step)
      → _think()         # beforeModel → model.stream → afterModel
      → yield AssistantMessage
      → if no tool_use: afterAgentRun → return
      → _act(toolUses)    # parallel: beforeToolUse → invoke → afterToolUse
      → afterAgentStep(step)
  ```
- 工具并行执行，按"先完成先 yield"顺序追加 `tool_result` 消息（[`_act`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L222-L272) 用 `Promise.race` 实现增量）

**结论：不重写 `Agent` 主循环。** 二期新增 `AgentSession` 作为外部会话宿主，`Agent` 继续承载 ReAct loop；运行时状态、compact、retry、sub-agent 血统放到外围 session 层。

#### 1.2 装配硬编码痛点（以 [`createCodingAgent`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/agents/lead-agent.ts#L31-L120) 为镜子）

实际上做了 **9 件事**，全部写死在一个函数里：

| # | 步骤 | 源码片段 | runtime 依赖 |
|---|---|---|---|
| 1 | 读 `${cwd}/AGENTS.md` 注入首条 user message | [`L48-L61`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/agents/lead-agent.ts#L48-L61) | cwd |
| 2 | `createTodoSystem()` 拿 todoTool + todoMiddleware（共享闭包 store） | [`L62`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/agents/lead-agent.ts#L62) | — |
| 3 | `createAskUserQuestionTool(askUserQuestion)` 条件构造 | [`L64`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/agents/lead-agent.ts#L64) | callback |
| 4 | `createSkillsMiddleware(skillsDirs)` | [`L66`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/agents/lead-agent.ts#L66) | dirs |
| 5 | 条件挂 approval：`if (askUser) middlewares.push(createCodingApprovalMiddleware({...}))` | [`L67-L76`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/agents/lead-agent.ts#L67-L76) | cwd + 3 callbacks |
| 6 | systemPrompt 模板字面量 内插 `${cwd}` | [`L80-L101`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/agents/lead-agent.ts#L80-L101) | cwd |
| 7 | `tools` 数组手写 13 项 | [`L103-L117`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/agents/lead-agent.ts#L103-L117) | — |
| 8 | `middlewares` 数组（skills + todo + 可选 approval） | [`L66-L77`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/agents/lead-agent.ts#L66-L77) | 同 5 |
| 9 | `new Agent({ ... })` | [`L78-L119`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/agents/lead-agent.ts#L78-L119) | — |

第 1 / 3 / 4 / 5 / 6 步本质上都是 **"runtime context → 静态 agent 配置"** 的求值。Profile 抽象就是把这些步骤外移成"**纯数据 + factory 引用**"。

#### 1.3 AgentProfile 数据模型（最终接口）

```ts
// src/agent/profiles/types.ts
import type { AgentMiddleware } from "../agent-middleware";
import type { Model, NonSystemMessage, Tool, ToolUseContent } from "@/foundation";
import type { Toolkit, Capability } from "../toolkits/types";
import type { ApprovalDecision, ApprovalPersistence } from "@/coding/permissions";
import type { AskUserQuestionParameters, AskUserQuestionResult } from "@/coding/tools/ask-user-question";
import type { McpServerConfig } from "@/community/mcp/types";

export interface AgentProfile {
  /** 唯一 id（CLI / API 引用用） */
  id: string;
  name: string;
  description: string;

  /** 系统 prompt：静态字符串 或 接收 runtime ctx 求值 */
  systemPrompt: string | ((ctx: AgentProfileRuntimeContext) => string);

  /** Toolkit 引用：string id 或 内联 Toolkit（让 mcpToolkit({...}) 直接传入） */
  toolkit: AgentProfileToolkitRef[];

  /**
   * Middleware 工厂列表，顺序 = middlewares 装配顺序
   * 返回 null 表示该 middleware 在当前 ctx 下不挂（替代 lead-agent 的 if 条件）
   */
  middlewareFactories?: ((ctx: AgentProfileRuntimeContext) => AgentMiddleware | null)[];

  /** 初始 message factory（替代 AGENTS.md 自动加载逻辑） */
  initialMessages?: (ctx: AgentProfileRuntimeContext) => Promise<NonSystemMessage[]>;

  /** 默认 maxSteps；不传则继承 Agent 默认 100 */
  defaultMaxSteps?: number;
}

export type AgentProfileToolkitRef = string | Toolkit;

export interface AgentProfileRuntimeContext {
  // 必填
  cwd: string;
  model: Model;
  skillsDirs: string[];

  // 可选 callback / 持久化
  askUser?: (toolUse: ToolUseContent) => Promise<ApprovalDecision>;
  askUserQuestion?: (params: AskUserQuestionParameters) => Promise<AskUserQuestionResult>;
  approvalPersistence?: ApprovalPersistence;

  // 模块 5 用
  mcpServers?: Record<string, McpServerConfig>;

  // 模块 6 用：lead = 0，sub-agent = 1
  delegationDepth?: number;

  // 由 createAgentFromProfile 装配后注入；middleware factory 可读
  toolCapabilities?: Map<string, Set<Capability>>;
  /** todoSystem 共享闭包：toolkit factory 与 middleware factory 共用 */
  todoSystem?: { tool: Tool; middleware: AgentMiddleware };
}
```

> **关键设计点 1**：`runtimeContext` 是**装配期一次性**对象，不是每次 stream 重新传入；装配完成后 Agent 实例自身已"封口"，与 v0 一致（不破坏 [`agent.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts) 内部状态模型）。

> **关键设计点 2**：`todoSystem` 字段处理 [`createTodoSystem()`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/todos/todos.ts#L75-L142) 的"tool 与 middleware 闭包共享 store"问题。装配期先创建一次缓存到 ctx，后续 toolkit 与 middleware 都从 ctx 取。

#### 1.4 createAgentFromProfile 装配流程（伪码）

```ts
// src/agent/profiles/create.ts
export async function createAgentFromProfile({
  profile, model, runtimeContext,
}: { profile: AgentProfile; model: Model; runtimeContext: AgentProfileRuntimeContext }): Promise<Agent> {
  // 0. 预创建 todoSystem（保证 toolkit + middleware 共享同一 store）
  const todoSystem = runtimeContext.todoSystem ?? createTodoSystem();
  const ctx0 = { ...runtimeContext, todoSystem };

  // 1. 解析 toolkit refs：string → registry 查；object → 直接用
  const toolkits = resolveToolkits(profile.toolkit);

  // 2. 让每个 toolkit 把它的 tools 求值（factory 形态时传 ctx0）
  const allTools: Tool[] = [];
  const toolCapabilities = new Map<string, Set<Capability>>();
  for (const tk of toolkits) {
    const tools = typeof tk.tools === "function" ? tk.tools(ctx0) : tk.tools;
    for (const t of tools) {
      if (allTools.some((x) => x.name === t.name)) continue;   // 按 name 去重
      allTools.push(t);
      toolCapabilities.set(t.name, new Set(tk.capabilities));
    }
  }

  // 3. ctx 注入 toolCapabilities，供 middleware factory 查询
  const ctx = { ...ctx0, toolCapabilities };

  // 4. 求值 systemPrompt
  const prompt = typeof profile.systemPrompt === "string"
    ? profile.systemPrompt
    : profile.systemPrompt(ctx);

  // 5. 求值 initialMessages
  const messages = profile.initialMessages
    ? await profile.initialMessages(ctx)
    : [];

  // 6. 求值 middleware factories（null = 不挂）
  const middlewares = (profile.middlewareFactories ?? [])
    .map((factory) => factory(ctx))
    .filter((m): m is AgentMiddleware => m !== null);

  // 7. new Agent —— Agent 类零改动
  return new Agent({
    name: profile.id, model, prompt, messages, tools: allTools,
    middlewares, maxSteps: profile.defaultMaxSteps ?? 100,
  });
}
```

**装配期不变量**：

1. `Agent` 类内部状态依然只通过 middleware 钩子 + `Object.assign` 修改（与 [`agent.ts:282-287`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L282-L287) 一致）
2. `tools` 数组装配后不再变化（与 [`AgentContext.tools`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L26) 设计一致）
3. tool name 去重确保同一工具不会重复挂载

#### 1.5 lead-agent 9 步 → coding profile 字段映射

```ts
// src/coding/agents/lead-agent.ts —— 重构后（薄壳）
export async function createCodingAgent(opts): Promise<Agent> {
  return createAgentFromProfile({
    profile: getBuiltinProfile("coding"),
    model: opts.model,
    runtimeContext: {
      cwd: opts.cwd ?? process.cwd(),
      model: opts.model,
      skillsDirs: opts.skillsDirs ?? [join(process.cwd(), ".agents/skills")],
      askUser: opts.askUser,
      askUserQuestion: opts.askUserQuestion,
      approvalPersistence: opts.approvalPersistence,
    },
  });
}
```

| lead-agent 步骤 | coding profile 字段 | 落点文件 |
|---|---|---|
| 1. 读 AGENTS.md | `initialMessages: async (ctx) => ...` | `src/coding/profiles/coding.ts` |
| 2. todoSystem | `runtimeContext.todoSystem`（装配期预创建）+ toolkit `agent-core` + middlewareFactories | `src/agent/profiles/create.ts` + `src/agent/toolkits/agent-core.ts` |
| 3. askUserQuestionTool | `agent-core.tools` 工厂式（依赖 ctx.askUserQuestion） | `src/agent/toolkits/agent-core.ts` |
| 4. skillsMiddleware | `middlewareFactories[0]: (ctx) => createSkillsMiddleware(ctx.skillsDirs)` | `src/coding/profiles/coding.ts` |
| 5. approvalMiddleware | `middlewareFactories[1]: (ctx) => ctx.askUser ? createCodingApprovalMiddleware({ requiresCapabilities: new Set(["write_fs", "exec"]), cwd: ctx.cwd, askUser: ctx.askUser, approvalPersistence: ctx.approvalPersistence, toolCapabilities: ctx.toolCapabilities }) : null` | 同上 |
| 6. systemPrompt | `systemPrompt: (ctx) => \`<agent name="Helixent" ...><working_directory dir="${ctx.cwd}/" />...\`` | 同上 |
| 7. tools 数组 | `toolkit: ["coding-fs-readonly", "coding-fs-write", "coding-shell", "agent-core"]` | 同上 |
| 8. middlewares 数组 | `middlewareFactories` 上面 2 条 + todoMiddleware 自动 | 同上 |
| 9. new Agent | `createAgentFromProfile` 统一执行 | `src/agent/profiles/create.ts` |

#### 1.6 Profile registry（极简）

```ts
// src/agent/profiles/registry.ts
const profiles = new Map<string, AgentProfile>();

export function registerProfile(p: AgentProfile): void {
  profiles.set(p.id, p);
}
export function getBuiltinProfile(id: string): AgentProfile {
  const p = profiles.get(id);
  if (!p) {
    const available = [...profiles.keys()].sort().join(", ");
    throw new Error(`Unknown profile "${id}". Available: ${available}`);
  }
  return p;
}
export function listBuiltinProfiles(): AgentProfile[] {
  return [...profiles.values()];
}
```

- 内置 profile 在自身模块顶层 `registerProfile(...)`
- 副作用导出 `src/coding/profiles/index.ts` 触发注册
- 不做磁盘加载（v3）

#### 1.7 middleware 工厂化的设计动机

4 个内置 middleware 的 ctx 依赖各不相同：

| middleware | 依赖 ctx 字段 | 是否可静态化 |
|---|---|---|
| `createSkillsMiddleware(dirs)` | `skillsDirs` | ❌（dirs 来自 CLI / web 启动参数） |
| `todoSystem.middleware` | — 但和 todoTool 共享 store | ❌（必须装配期一次性创建） |
| `createCodingApprovalMiddleware` | `askUser` / `cwd` / `persistence` / `toolCapabilities` | ❌（无 askUser 时整个 middleware 不挂） |

**解法**：
- toolkit `agent-core` 的 `tools` 字段是 factory：`(ctx) => [ctx.todoSystem!.tool, ...(ctx.askUserQuestion ? [createAskUserQuestionTool(ctx.askUserQuestion)] : [])]`
- coding profile 的 middleware factory 之一是 `(ctx) => ctx.todoSystem!.middleware`
- approval factory 用 `(ctx) => ctx.askUser ? createMW(...) : null`，过滤 null 后挂入

#### 1.8 与一期 212 测试的兼容承诺

| 守则 | 验证方式 |
|---|---|
| `Agent` 类零修改 | [`tool-result-policy.test.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/__tests__/tool-result-policy.test.ts) 与 [`tool-result-runtime.test.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/__tests__/tool-result-runtime.test.ts) 持续通过 |
| `createCodingAgent` 公开签名不变 | TypeScript 接口 diff = 0 |
| coding profile 字面输出 v0 prompt 同关键词 | 新增 `coding-parity.test.ts`：断言 prompt 包含 `Helixent` / `leading_agent` / `<working_directory dir=` / `<tool_usage>` / `<notes>` / `Inspect directories before assuming file paths.` 等关键句 |
| AGENTS.md 自动加载逻辑保持 | parity test：在 tmp dir 写 AGENTS.md，断言 `messages[0].content[0].text.startsWith("> The \`AGENTS.md\` file has been automatically loaded.")` |
| 全部 v0 工具仍可调 | 新增 `coding-tools-roundtrip.test.ts`：列出 `agent.tools` 中所有 name 等同 v0 13 个 |
| approval 行为不变 | 旧测试覆盖；额外加 capability-driven 路径单测 |

#### 1.9 Research profile（验证抽象通用性）

```ts
// src/coding/profiles/research.ts
export const researchProfile: AgentProfile = {
  id: "research",
  name: "Research",
  description: "Read-only investigation profile",
  systemPrompt: (ctx) => `<agent name="Helixent" role="research_agent">
You are operating in **read-only research mode**. Inspect, summarize, and reason. Do not write files.
</agent>
<working_directory dir="${ctx.cwd}/" />`,
  toolkit: ["coding-fs-readonly", "coding-shell", "agent-core"],
  middlewareFactories: [
    (ctx) => createSkillsMiddleware(ctx.skillsDirs),
    (ctx) => ctx.todoSystem!.middleware,
    // 不挂 approval —— bash 仍会被 capability "exec" 触发审批（如果 askUser 存在）
  ],
};
registerProfile(researchProfile);
```

**自动得到的好处**：
- 工具集天然没有 write_file / str_replace / apply_patch / mkdir / move_path（不在引用的 toolkit 里）
- approval middleware 仍可挂（如果 ctx.askUser 存在），用 `requiresCapabilities: new Set(["exec"])` 拦截 bash
- 与 coding profile 共享 systemPrompt 工厂模式，零特殊代码

#### 1.10 AgentSession 会话级宿主 + querySource 元数据贯穿（**新增 · 借鉴 Claude Code QueryEngine vs query 双层 + telemetry trace 链**）

> 来源：`01-query-engine.md` 双层架构 / `15-services-api.md` 前台-后台 529 重试白名单 / `17-telemetry.md` parentSessionId trace 链。  
> 现状痛点：[`Agent`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L48-L361) 类承载了"回合级 ReAct loop"，但**没有清晰的"会话级宿主"**承载累计 usage / context-store / 熔断器状态 / sub-agent 血统等"跨回合"状态。模块 4（offload+compact）和模块 6（sub-agent）落地时都需要这个对象。

##### 1.10.1 数据结构

```ts
// src/agent/session/types.ts（新增）
export type QuerySource =
  | "main"                      // 主交互
  | "compact"                   // /compact 自身的 model.invoke
  | "microcompact"              // 微压缩内部回调（如未来 cache_edits hook）
  | `sub-agent:${string}`       // 子 agent，:后跟 profile id
  | "skill-fork"                // skill executionContext: fork（v3）
  | "hook-agent";               // 后台 hook（v3）

export interface AgentSession {
  /** 会话级唯一 id（与 parentSessionId 形成血统链） */
  id: string;
  parentSessionId?: string;

  /** 持有 agent 实例（一会话一 agent，profile 切换 = 新 session） */
  agent: Agent;

  /** 跨回合累积 token usage，按模型分桶 */
  usage: Map<string, TokenUsage>;

  /** 模块 4 用：单 session 生命周期的 offload 存储 */
  contextStore: ContextStore;

  /** 模块 1.12 用：拒绝熔断器状态 */
  rejection: RejectionCircuitState;

  /** 模块 4 用：递归防护 */
  compactInProgress: boolean;
  consecutiveCompactFailures: number;

  /** 当前 query 标签；每次 model 调用前由主循环 / compact / sub-agent 设置 */
  currentSource: QuerySource;
}
```

##### 1.10.2 querySource 元数据贯穿

```ts
// src/foundation/messages/types/message.ts —— 在 model.invoke metadata 上加：
interface ModelInvokeMetadata {
  source: QuerySource;
  sessionId: string;
  parentSessionId?: string;
}
```

**贯穿规则**（所有 model 调用必带 source）：

| 调用方 | source |
|---|---|
| [`agent.ts:_think()`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L173-L205) | `"main"`（主回合）或 `sub-agent:${profileId}` |
| `manual-compact.ts:compactConversation()` | `"compact"` |
| 未来 hook agent | `"hook-agent"` |

下游统一受益（**无需各自传参**）：
- 模块 4 microcompact：`if (source === "compact" \|\| source === "microcompact") return;`（递归防护，呼应 §4.14.4）
- 模块 4 阈值估算：source === "compact" 时不再触发 autocompact（v3）
- foundation/models 重试矩阵（来自 15-services-api）：`FOREGROUND_SOURCES = new Set(["main"])`；非前台撞 529 立即放弃，不被反向放大
- telemetry：parentSessionId 让 sub-agent trace 在 web /traces 下挂到父 session（呼应 §模块 6）

##### 1.10.3 装配 & 落点

```ts
// src/agent/session/create.ts（新增）
export function createAgentSession(opts: {
  agent: Agent;
  parentSessionId?: string;
  contextStore?: ContextStore;
}): AgentSession {
  return {
    id: randomId("sess"),
    parentSessionId: opts.parentSessionId,
    agent: opts.agent,
    usage: new Map(),
    contextStore: opts.contextStore ?? createInMemoryContextStore(),
    rejection: { consecutive: 0, total: 0 },
    compactInProgress: false,
    consecutiveCompactFailures: 0,
    currentSource: "main",
  };
}
```

- 替换调用方：CLI / Web 启动从"直接 `new Agent(...)`"改为"`createAgentFromProfile(...)` → `createAgentSession({agent})`"
- [`Agent`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts) 类自身**仍零侵入**（与 1.4 装配期不变量一致）；session 是外部宿主对象
- middleware 可通过参数注入访问 session：`createOffloadMiddleware({ session })`

##### 1.10.4 与一期兼容

- v0 `createCodingAgent` 公开签名不变；内部产生 session 但**导出仍是 Agent**
- 调用方按需升级：CLI / Web `runAgent()` 改为接收 session；hook 化逐步迁移
- 单测保持："Agent 类零修改"承诺不破（usage/contextStore/rejection 都不在 Agent 字段上）

#### 1.11 拒绝熔断器（**新增 · agent loop 安全网，借鉴 `07-permission-pipeline.md`**）

> 来源：Claude Code 拒绝熔断器（连续 3 次 / 单会话总计 20 次拒绝 → 强制回退）。  
> 现状痛点：[`Agent`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts) 主循环在 [`_act`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L222-L272) 中遇到 approval middleware 拒绝时仅写一条 tool_result `Error: Tool use rejected by user`；模型可能反复尝试同一被拒工具，无安全网。

##### 1.11.1 数据结构 & 阈值

```ts
// src/agent/session/types.ts
export interface RejectionCircuitState {
  /** 连续拒绝次数；任一工具被批准就清零 */
  consecutive: number;
  /** 整个 session 累计拒绝次数 */
  total: number;
  /** 触发熔断后置 true，agent 主循环优雅退出 */
  tripped?: boolean;
  /** 触发原因，trace event 用 */
  trippedReason?: "consecutive" | "total";
}

export const REJECTION_LIMITS = {
  consecutive: 3,
  total: 20,
} as const;
```

##### 1.11.2 落点：approval middleware + agent loop

```ts
// src/coding/permissions/coding-approval-middleware.ts（修改）
beforeToolUse: async ({ toolUse, session }) => {
  const decision = await maybeAsk(...);
  if (decision === "rejected") {
    session.rejection.consecutive += 1;
    session.rejection.total += 1;
    if (session.rejection.consecutive >= REJECTION_LIMITS.consecutive) {
      session.rejection.tripped = true;
      session.rejection.trippedReason = "consecutive";
    } else if (session.rejection.total >= REJECTION_LIMITS.total) {
      session.rejection.tripped = true;
      session.rejection.trippedReason = "total";
    }
    return { rejected: true };
  }
  if (decision === "approved") {
    session.rejection.consecutive = 0;   // ← 重置连续计数
  }
}

// src/agent/agent.ts:stream() —— 每步开头检查（唯一新增的 agent.ts 改动点）
for (let step = 1; step <= maxSteps; step++) {
  if (session?.rejection.tripped) {
    yield systemNote(`Agent halted: ${session.rejection.trippedReason} rejection limit reached.`);
    return;
  }
  ...
}
```

##### 1.11.3 验收 / 兼容

- v0 行为：旧版无 session 时跳过熔断检查（`session?.` 短路），现有 212 测试不受影响
- 新增单测：mock askUser 始终拒绝，断言第 4 次工具调用前主循环退出
- trace event：`{ type: "rejection_circuit_tripped", reason, consecutive, total }`

##### 1.11.4 与 §7 风险评估的关系

- 这一节是对原 §7 缺失"拒绝熔断"的**补强**，不替换其它风险条目
- 加入 §6 验收基线：连续 3 次工具拒绝后 agent 主循环必然终止

#### 1.12 借鉴点速览（来自 19 篇 Claude Code 评论的 agent / profile 相关条目）

> 这一节只列条目和落点；**不展开实现**，等用户确认 outline 后进入 spec 阶段再细化。  
> 标注：⭐⭐⭐ 必采纳 / ⭐⭐ MVP 借鉴 / ⭐ 可选 / ⏳ v3。

| # | 借鉴点 | 落点 | 优先级 | 来源 |
|---|---|---|---|---|
| B1.1 | systemPrompt 分段（global static + dynamic）+ DYNAMIC_BOUNDARY 标记 | §1.3 AgentProfile.systemPrompt 类型扩展为 `{ global: string \| string[]; dynamic?: (ctx) => string \| string[] }` | ⭐⭐ | 10-context-assembly |
| B1.2 | AGENTS.md 加载支持 6 层 + 自下而上目录遍历（user / project / local / auto） | §1.5 步骤 1 抽到 `loadAgentsMdMessage` helper，支持目录遍历 | ⭐ | 10 |
| B1.3 | `@include` 递归（深度上限 + 循环防护） | 模块 1.5 步骤 1 复用到 `src/agent/skills/skill-reader.ts` 现有 markdown 加载 | ⭐ | 10 |
| B1.4 | 启动分阶段装配（trust-independent → trust-dependent → runtime-deferred） | §1.4 装配伪码补 trust gate 注释 | ⭐ | 12-startup-bootstrap |
| B1.5 | 提醒系统轮次调度（todo / plan 不每轮重复注入，按 N 轮 1 次） | §1.5 todoSystem 中间件加轮次调度 | ⭐ | 10 |
| B1.6 | 流空闲 watchdog 90s + 重试矩阵（429/529/401/400 PTL/ECONNRESET） | foundation/models 加 `withRetry()` 包装；community/openai 适配 | ⭐⭐ | 01,15 |
| B1.7 | beta header / fast_mode 会话锁存（保护 prompt cache 键稳定） | foundation/models 引入"粘性锁存三态" | ⭐ | 15,16 |
| B1.8 | parentSessionId trace 链（与 telemetry / web /traces 联动） | §1.10 AgentSession.parentSessionId 已含；web 端补血统视图 | ⭐ | 17 |
| B1.9 | 模型代号 / 卧底模式 / KAIROS 等 | 不采纳（违反 helixent 透明原则） | ❌ | 17 |



### 模块 2 · Toolkit 配置体系（**核心优化点 → 你提的"加新 tool 改动多 + 难调试"**）

#### 2.1 现状盘点：tool 相关的代码层

| 层 | 文件 | 角色 |
|---|---|---|
| **数据结构** | [`src/foundation/tools/function-tool.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/foundation/tools/function-tool.ts) | `FunctionTool<P,R>` 接口 + `defineTool()` 工厂 |
| | [`src/foundation/tools/structured-tool-result.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/foundation/tools/structured-tool-result.ts) | `StructuredToolResult` = success `{ok,summary,data?}` \| error `{ok,summary,error,code?,details?}` |
| | [`src/foundation/tools/index.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/foundation/tools/index.ts) | `Tool = FunctionTool` 别名 |
| **结果归一** | [`src/agent/tool-result-runtime.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/tool-result-runtime.ts) | `normalizeToolResult` / `formatToolResultForMessage` / `inferToolErrorKind` |
| **结果策略** | [`src/agent/tool-result-policy.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/tool-result-policy.ts) | **按工具名 switch** 决定 summary-only / max-string-length |
| **TUI 摘要** | [`src/agent/tool-result-summary.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/tool-result-summary.ts) | 通用 |
| **TUI 渲染** | [`src/cli/tui/message-text.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/cli/tui/message-text.ts#L50-L77) | **按工具名 switch** 输出 ANSI 摘要 |
| | `src/cli/tui/components/message-history.tsx` | **按工具名 switch** 输出 Ink 组件 |
| **审批白名单** | [`src/coding/permissions/requires-approval.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/permissions/requires-approval.ts) | **硬编码字符串数组**：bash/write_file/str_replace/apply_patch/mkdir/move_path |
| **审批 middleware** | [`src/coding/permissions/coding-approval-middleware.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/permissions/coding-approval-middleware.ts#L20-L42) | `if (!options.requiresApproval.includes(toolUse.name)) return` |
| **lead-agent 装配** | [`src/coding/agents/lead-agent.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/agents/lead-agent.ts#L103-L117) | 12 行 `import` + 13 项 `tools: [...]` |
| **工具实现** | `src/coding/tools/<name>.ts × 13` | 每个 `defineTool({ name, description, parameters: z.object({...}), invoke })` |
| **工具单测** | `src/coding/tools/__tests__/<name>.test.ts × 13` | 各自手写 |
| **辅助** | [`src/coding/tools/tool-result.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/tools/tool-result.ts) | `okToolResult` / `errorToolResult` 包装器 |
| | [`src/coding/tools/tool-utils.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/tools/tool-utils.ts) | `ensureAbsolutePath` / `ensureDirectoryPath` / `truncateText` |

#### 2.2 加一个新 tool 当前要改 7 处

| # | 位置 | 改动内容 |
|---|---|---|
| 1 | `src/coding/tools/<new>.ts` | 新写 `defineTool` |
| 2 | [`lead-agent.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/agents/lead-agent.ts#L14-L29) | 加一行 import |
| 3 | [`lead-agent.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/agents/lead-agent.ts#L103-L117) | 加进 `tools: [...]` 数组 |
| 4 | [`requires-approval.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/permissions/requires-approval.ts) | 若需审批，写名字 |
| 5 | [`tool-result-policy.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/tool-result-policy.ts#L14-L44) | 加 case（决定结果在 prompt 里多大） |
| 6 | [`message-text.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/cli/tui/message-text.ts#L50-L77) | 加 case（ANSI 渲染） |
| 7 | `src/cli/tui/components/message-history.tsx` | 加 case（Ink 渲染） |
| 8 | `__tests__/<new>.test.ts` | 从零写测试，没模板 |

> 第 2 / 3 / 4 / 5 / 6 / 7 全部是"**重复登记**"——同一个工具名要在 6 个文件里手输一遍。这就是你说的"改动多"。

#### 2.3 调试痛点

- **没法单跑一个 tool**：必须起整个 agent loop（model 调用、middleware 链、Approval 弹窗）
- **没有 dry-run**：想看 zod 校验会怎么报错，必须造一次完整工具调用
- **Tool 失败诊断粗糙**：[`agent.ts:235-238`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L235-L238) 把任何异常 catch 后塞成 `Error: ${message}` 字符串；zod 的 issue path 信息丢失
- **没有 golden fixture 模板**：每个 [`*.test.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/tools/__tests__) 自己造 mock，重复劳动
- **结果策略错位**：新增 tool 不加入 [`tool-result-policy.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/tool-result-policy.ts) 就走 `DEFAULT_POLICY`（4000 字硬上限），可能模型直接把大 JSON 全吞，token 爆炸
- **TUI 渲染 fallback 难看**：未在 switch 命中时只渲染 `Tool call └─ <name>`（[`message-text.ts:74-75`](file:///Users/bytedance/Documents/Codex/helixent/src/cli/tui/message-text.ts#L74-L75)），无 description / 参数

#### 2.4 优化设计：把 7 处压到 2 处

**核心思路：tool 自带元数据 → 自动派生其它逻辑**

##### 2.4.1 `defineTool` 字段扩展（向后兼容）

```ts
// src/foundation/tools/function-tool.ts —— 改造后
export interface FunctionTool<P = z.ZodSchema<...>, R = unknown> {
  name: string;
  description: string;
  parameters: P;
  invoke: (input, signal?) => Promise<R>;

  // ↓↓↓ 新增可选字段（不破坏 v0）↓↓↓

  /** 该 tool 的能力归属；driver 后续 approval / 渲染分类 / sandbox 策略 */
  capabilities?: Capability[];

  /** TUI / Web / log 通用渲染摘要：替代各处 switch (toolUse.name) */
  summarize?: (input: z.infer<P>) => ToolSummary;

  /** 默认是否要求 description 字段必填（v0 12 个 tool 都要求；简单 tool 可关） */
  requiresDescription?: boolean;        // default: true

  /** prompt 大小策略（替代 tool-result-policy.ts 的 switch） */
  resultPolicy?: Partial<ToolResultPolicy>;
}

export interface ToolSummary {
  /** 主标题，如 "Read file" / "Bash" / "Grep" */
  title: string;
  /** 单行细节，如 "/abs/path/to/file" / "ls -la" / "src :: foo" */
  detail?: string;
  /** 图标种类（TUI 用），未来可扩展（read/write/exec/network/think/...） */
  kind?: "read" | "write" | "exec" | "network" | "think" | "ask" | "other";
}
```

**示例：v0 工具迁移后**

```ts
// src/coding/tools/file-info.ts
export const fileInfoTool = defineTool({
  name: "file_info",
  description: "Return metadata about a file or directory at an absolute path.",
  parameters: z.object({ description: z.string()..., path: z.string()... }),
  invoke: async ({ path }) => { ... },

  // 新增：
  capabilities: ["read_fs"],
  summarize: ({ description, path }) => ({ title: description, detail: path, kind: "read" }),
  // 不写 resultPolicy → 走 toolkit 默认 + DEFAULT_POLICY
});
```

##### 2.4.2 改动收口（最终对比）

| # | 旧改动 | 新改动 |
|---|---|---|
| 1 | tool 文件 | tool 文件（多写 `capabilities` + `summarize`） |
| 2 | lead-agent import + tools 数组 | **toolkit 文件**（一行 import + push） |
| 3 | requires-approval.ts 加名字 | ❌ **删除**：approval 从 capability 派生 |
| 4 | tool-result-policy.ts 加 case | ❌ **删除**：从 `tool.resultPolicy ?? toolkit.defaultPolicy ?? DEFAULT_POLICY` 派生 |
| 5 | message-text.ts 加 case | ❌ **删除**：fallback 用 `tool.summarize?.(input) ?? { title: name, detail: undefined }` |
| 6 | message-history.tsx 加 case | ❌ **删除**：同上，共享 `getToolSummary(toolUse, registry)` helper |
| 7 | 测试 | `defineToolTest({ tool, fixtures })` 模板（见 2.6） |

**净改动：从 7 处压到 2 处（tool 文件 + toolkit 注册一行）**

##### 2.4.3 Toolkit 抽象

```ts
// src/agent/toolkits/types.ts
export type Capability =
  | "read_fs"      // 文件读
  | "write_fs"     // 文件写 / 改 / 删
  | "exec"         // 子进程 / shell
  | "network"      // 出网（HTTP / RPC / MCP）
  | "ask_user"     // 阻塞等用户输入
  | "delegation";  // 触发 sub-agent

export interface Toolkit {
  /** 唯一 id（profile / CLI / API 引用） */
  id: string;
  description: string;
  /** 静态数组 或 工厂（依赖 ctx 的 toolkit，比如 agent-core 要 askUserQuestion callback） */
  tools: Tool[] | ((ctx: AgentProfileRuntimeContext) => Tool[]);
  /** 默认能力集（每个 tool 的 capabilities 也可以再覆盖，但通常用 toolkit 默认） */
  capabilities: Capability[];
  /** toolkit 级 result policy 默认（被 tool.resultPolicy 覆盖） */
  defaultPolicy?: Partial<ToolResultPolicy>;
}
```

##### 2.4.4 内置 5 个 toolkit 拆分

| toolkit id | 工具 | capabilities | 备注 |
|---|---|---|---|
| `coding-fs-readonly` | read_file / list_files / glob_search / grep_search / file_info | `read_fs` | 默认 `preferSummaryOnly: true`（搜索类） |
| `coding-fs-write` | write_file / str_replace / apply_patch / mkdir / move_path | `write_fs` | 默认审批；max 4000 |
| `coding-shell` | bash | `exec` | 默认审批 |
| `agent-core` | todo_write + 可选 ask_user_question | `ask_user` | 工厂式 tools，依赖 ctx.todoSystem & ctx.askUserQuestion |
| `community-mcp` | 动态（mcpToolkit 工厂返回） | `network` | 见模块 4 |

> v0 12 个工具每个文件加 2 行（capabilities + summarize），其它逻辑自动派生。

##### 2.4.5 capability-driven approval middleware（重构 + 兼容）

```ts
// src/coding/permissions/coding-approval-middleware.ts —— 改造后
export function createCodingApprovalMiddleware(options: {
  cwd: string;
  /** 新：基于 capability 命中 */
  requiresCapabilities?: Set<Capability>;
  /** 旧：基于工具名（v0 兼容路径，标 @deprecated） */
  requiresApproval?: string[];
  /** 装配期注入：toolName → capability 集合 */
  toolCapabilities?: Map<string, Set<Capability>>;
  approvalPersistence?: ApprovalPersistence;
  askUser: (toolUse: ToolUseContent) => Promise<ApprovalDecision>;
}): AgentMiddleware {
  return {
    beforeToolUse: async ({ toolUse }) => {
      const matchedByCap = options.requiresCapabilities && options.toolCapabilities
        ? [...(options.toolCapabilities.get(toolUse.name) ?? [])]
            .some((c) => options.requiresCapabilities!.has(c))
        : false;
      const matchedByName = options.requiresApproval?.includes(toolUse.name) ?? false;
      if (!matchedByCap && !matchedByName) return;
      // 余下逻辑与 v0 一致：检查 allowList → askUser → persist
      ...
    },
  };
}
```

**好处**：新增任意写文件 / 执行 tool，只要标 `capabilities: ["write_fs"]` 或 `["exec"]`，自动被审批拦截，不用碰 `requires-approval.ts`。

##### 2.4.6 Tool registry（用于 TUI summary fallback）

```ts
// src/agent/tools/registry.ts
const tools = new Map<string, Tool>();
export function getToolByName(name: string): Tool | undefined { return tools.get(name); }
export function registerTools(list: Tool[]): void { for (const t of list) tools.set(t.name, t); }
```

`createAgentFromProfile` 装配末尾 `registerTools(allTools)`；TUI / Web 渲染时 `tool = getToolByName(toolUse.name); summary = tool?.summarize?.(toolUse.input) ?? defaultSummary(toolUse)`。

#### 2.5 调试体验改造

##### 2.5.1 CLI playground

```bash
bun run tool <tool_name> '<json_input>' [--cwd <path>]
```

- 不启动 agent，不需要 model；从 toolkit registry 取出 tool
- 走 zod 校验 → invoke → 打印 `formatToolResultForMessage` 输出（与 agent 实际看到的一样）
- zod 失败时打印 `issue.path.join(".") + " → " + issue.message`，而不是整个 stringified error
- 支持 `--cwd` 用于 `ensureAbsolutePath` 类工具

```ts
// src/cli/commands/tool.ts（新增）
export async function runToolCommand(name: string, jsonInput: string, opts: { cwd?: string }) {
  const tool = getToolByName(name);
  if (!tool) { console.error(`Unknown tool: ${name}`); process.exit(1); }
  let parsed;
  try { parsed = tool.parameters.parse(JSON.parse(jsonInput)); }
  catch (e) {
    if (e instanceof z.ZodError) {
      for (const i of e.issues) console.error(`× ${i.path.join(".")} → ${i.message}`);
      process.exit(2);
    }
    throw e;
  }
  const result = await tool.invoke(parsed);
  console.log(formatToolResultForMessage({ toolName: name, result }));
}
```

##### 2.5.2 Tool 失败诊断（改 agent.ts，**唯一一处需要小动 agent 主循环**）

```ts
// src/agent/agent.ts:_act —— catch 分支增强
} catch (error) {
  if (error instanceof z.ZodError) {
    const lines = error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return { index, ..., result: errorToolResult(`Invalid input: ${lines}`, "INVALID_INPUT", { issues: error.issues }) };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { index, ..., result: `Error: ${message}` };  // 与 v0 一致
}
```

> 这是模块 1 之外**唯一**需要碰 [`agent.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts) 的地方。改动控制在 catch 分支内，不影响主循环结构，完全向后兼容（旧测试断言走 `Error:` 前缀仍可命中）。

##### 2.5.3 golden test helper

```ts
// src/foundation/tools/__tests__/define-tool-test.ts
export function defineToolTest<P,R>({ tool, fixtures }: {
  tool: FunctionTool<P,R>;
  fixtures: Array<
    | { name: string; input: z.infer<P>; snapshotFile: string }      // success: 比对快照
    | { name: string; input: z.infer<P>; expectErrorCode: string }   // error: 断言 code
    | { name: string; input: unknown; expectZodIssuePath: string[] } // schema 校验失败
  >;
}): void {
  describe(tool.name, () => {
    for (const fx of fixtures) {
      test(fx.name, async () => { ... });
    }
  });
}
```

新增 tool 测试只要写 4-5 个 fixture，golden snapshot 自动生成 / 比对。

##### 2.5.4 TUI tool-trace 增强

- TUI 在 [`message-text.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/cli/tui/message-text.ts) 用 `tool.summarize(input)` 渲染 → 一致摘要
- 失败时若 result 含 `errorKind === "invalid_input"` 与 `details.issues`，TUI 多渲染一行：`zod: <path> → <msg>`
- `tool.summarize` 返回 `kind` 用于上色（read 灰 / write 黄 / exec 红 / ask 蓝），所有 tool 全局统一

#### 2.6 渐进迁移策略（不破坏 v0）

**P1（地基）**
1. `defineTool` 加 4 个可选字段（仅类型 + 透传，无新行为）
2. `Toolkit` 类型 + registry + 5 个空骨架
3. `Capability` 联合类型

**P2（搬运）**
4. v0 12 个 tool 各加 2 行（`capabilities` + `summarize`）
5. tool 文件按 5 个 toolkit 重新分组（仅 import 路径，不改语义）
6. `createCodingApprovalMiddleware` 双路径（capability + 兼容旧 string[]）

**P3（清理）**
7. `lead-agent.ts` 改薄壳；删除 13 行 `tools: [...]` 内联
8. `tool-result-policy.ts` 改读 `tool.resultPolicy`；旧 switch 标 deprecated 保留 1 版本
9. `message-text.ts` / `message-history.tsx` 改用 `tool.summarize`；旧 switch 删

**P4（增强）**
10. `bun run tool` playground
11. zod issue 高亮（agent.ts catch 分支增强）
12. `defineToolTest` helper

> P1 + P2 完成时**还没人能感受到行为变化**；P3 才让 lead-agent 真正瘦下来；P4 给开发者解锁调试。

#### 2.7 验证策略

| 检查 | 方式 |
|---|---|
| 12 个 v0 tool 行为不变 | 现有 `__tests__/*.test.ts` 全部继续通过（[`apply-patch.test.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/tools/__tests__/apply-patch.test.ts) 等 12 份） |
| 13 个 tool 在 agent.tools 中可见 | `coding-tools-roundtrip.test.ts`（新增） |
| approval 触发等价 | 新 capability-driven 路径 + 旧 name-list 路径双断言 |
| TUI / Web 渲染等价 | `frontend-smoke.test.ts` 增加每个 tool summarize 输出快照 |
| playground 可跑 | `bun run tool file_info '{"description":"x","path":"/etc/hosts"}'` 输出 OK |
| zod 高亮 | 故意传错参数，断言输出含 `path → message` |

#### 2.8 借鉴点速览（来自 19 篇 Claude Code 评论的 tool / permission 相关条目）

> 标注：⭐⭐⭐ 必采纳 / ⭐⭐ MVP 借鉴 / ⭐ 可选 / ⏳ v3。

| # | 借鉴点 | 落点 | 优先级 | 来源 |
|---|---|---|---|---|
| B2.1 | `defineTool` fail-closed 默认值（`isReadOnly=false / isConcurrencySafe=false / requiresDescription=true` 危险位都安全档） | §2.4.1 字段扩展时把默认值显式写出 | ⭐⭐ | 02-tool-system |
| B2.2 | 行为标志动态判定（`isReadOnly(input)` 接受 input） | §2.4.1 `summarize` 已是函数；`isReadOnly?: boolean \| ((input) => boolean)` | ⭐ | 02 |
| B2.3 | `assembleToolPool` 分区排序：内置工具按名排序作前缀，MCP/动态作后缀 | §1.4 装配伪码 step 2 加 `allTools.sort()` + 分区 | ⭐⭐ | 02 |
| B2.4 | `maxResultSizeChars` + 大结果落盘 + 返回 preview ref | §2.4.1 加入 `defineTool.resultPolicy`；与模块 4 L0 Offload 共用 ContextStore（避免双轨） | ⭐⭐⭐ | 02 |
| B2.5 | `contextModifier` + 并发互斥（`isConcurrencySafe=false` 才允许改 context） | ⏳ v3：cwd 切换 / set_env 工具用 | ⏳ | 02 |
| B2.6 | FileStateCache 共享给 read/edit/write/apply_patch + 过时写入守卫 | ⏳ v3（已与你确认不并入二期） | ⏳ | 02 |
| B2.7 | FileReadTool 同范围去重 stub（`file_unchanged` 占位） | ⏳ v3 | ⏳ | 02 |
| B2.8 | tool input 分"模型可见 vs 内部注入"两层（`internalOnly` 字段防绕过，借鉴 `_simulatedSedEdit`） | §2.4.1 加 `defineTool.internalParams?: ZodSchema` | ⭐ | 06-bash-engine |
| B2.9 | bash 工具：shell snapshot 复用 + CWD 持久化 + AsyncGenerator 进度 + 大小看门狗 SIGKILL | `src/coding/tools/bash` 单独迭代（不进通用化二期，作为独立 follow-up） | ⭐⭐ | 06 |
| B2.10 | 命令分类（search/read/silent/semantic-neutral）UI 折叠 | §2.4.1 `ToolSummary.kind` 已含；TUI 渲染按 kind 折叠 | ⭐ | 06 |
| B2.11 | 拒绝规则在发送给模型前预过滤（不到 canUseTool 拦截） | §1.4 装配 step 2 完成后按 capability 预过滤 | ⭐ | 02 |
| B2.12 | 七步权限流水线 + 6 种模式 + 绕过免疫硬拒绝（`.git/`/`.claude/`/shell 配置） | §1.3 Capability 加"无条件硬拒绝"档；coding-approval-middleware 加路径黑名单 | ⭐⭐ | 07-permission |
| B2.13 | `requiresUserInteraction` 即使 bypass 也提示 | §2.4.1 加 `defineTool.requiresUserInteraction?: boolean` | ⭐ | 07 |
| B2.14 | 危险权限剥离/恢复（进入 auto 模式暂存 `Bash(*)` 等高危规则） | ⏳ v3（helixent 当前没有 auto 模式） | ⏳ | 07 |
| B2.15 | YOLO 分类器 / OS 沙箱 / 23 种 bash 注入检测 | 不采纳（成本极高，定位错配） | ❌ | 07,06 |



### 模块 3 · Profile 只读 Web UI（B 方向 MVP）
- `/api/profiles` GET 端点
- Web 左侧栏新增 "Agents" 入口 → 卡片列表（id / name / desc / toolkit chip / prompt 摘要）
- 不做表单编辑、增删改（留 v3）

#### 3.1 借鉴点速览（来自 19 篇 Claude Code 评论的 web / TUI / API 层条目）

| # | 借鉴点 | 落点 | 优先级 | 来源 |
|---|---|---|---|---|
| B3.1 | spawn 子进程 + NDJSON 双向通信作为跨进程 agent 协议（v3 Web 后端方案） | ⏳ v3（已与你确认不并入二期） | ⏳ | 13-bridge-system |
| B3.2 | `--print --stream-json` SDK 风格入口（适合 CI / 编辑器集成） | ⏳ v3 | ⏳ | 13 |
| B3.3 | Token 警告 4 档状态机（ok / warn / error / blocking） | 模块 4 §4.14.6 已含；Web /agents 顶部复用 | ⭐⭐ | 11,14 |
| B3.4 | AsyncGenerator 重试管道 + 中间状态事件（向 web 推送"重试中"提示） | foundation/models（与模块 1 §1.10 querySource 联动） | ⭐ | 15 |
| B3.5 | 35 行 `createStore` + `useSyncExternalStore`（Web 端 React 状态） | ⏳ v3 | ⏳ | 14-ui-state |
| B3.6 | virtual scroll + WeakMap 高度缓存（长会话渲染性能） | ⏳ v3 | ⏳ | 14 |
| B3.7 | `/context` 可视化命令（按段落细分 token / cache 占用） | ⏳ v3，TUI / Web 通用 | ⏳ | 10 |
| B3.8 | 客户端 request_id 注入（debug 友好，超时时 server 不返回） | foundation/models 可选注入 | ⭐ | 15 |
| B3.9 | undercover / 远程紧急开关 / 模型代号 | 不采纳（违反开源透明） | ❌ | 17 |

### 模块 4 · Offload & Compact 机制（**重写 · 优先级置于 MCP 之前**）

> 参考资料：
> - 用户提供的两篇飞书文档（Offload/Compact 双轨设计原则；第三篇 `bytedance.larkoffice.com` 因浏览器策略未读入，**不作为已验证依据**）
> - [Claude Code Compact System 源码分析](https://github.com/openedclaude/claude-reviews-claude/blob/main/architecture/zh-CN/11-compact-system.md)（5 层 pipeline + cache_edits）
> - [Anthropic Cookbook: Automatic context compaction](https://platform.claude.com/cookbook/tool-use-automatic-context-compaction)（compaction_control + summary tags）
> - Morphllm: [/compact 命令说明](https://www.morphllm.com/claude-code-compact)
> - VILA Lab: [Dive into Claude Code 5-layer compaction pipeline](https://zhiqiangshen.com/projects/Claude_Code_Report/Claude_Code_Report.pdf)
>
> Helixent 当前**无任何 offload / compact 机制**，长会话必然撞 token 上限。优先级 > MCP。

#### 4.1 概念区分（**借鉴飞书设计原则**）

| 概念 | 性质 | 触发条件 | 信息损失 | 是否可逆 |
|---|---|---|---|---|
| **Offload** | **无损搬家** | tool result 体积超阈值 | 0（保留 ref，可重取） | 是 |
| **Microcompact** | **有损规则** | 每次 API call 前 / token 70-80% | 仅丢"陈旧大 result" | 否 |
| **SessionMemory**（v3）| 后台异步摘要 | 持续后台跑 | 0（增量提取） | 否 |
| **Autocompact** | **有损 LLM** | token ≥ 90% | 大（重写历史） | 否 |
| **Manual `/compact`** | 用户主动 | slash command | 同 Autocompact | 否 |

**核心原则（先无损后有损）**：

```
            [Tool Result 生成]
                  │
                  ▼
            体积 > 8K char？──Y──► Offload to ContextStore (无损)
                  │
                  N
                  ▼
            ┌─────────────────────────────────────┐
            │ token 占比             触发动作     │
            ├─────────────────────────────────────┤
            │ < 70%                  noop          │
            │ 70-80%                 标记候选      │
            │ 80-90%                 Microcompact  │
            │ 90-95%                 Autocompact   │
            │ ≥ 95%                  强制裁剪      │
            └─────────────────────────────────────┘
```

#### 4.2 Helixent 现状盘点

| 维度 | 现状 | 文件 |
|---|---|---|
| 消息持久化 | `Agent.messages` 数组**只增不减** | [`agent.ts:274-276`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L274-L276) `_appendMessage` |
| 上下文构建 | 每步把全部 `messages` 透传给 model | [`agent.ts:_think`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L173-L205) → `modelContext.messages = this.messages` |
| Tool result 单条上限 | [`tool-result-policy.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/tool-result-policy.ts) 4-12K | **新结果有截断，旧结果不会回收** |
| Token 统计 | [`AssistantMessage.usage`](file:///Users/bytedance/Documents/Codex/helixent/src/foundation/messages/types/message.ts#L37-L38) 仅 prompt/completion/total | 无 cache_read / cache_creation |
| Cache 控制 | [`openai/utils.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/community/openai/utils.ts) 透传 messages | 不带 `cache_control` / `cache_edits` |
| 持久化层 | 无 | 暂无 ContextStore 类似设施 |

**结论**：长会话 → token 线性膨胀 → 撞 model 上限 → 报错。这是一期最大的产品缺口。

#### 4.3 设计目标分层（MVP 范围）

| 层 | MVP 是否做 | 备注 |
|---|---|---|
| **L0 Offload**（无损搬家） | ✅ | 飞书文档提议；MVP 核心 |
| **L1 Microcompact**（规则）| ✅ | Claude Code 第一层 |
| **L2 SessionMemory**（异步摘要）| ❌（v3） | 需要后台 agent，复杂度大 |
| **L3 Autocompact**（自动 LLM 摘要）| ❌（v3） | 需要 token 估算 + boundary fallback |
| **L4 Manual `/compact`** | ✅ | TUI slash command |
| **L5 Context Collapse**（极长历史）| ❌（v3） | Claude Code 第四层，Helixent 还远没到这量级 |

> **取舍**：MVP 做 L0 + L1 + L4。L0 是飞书文档的核心创新，性价比最高（无损 + 实现成本低）；L1+L4 与 Claude Code 一致；L2/L3/L5 留 v3。

#### 4.4 L0 · Offload（无损搬家） 设计

##### 4.4.1 数据结构

```ts
// src/agent/context-store/types.ts（新增）
export interface OffloadedPayload {
  id: string;              // 形如 "off_abc123"
  toolName: string;
  toolUseId: string;
  contentType: "tool_result" | "tool_arg";
  payload: string;         // 原文
  size: number;            // chars
  createdAt: number;       // ms
  meta?: {
    path?: string;
    command?: string;
    [k: string]: unknown;
  };
}

export interface ContextStore {
  put(payload: Omit<OffloadedPayload, "id" | "createdAt">): Promise<string>;
  get(id: string): Promise<OffloadedPayload | null>;
  list(filter?: { toolName?: string; since?: number }): Promise<OffloadedPayload[]>;
  gc(olderThanMs: number): Promise<number>;
}
```

##### 4.4.2 默认实现：`InMemoryContextStore`

```ts
// src/agent/context-store/in-memory.ts
export function createInMemoryContextStore(opts?: { maxBytes?: number }): ContextStore { ... }
```

- **MVP 仅 in-memory**：单 session 生命周期；进程退出即丢
- **v3 扩展**：`FileSystemContextStore`（写到 `.helixent/context-store/`）/ `RedisContextStore`

##### 4.4.3 Offload 触发：`OffloadMiddleware`

```ts
// src/agent/compact/offload-middleware.ts
export function createOffloadMiddleware(options: {
  store: ContextStore;
  /** result size 超过该值触发 offload（默认 8000 char） */
  maxResultSize?: number;
  /** 触发 offload 的 capability 集合（默认 read_fs + exec） */
  candidateCapabilities?: Set<Capability>;
}): AgentMiddleware {
  return {
    afterToolUse: async ({ toolUse, toolResult, agentContext }) => {
      if (toolResult.result.length < (options.maxResultSize ?? 8000)) return;
      const id = await options.store.put({
        toolName: toolUse.name,
        toolUseId: toolUse.id,
        contentType: "tool_result",
        payload: toolResult.result,
        size: toolResult.result.length,
        meta: extractMeta(toolUse),
      });
      // 替换为引用占位符（保留 token 锚点）
      toolResult.result = `[offloaded ref=${id} size=${toolResult.result.length}c tool=${toolUse.name}]\n${toolResult.result.slice(0, 200)}…`;
    },
  };
}
```

> **关键**：保留前 200 字符摘要 + ref id，让 model 仍能"看到"轮廓；如需完整内容，后续可加一个 `read_offloaded(ref_id)` 工具按需取回（v3）。

##### 4.4.4 args 非对称处理（**借鉴飞书原则**）

> 飞书文档提到：args 只压"本身就是数据"的参数（如 `apply_patch.patch` 大 diff）；results 只压"大且可重取"的返回。

**MVP 不动 args**：
- args offload 收益小（apply_patch 的 patch 内容是关键决策记录，不该藏起来）
- 风险高（如果 model 后续需要"我刚才写了什么"，offload 后无法重建）
- 留 v3 决定

#### 4.5 L1 · Microcompact 设计

##### 4.5.1 候选规则

只动**绝对安全**的 tool_result。候选条件全部满足：

```ts
1. content.type === "tool_result"
2. 不在最近 N 条消息内（默认 N=2）
3. 工具 capability ⊆ ["read_fs"]（read_file / list_files / glob_search / grep_search / file_info）
4. 该 tool_result 占用 ≥ 500 char
5. 不被后续 assistant 文本字面引用（heuristic：assistant text 含 tool_use_id）
```

> **与 Claude Code 对照**：Claude Code 候选集额外含 `bash` / `web_*` / `file_edit` / `file_write`。Helixent MVP 更保守，**仅压 read_fs**：因为 bash 输出可能是关键 stack trace；写类工具结果代表"已完成的副作用"，丢了会让模型重复操作。

##### 4.5.2 替换策略

```
[microcompacted: read_file path=/abs/foo.ts at step 3 — 8423 chars omitted]
```

保留 `tool_use_id` / `type` 字段。

##### 4.5.3 集成方式：middleware（**只改 modelContext 副本**）

```ts
// src/agent/compact/microcompact-middleware.ts
export function createMicrocompactMiddleware(options?: {
  minBytesPerResult?: number;     // 默认 500
  preserveRecent?: number;        // 默认 2
  candidateCapabilities?: Set<Capability>;
  emitCacheEdits?: (edits: CacheEdit[]) => void;
}): AgentMiddleware {
  return {
    beforeModel: async ({ modelContext }) => {
      const { messages, edits } = compactMessages(modelContext.messages, options);
      options?.emitCacheEdits?.(edits);
      return { messages };  // 仅改本次副本
    },
  };
}
```

> **与 Claude Code 关键差异**：
> - Claude Code 在**热缓存**时用 `cache_edits` API，从服务端缓存副本删除工具结果（不破坏前缀缓存命中）
> - Helixent OpenAI 路径**没有 cache_edits**，因此 MVP 直接改本次发送的 messages 副本（接受 cache miss）
> - **但保留** `emitCacheEdits` hook 留给未来 community/anthropic 直连接入

##### 4.5.4 与 cache 的兼容性

| Provider | 兼容策略 |
|---|---|
| OpenAI 兼容（v0）| 接受 cache miss；net 收益是少发 8K 字符 |
| Anthropic 直连（未来） | `cache_control: ephemeral` + `cache_edits` 真正零破坏 |

#### 4.6 L4 · Manual `/compact` 设计

##### 4.6.1 流程

```
1. 用户输入 /compact [可选指令]
2. 暂停当前输入
3. 用简化 modelContext（system prompt + 当前 messages + 1 条 user 总结指令）
4. 一次 model.invoke（非 stream，**禁用 tools**）
5. 拿到 SummaryText
6. 重写 agent.messages 为：
   [
     { role: "user",      content: [{ type: "text", text: "[Conversation summary]\n" + SummaryText }] },
     { role: "assistant", content: [{ type: "text", text: "Acknowledged. Continuing..." }] }
   ]
7. yield system 通知 "Conversation compacted (~N → ~M tokens)"
```

##### 4.6.2 Summary prompt 模板（**借鉴 Claude Code 风格**）

```
Summarize the conversation so far for the next agent step. Preserve:
- All decided plans / TODOs (with status)
- File paths and line ranges referenced
- User preferences and constraints
- Outstanding questions or blockers
- Currently tracked offloaded refs (if any)
Drop verbose tool outputs that won't be needed again.
Output as bullet points under headings:
## Decisions
## Files
## TODOs
## Open Questions
## Offloaded Refs
{user_extra_instruction}
```

##### 4.6.3 实现要点

```ts
// src/agent/compact/manual-compact.ts
export async function compactConversation(agent: Agent, options?: {
  prompt?: string;
  preserveRecent?: number;     // 默认 2
  userInstruction?: string;    // /compact 后跟随的额外指令
}): Promise<{ before: number; after: number; summary: string }>
```

- **不走 ReAct loop**，直接 `model.invoke()`
- 总结期间禁用 tool（model 只产文本）
- 总结后**重新读 AGENTS.md 并注入**（Morphllm 文档强调的最佳实践 —— "CLAUDE.md 在 compact 后从磁盘重新注入"）

##### 4.6.4 TUI slash command

源码引用：[`src/cli/tui/`](file:///Users/bytedance/Documents/Codex/helixent/src/cli/tui) 已有 slash 机制（`/skill`）。新增 `/compact [instruction]` 走相同路径。

#### 4.7 Token 阈值策略（**借鉴飞书 + Claude Code**）

```ts
// src/agent/compact/threshold-policy.ts
export interface ThresholdPolicy {
  maxContextTokens: number;          // model 上限（per-profile 配置）
  thresholds: {
    mark: number;       // 默认 0.70 — 标记候选
    microcompact: number; // 默认 0.80 — 触发 L1
    autocompact: number;  // 默认 0.90 — 触发 L3（v3）
    forceTruncate: number; // 默认 0.95 — 强制裁剪
  };
}
```

**MVP 实现**：仅在每次 `beforeModel` 估算 input_tokens（粗略 char/4）；超过阈值触发对应动作。

> **不实现完整估算器**：用 char/4 作为 token 近似（OpenAI tiktoken 不引入避免依赖）。误差 ±20% 在阈值场景下可接受。

#### 4.8 Trace Events（**借鉴飞书"观测指标"**）

新增 trace event：

```ts
type CompactEvent =
  | { type: "offload_triggered"; ref: string; toolName: string; sizeBytes: number }
  | { type: "microcompact_triggered"; removed: number; freedTokens: number }
  | { type: "manual_compact_triggered"; before: number; after: number }
  | { type: "context_pressure"; ratio: number; threshold: keyof ThresholdPolicy["thresholds"] };
```

落点：[`web/server.ts`](file:///Users/bytedance/Documents/Codex/helixent/web/server.ts) trace stream + TUI status bar。
观测看：触发频率、节省 tokens、ref 恢复次数（v3 加 `read_offloaded`）。

#### 4.9 受影响源码

**新增**
- `src/agent/context-store/types.ts` — Offload 数据结构
- `src/agent/context-store/in-memory.ts` — InMemoryContextStore
- `src/agent/compact/offload-middleware.ts` — L0
- `src/agent/compact/microcompact-middleware.ts` — L1
- `src/agent/compact/manual-compact.ts` — L4
- `src/agent/compact/threshold-policy.ts` — 阈值策略
- `src/agent/compact/types.ts` — `CacheEdit` / `CompactOptions` / `CompactEvent`
- `src/agent/compact/__tests__/*.test.ts`
- `src/agent/context-store/__tests__/*.test.ts`

**修改**
- [`src/coding/profiles/coding.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/profiles/coding.ts)（依赖模块 1）— 注册 offload + microcompact middleware
- [`src/cli/tui/`](file:///Users/bytedance/Documents/Codex/helixent/src/cli/tui) slash command 列表 — 加 `/compact`
- [`src/foundation/messages/types/message.ts:3-7`](file:///Users/bytedance/Documents/Codex/helixent/src/foundation/messages/types/message.ts#L3-L7) `TokenUsage` — 加 `cacheReadTokens?: number; cacheCreationTokens?: number`（可选）
- [`src/community/openai/utils.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/community/openai/utils.ts)（如响应有 cache 字段）— 透传

**不影响**
- [`Agent`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts) 主循环（compact 全在 middleware + 外部函数）
- v0 全部测试（middleware 默认不挂；TokenUsage 新增字段可选）

#### 4.10 验证策略

| 检查 | 方式 |
|---|---|
| Offload 不破坏 tool_result 结构 | 单测：构造 1 条 12K result，跑 middleware，断言 store 有 ref + result 替换为占位符 + tool_use_id 不变 |
| InMemoryContextStore put/get/gc 完备 | 单测覆盖 4 个接口方法 + size 限额逐出 |
| Microcompact 不动高压线 | 单测：bash / write_file / 最近 N 条不被裁 |
| Microcompact 不动小 result | 单测：500 字以下不裁 |
| Manual compact 后能继续对话 | E2E：mock agent 跑 5 轮 → /compact → 再跑 1 轮，断言 messages.length 减少且能正常继续 |
| 阈值估算 char/4 误差可接受 | 单测：构造 10 条已知 token 消息，断言估算值在 ±25% 内 |
| Trace event 正确 emit | 单测：触发 offload 后断言 trace 含 `offload_triggered` |
| TokenUsage 新字段可选 | 现有 [`tool-result-runtime.test.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/__tests__/tool-result-runtime.test.ts) 持续通过 |

#### 4.11 失败模式（**借鉴飞书"failure modes"**）

| 失败 | 表现 | 缓解 |
|---|---|---|
| Offload ref 丢失 | model 引用 `off_xxx` 但 store gc 已清 | gc 仅清"未引用且超时"；ref 在 message 中即视为引用 |
| Microcompact 误删关键引用 | model 后续报"找不到上次读的内容" | heuristic 检查 + 默认保守阈值 |
| Manual compact 总结质量低 | 总结丢失关键决策 | 用户可附 `/compact preserve auth fix and test failures` 指令 |
| Cache miss 暴增 | OpenAI 请求成本上升 | 在 trace 监控；用户可关闭 microcompact middleware |
| char/4 估算偏差大 | 阈值触发不准 | 阈值留 ±10% buffer；触发后再估实际 input_tokens 校准 |

#### 4.12 V1 实施路线（按优先级）

```
P4.1  ContextStore 接口 + InMemoryContextStore
P4.2  OffloadMiddleware（L0）+ 单测
P4.3  MicrocompactMiddleware（L1）+ 单测
P4.4  ThresholdPolicy 估算 + 触发联动
P4.5  Trace Events 串联到 web server / TUI status
P4.6  Manual /compact slash command（L4）
P4.7  集成到 coding profile + 端到端 smoke
```

#### 4.13 不做（留 v3）

- L2 SessionMemory（后台 agent 增量摘要）
- L3 Autocompact（token 上限自动触发 LLM 摘要）
- L5 Context Collapse（极长历史折叠）
- `read_offloaded(ref_id)` 工具（按需取回）
- args offload（飞书原则建议但风险大）
- cache_edits API 集成（需 community/anthropic）
- 跨 session 持久化 ContextStore
- 阈值自适应学习

#### 4.14 来自 Claude Code 源码的额外借鉴点（**深读后补充**）

> 读完 [Claude Code compact-system 源码评论](https://github.com/openedclaude/claude-reviews-claude/blob/main/architecture/zh-CN/11-compact-system.md) 后追加 9 个值得借鉴的具体机制。每条都标"采纳/MVP 借鉴/v3 留底"。

##### 4.14.1 时间触发微压缩（Time-based Microcompact） · MVP 借鉴

> Claude Code `timeBasedMCConfig.ts`：当距最后一条 assistant 消息超过阈值时间，**服务器缓存本来就冷了**，直接清除旧工具结果（暴力路径，无 cache_edits 包袱）。

**Helixent MVP 借鉴**：

```ts
// src/agent/compact/microcompact-middleware.ts
export interface TimeBasedTrigger {
  /** 最后 assistant 消息时间戳 ≥ 该 ms 间隔 → 触发暴力清除 */
  staleAfterMs: number;       // 默认 5 * 60 * 1000（5 分钟）
  /** 暴力清除时仍保留最近 N 条 tool_result */
  preserveRecent: number;     // 默认 3
}
```

价值：用户中断后 5 分钟回来继续对话，**cache 已过期**，此时 microcompact 可以更激进地清而不增加 cache miss 成本。MVP 直接修改 `agent.messages`（不只改副本），与"热路径只改副本"区分开。

##### 4.14.2 API 不变量保护（adjustIndexToPreserveAPIInvariants）· **必须采纳**

> Claude Code `sessionMemoryCompact.ts` 80+ 行专门做这件事：保留范围内的 `tool_result` 必须有匹配的 `tool_use`；流式同 message.id 的 assistant chunks 必须一起保留。

**Helixent 必须采纳**：

```ts
// src/agent/compact/api-invariants.ts（新增）
export function adjustBoundaryToPreserveInvariants(
  messages: Message[],
  boundaryIndex: number
): number {
  // 规则 1：tool_use 与 tool_result 不可拆分
  //   若 boundary 左侧最后一条是 tool_use 而右侧首条不是对应 tool_result → 边界向右扩
  //   若 boundary 右侧首条是孤儿 tool_result → 边界向右扩
  // 规则 2：同一 assistant message_id 的连续条目不拆分（v0 暂无 message_id，留 v3）
  return adjustedIndex;
}
```

> **为什么必须采纳**：如果 microcompact 误删了 tool_use 但保留了 tool_result，OpenAI / Anthropic API 都会**直接报 400** —— 这是硬错误，不是软退化。

##### 4.14.3 熔断器（Circuit Breaker）· MVP 借鉴

> Claude Code 引用 BQ 数据：1,279 个会话有 50+ 次连续 autocompact 失败，全球每天浪费约 250K API 调用。`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`。

**Helixent MVP 借鉴**：

```ts
// src/agent/compact/manual-compact.ts
const MAX_CONSECUTIVE_COMPACT_FAILURES = 3;

// 在 agent state 上加：
interface AgentRuntime {
  consecutiveCompactFailures: number;
}

// /compact 命令前检查
if (agent.consecutiveCompactFailures >= MAX_CONSECUTIVE_COMPACT_FAILURES) {
  return { error: "Compact disabled after 3 consecutive failures. Restart session." };
}
```

价值：避免 model error 导致用户连续按 `/compact` 把 token 配额烧光。

##### 4.14.4 递归防护（不压缩压缩器自己）· MVP 必须

> Claude Code：`querySource === 'compact' || 'session_memory' → return false`，不在 compact 内部再触发 compact。

**Helixent 必须采纳**：

```ts
// src/agent/compact/manual-compact.ts
// 调用 model.invoke 时传一个标志位：
const summaryResponse = await model.invoke({
  ...,
  metadata: { compactInProgress: true },
});

// microcompact-middleware 在 beforeModel 检查：
if (modelContext.metadata?.compactInProgress) return undefined;
```

价值：避免 microcompact 把"请总结对话"指令本身误删。

##### 4.14.5 分析草稿本（`<analysis>` 注入前剥离）· MVP 借鉴

> Claude Code `prompt.ts`：summary prompt 提供 `<analysis>` 块让 model 思考；`formatCompactSummary()` 在注入到 messages 前剥离。

**Helixent MVP 借鉴**：升级 4.6.2 的 prompt：

```
First, in <analysis> tags, brainstorm:
- What are the user's true goals across the session?
- Which decisions were reversed/superseded?
- Which file paths must survive?

Then output the actual summary in <summary> tags using the headings below:
## Decisions
## Files
## TODOs
## Open Questions
## Offloaded Refs
```

注入 messages 时只取 `<summary>...</summary>` 内容；`<analysis>` 完全丢弃。

价值：质量明显提升，**额外 token 全部丢弃，不污染压缩后上下文**。

##### 4.14.6 Token 告警状态机 · MVP 借鉴

> Claude Code `calculateTokenWarningState`：`percentLeft / isAboveWarningThreshold / isAboveErrorThreshold / isAtBlockingLimit` 4 个布尔位驱动 TUI 颜色变化。

**Helixent MVP 借鉴**：

```ts
// src/agent/compact/threshold-policy.ts
export interface TokenWarningState {
  percentLeft: number;            // 0-1
  level: "ok" | "warn" | "error" | "blocking";
  // ok: < 70%; warn: 70-80%; error: 80-95%; blocking: ≥ 95%
}
```

落点：[`src/cli/tui/components/topbar.tsx`](file:///Users/bytedance/Documents/Codex/helixent/src/cli/tui)（一期已有 status-dot 6 色）+ Web 顶部显示。`blocking` 时**禁止用户输入**，仅允许 `/compact`。

价值：用户可视化感知压力 → 主动 `/compact` 而非等到崩溃。

##### 4.14.7 压缩后恢复（PostCompact Recovery）· **核心采纳**

> Claude Code 压缩后注入 7 类内容：最近读取的 5 个文件（50K 预算） / 已用技能（25K 预算）/ 活跃计划 / 计划模式指令 / 延迟工具增量 / Agent 列表增量 / MCP 指令增量。

**Helixent MVP 采纳子集**（按现有能力裁剪）：

```ts
// src/agent/compact/post-compact-recovery.ts（新增）
async function restoreContextAfterCompact(agent: Agent, opts: {
  recentFileBudget?: number;     // 默认 30K char
  perFileBudget?: number;        // 默认 5K char
}): Promise<NonSystemMessage[]> {
  return [
    // 1. AGENTS.md 重新读 + 注入（Morphllm 也强调这点）
    ...await loadAgentsMdMessage(agent.cwd),
    // 2. 最近读过的 5 个文件路径（不含内容，只列表 + 短摘要）
    //    从 ContextStore offloaded payloads 推断
    ...await summarizeRecentFiles(agent.contextStore, opts),
    // 3. 当前 todoStore snapshot（v0 已有 todoSystem）
    ...buildTodoSnapshotMessage(agent.todoSystem),
    // 4. 活跃 skills 列表（v0 已有 skill-reader）
    ...buildActiveSkillsMessage(agent.skillsState),
  ];
}
```

价值：用户感知"compact 后没忘事"。**这是 compact 体验好坏的关键**，比 prompt 模板更重要。

> 不做（v3）：MCP 指令增量、agent 列表增量、计划模式（plan mode v0 没引入）。

##### 4.14.8 压缩后清缓存（postCompactCleanup）· MVP 借鉴

> Claude Code `postCompactCleanup.ts`：`readFileState.clear()` —— 因为压缩期间外部文件可能变化，旧缓存可能过时。

**Helixent MVP 借鉴**：[`tool-result-runtime.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/tool-result-runtime.ts) 如有任何 dedup / cache 状态，compact 后清空一次。

实际检查：v0 [`tool-result-runtime.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/tool-result-runtime.ts) 目前**无跨调用缓存**（每次 normalize 独立），因此 MVP 无需特殊清理。**留 hook**：

```ts
agent.on("compact:done", () => {
  // 当前为 noop；未来加 cache 时在此清
});
```

##### 4.14.9 9 段摘要模板（升级现有 5 段）· MVP 借鉴

> Claude Code 摘要分 9 节：主要请求/意图、关键技术概念、文件代码段、错误修复、问题解决、所有用户消息、待办、当前工作、可选下一步（含原文引用）。

**Helixent MVP 升级**：4.6.2 prompt 从 5 段升级到 8 段（去掉 Claude Code 的"代码段含完整片段"，因为 Helixent 直接 offload 文件内容了）：

```
<summary>
## 1. 主要请求与意图
## 2. 关键技术概念
## 3. 文件与路径（仅路径，文件内容已 offloaded）
## 4. 错误与修复
## 5. 待办任务
## 6. 当前工作
## 7. 用户消息要点（保留原话，不要改写）
## 8. 可选下一步
</summary>
```

> **关键**：第 7 节"保留用户原话"是 Claude Code 强调的最佳实践 —— 用户意图追踪用原文比改写后的版本可靠。

##### 4.14.10 部分压缩方向（Partial Compact）· **v3 留底**

> Claude Code `partialCompactConversation()` 支持 `'from'` / `'up_to'` 两个方向。`'from'` 保留早期消息为 prefix → cache 友好；`'up_to'` 保留尾部 → cache 失效。

**MVP 不做**（manual compact 默认 `'from'` 语义即可）；v3 加 `/compact --keep-recent N` 选项。

##### 4.14.11 PTL（Prompt Too Long）重试 · **v3 留底**

> Claude Code 防御性逻辑：summary 请求自身超 token 时按 API 轮组截断，最多 3 次重试。

**MVP 不做**：依赖 model 上下文窗口足够大（200K+）。如真撞 PTL，提示用户分段 `/compact --range 0..50`。v3 实现自动重试。

##### 4.14.12 借鉴清单速览

| Claude Code 机制 | Helixent 落点 | MVP 优先级 |
|---|---|---|
| 时间触发微压缩 | 4.14.1 microcompact 加 staleAfterMs | ⭐⭐ MVP 借鉴 |
| API 不变量保护 | 4.14.2 adjustBoundaryToPreserveInvariants | ⭐⭐⭐ **必须** |
| 熔断器 | 4.14.3 MAX_CONSECUTIVE_COMPACT_FAILURES | ⭐⭐ MVP 借鉴 |
| 递归防护 | 4.14.4 compactInProgress 标志 | ⭐⭐⭐ **必须** |
| `<analysis>` 草稿本 | 4.14.5 升级 prompt | ⭐⭐ MVP 借鉴 |
| Token 告警状态机 | 4.14.6 4 级 + TUI 配色 | ⭐⭐ MVP 借鉴 |
| PostCompact Recovery | 4.14.7 注入 AGENTS.md / 文件列表 / todo / skills | ⭐⭐⭐ **核心采纳** |
| postCompactCleanup hook | 4.14.8 留事件钩子 | ⭐ MVP hook |
| 9 段摘要模板 | 4.14.9 升级到 8 段 | ⭐⭐ MVP 借鉴 |
| 部分压缩方向 | 4.14.10 | v3 |
| PTL 重试 | 4.14.11 | v3 |

##### 4.14.13 受影响清单（增量）

**新增文件**
- `src/agent/compact/api-invariants.ts` — 不变量保护
- `src/agent/compact/post-compact-recovery.ts` — 上下文恢复
- `src/agent/compact/__tests__/api-invariants.test.ts`
- `src/agent/compact/__tests__/post-compact-recovery.test.ts`

**修改**
- 4.6.2 manual compact prompt → 升级 8 段 + `<analysis>` 草稿本
- 4.5 microcompact-middleware → 加 timeBasedTrigger / compactInProgress 防护
- 4.7 ThresholdPolicy → 加 `TokenWarningState` 4 级
- 4.10 验证策略 → 加"不变量保护"和"recovery 注入 AGENTS.md"两条单测

**新增验收基线**（追加到第 6 章）
- 不变量保护：构造孤儿 tool_result，断言 microcompact 不会拆 tool_use/result 对
- 熔断器：mock 3 次失败后第 4 次禁用 `/compact`
- 递归防护：summary 调用期间 microcompact 不触发
- PostCompact Recovery：`/compact` 后 messages 必含 AGENTS.md + todo snapshot

#### 4.15 借鉴点速览（19 篇通读后补 compact 之外的相关条目）

> 4.14 已有 11 条专门 compact 借鉴；这一节补"模块 4 周边"的设计点，避免落地时重复探索。

| # | 借鉴点 | 落点 | 优先级 | 来源 |
|---|---|---|---|---|
| B4.1 | JSONL append-only + parent-UUID 链作为 ContextStore v3 持久化形态 | §4.4.2 InMemoryContextStore 之外，v3 加 `FileSystemContextStore` 用此格式 | ⭐⭐ | 09-session-persistence |
| B4.2 | 64KB 头尾窗口轻量读取 + metadata re-append（会话列表只读首尾） | ⏳ v3，会话恢复 / `--resume` 时用 | ⏳ | 09 |
| B4.3 | 双写入路径（异步 100ms 合并 + 同步退出兜底） | ⏳ v3 | ⏳ | 09 |
| B4.4 | 中断检测 + 合成"继续"消息（Ctrl+C 后 resume 关键） | ⏳ v3 | ⏳ | 09 |
| B4.5 | 子 agent 转录隔离到 sub-directory `{session}/subagents/agent-{id}.jsonl` | §模块 6 + ContextStore；与 §1.10 parentSessionId 联动 | ⭐⭐ | 09 |
| B4.6 | `tokenCountWithEstimation()` 混合精度（API usage 真相 + 之后估算） | §4.7 ThresholdPolicy 升级（用 char/4 启动 + usage 校准） | ⭐⭐ | 16 |
| B4.7 | `+500k fix the bug` 用户预算指令解析（消息中嵌入 token 预算） | ⏳ v3，TUI / cli 解析 | ⏳ | 16 |
| B4.8 | 错误分类系统：解析 prompt-too-long token gap（actual / limit） | §4.14.11 PTL 重试 v3 落地时直接用 | ⭐ | 15 |
| B4.9 | 前台/后台 query 重试白名单（非主交互 529 立即放弃） | §1.10 已贯穿 querySource；foundation/models 重试矩阵据此分类 | ⭐⭐ | 15 |
| B4.10 | 调用过 skill 用复合键 `${agentId}:${skillName}` 在 compact 后保留 | §4.14.7 PostCompact Recovery 步骤 4（buildActiveSkillsMessage）按复合键 | ⭐ | 10 |
| B4.11 | DreamTask + priorMtime 回滚锁（后台整理 MEMORY.md，被中断可回滚） | ⏳ v3（L2 SessionMemory 时再考虑） | ⏳ | 08 |
| B4.12 | 时间触发微压缩（5 分钟 idle 后 cache 已冷，可激进清） | §4.14.1 已含 | ✅ 已含 | 11 |

---

### 模块 5 · MCP toolkit（C 方向 MVP）
- `src/community/mcp/`：Stdio JSON-RPC client（仅 stdio，不做 SSE/HTTP）
- `mcpToolkit({ command, args, env? })` 工厂 → 装成 `Toolkit`
- CLI config 加 `mcpServers?` 字段（兼容 Claude Desktop 格式）
- 错误隔离：启动失败 / 5s 超时 → warn + 空 toolkit

#### 5.1 借鉴点速览（来自 19 篇 Claude Code 评论的 MCP / plugin 相关条目）

| # | 借鉴点 | 落点 | 优先级 | 来源 |
|---|---|---|---|---|
| B5.1 | 工具命名 `mcp__{server}__{tool}` 规范 + assembleToolPool 分区排序保 cache 稳定 | §1.4 装配 + §模块 5 mcpToolkit 命名 | ⭐⭐⭐ | 02 |
| B5.2 | ToolSearch 延迟加载 + `defer_loading: true` + searchHint + 模型未读 schema 直接调用时注入"先调用 ToolSearch"提示 | §模块 5：MCP 工具数 ≥ N（默认 30）时启用延迟加载 | ⭐⭐ | 02 |
| B5.3 | MCP 6 种 transport（stdio / sse / http / ws / sdk / sse-ide） | MVP 仅 stdio；v3 加 http；其它 ⏳ | ⭐ | 15 |
| B5.4 | 增量附件（`deferred_tools_delta` / `mcp_instructions_delta`）：工具集中途变化只发 delta | ⏳ v3，MCP server 热重载场景 | ⏳ | 10 |
| B5.5 | 代际计数器（`currentGeneration === initializationGeneration`）防过期初始化覆盖 | §模块 5：MCP server 重连时用 | ⭐⭐ | 15 |
| B5.6 | stale-while-error 配置（远程失败时用本地缓存） | ⏳ v3 | ⏳ | 16,17 |
| B5.7 | Plugin = skills + hooks + mcpServers 三元组 | 不做（过早抽象） | ❌ | 04-plugin |
| B5.8 | 60K plugin schema / GCS 市场 / 远程黑名单 | 不采纳 | ❌ | 04 |
| B5.9 | Skill frontmatter `whenToUse / allowedTools / executionContext: inline\|fork` | `src/agent/skills/skill-reader.ts` 补强（独立于 MCP，与模块 5 同步推进） | ⭐⭐ | 04 |
| B5.10 | Skill 列表 token 预算三级降级（完整 / 截断 / 仅名称） | ⏳ v3 | ⏳ | 04 |
| B5.11 | Skill 多源优先级合并（项目 > 用户 > 内置） | `src/agent/skills/`：当前仅单目录，扩展为多层级 | ⭐ | 04 |
| B5.12 | 声明式 MCP server 生命周期 reconcile（期望状态 → diff → 应用） | ⏳ v3 | ⏳ | 04 |
| B5.13 | Workspace trust gate：未信任目录不加载第三方 skills/MCP | §模块 5 启动前检查；与 B1.4 trust-gate 装配联动 | ⭐⭐ | 05,12,16 |

### 模块 6 · Sub-agent 委派（D 方向 MVP）
- 内置工具 `delegate_task({ profile_id, prompt, max_steps? })`
- spawn 新 `Agent`(profile + 同 model)，跑完返回最后一条 assistant text
- **限制**：1 层委派；同步等待；sub-agent 默认无 ask_user
- 仅当 profile 引用 `agent-orchestration` toolkit 才出现

#### 6.1 借鉴点速览（来自 19 篇 Claude Code 评论的 sub-agent / coordinator 相关条目）

| # | 借鉴点 | 落点 | 优先级 | 来源 |
|---|---|---|---|---|
| B6.1 | 协调者工具集**架构级**受限（只能用 delegate / send_message / task_stop） | §模块 6：派生 `coordinatorProfile`；toolkit 只装 `agent-orchestration`，不含 fs/exec | ⭐⭐⭐ | 03-coordinator |
| B6.2 | Worker 默认零上下文 + Fork 模式（继承父级）二选一 | §模块 6：`delegate_task({ mode: "fresh" \| "fork" })`，默认 `fresh` | ⭐⭐⭐ | 03 |
| B6.3 | `<task-notification>` XML 包在 user message 回传完成结果（复用 Message 类型） | §模块 6：sub-agent 完成时 lead 收到一条 user-role tool_result，含 task-id / status / usage | ⭐⭐ | 03,08 |
| B6.4 | `{name}@{teamName}` 确定性 agent ID + parentSessionId 血统追踪 | §1.10 已含 parentSessionId；agent ID 格式定为 `{profileId}#{shortHash}` | ⭐⭐ | 08 |
| B6.5 | 结构化 message types（`shutdown_request` / `plan_approval_request` / `permission_request`） | §模块 6 子 agent 间通信不止纯文本 | ⭐ | 08 |
| B6.6 | Scratchpad 共享目录 + 该目录内操作免确认 | ⏳ v3，多 sub-agent 协作场景 | ⏳ | 03 |
| B6.7 | Research → Synthesis → Implementation → Verification 四阶段读写隔离模板 | ⏳ v3，作为 lead-agent 推荐 prompt | ⏳ | 03,08 |
| B6.8 | "不要委托理解"原则写入协调者 system prompt | §模块 6：`coordinatorProfile.systemPrompt` 首句 | ⭐ | 03 |
| B6.9 | 权限委托链（worker 无 TTY → leader 弹 prompt → 回写） | ⏳ v3，与 web /CI 场景相关 | ⏳ | 08 |
| B6.10 | tmux / iTerm2 后端 / git worktree / UDS 跨会话 | 不采纳（MVP 仅进程内） | ❌ | 08 |
| B6.11 | Skill executionContext: fork 模式实际等价"触发一次 sub-agent run" | §模块 6 + B5.9：fork-skill 落地点就是 `delegate_task` | ⭐ | 04 |

---

## 3. 受影响的代码（高层）

**新增**
- `src/agent/session/` · `src/agent/context-store/` · `src/agent/messages/`
- `src/agent/profiles/` · `src/agent/toolkits/` · `src/agent/orchestration/`
- `src/coding/profiles/{coding,research}.ts` · `src/coding/toolkits/*.ts`
- `src/community/mcp/{types,stdio-client,toolkit}.ts`
- `web/public/app/agents.js`（+ index.html 入口）

**修改**
- [`src/coding/agents/lead-agent.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/agents/lead-agent.ts) — 变薄壳
- [`src/coding/permissions/coding-approval-middleware.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/permissions/coding-approval-middleware.ts) — 升级为 permission chain + 拒绝熔断
- [`src/foundation/tools/function-tool.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/foundation/tools/function-tool.ts) — 扩展最小 Tool Contract
- `src/foundation/models/*` — 增加 querySource metadata 与最小 retry 事件
- `src/cli/index.tsx` — `--profile` option
- `src/cli/config/schema.ts` — `mcpServers`
- `web/server.ts` — `/api/profiles`

**保持兼容**
- v0 `createCodingAgent` 公开签名和默认行为不变
- Web trace 现有事件不破坏，只追加新事件
- foundation/messages 对外类型尽量不改；只新增 API 前 invariant guard / normalize helper

---

## 4. 推进顺序与并行策略

```
Phase 0  Runtime 地基（先打承重墙）
   ├── AgentSession + querySource
   ├── message invariant guard
   └── rejection state / retry event
   │
Phase 1  Tool Contract + Toolkit
   ├── defineTool 扩展
   ├── toolkit 拆分与稳定排序
   └── coding toolkit parity
   │
Phase 2  Profile + Permission
   ├── AgentProfile / createAgentFromProfile
   ├── createCodingAgent 薄壳化
   └── permission chain + 拒绝熔断
   │
Phase 3  Context 安全网
   ├── resultPolicy offload
   ├── microcompact
   └── manual /compact
   │
   ├──► Phase 4  MCP MVP（stdio + connection union）
   │
   ├──► Phase 5  Sub-agent MVP（同步 1 层 + session-aware）
   │
   └──► Phase 6  Web /agents（只读收口，可后移）

Phase 7  bun run check 全绿 + 手测 happy path
```

并行策略：Phase 0-2 不建议并行拆太散，先统一地基和工具契约；Phase 3 完成后，MCP / Sub-agent / Web 可以并行推进。

---

## 5. 关键决策（先列出，详细推演留给后续 spec）

| 决策点 | 选项 | 倾向 |
|---|---|---|
| Runtime 地基 | 先 profile/toolkit / 先 AgentSession | **先 AgentSession**（承接 retry / compact / sub-agent 状态） |
| `Agent` 改造方式 | 重写 QueryEngine / 保留主循环 + 外挂 session | **保留主循环**（只新增会话宿主与外围 guard） |
| Toolkit 引用形式 | 仅 string id / 仅对象 / 混合 | **混合**（id 字符串 + 内联 Toolkit 对象，便于 mcpToolkit() 直接传入） |
| approval 触发判定 | 工具名白名单 / capability 集合 | **capability**（v0 字段保留 deprecated） |
| `defineTool` description | 一律必填 / 可关闭 | **可关闭，默认必填**（无 breaking） |
| Compact 策略 | 全自动 / manual-first | **manual-first**（先 offload + microcompact + `/compact`） |
| MCP transport | stdio / HTTP / SSE | **MVP 仅 stdio** |
| Sub-agent 深度 | 1 层 / 多层 | **1 层**（防止递归爆炸） |
| Profile UI | 前置交付 / 后置收口 | **后置收口**（不阻塞 runtime 地基） |

---

## 5.5 Claude Code 源码借鉴升级分类（避免散点化）

> 这一节把前面从 Claude Code 评论和 [`claude-code-analysis/src`](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src) 真实源码里学到的点重新分层。  
> 目标不是"把 Claude Code 全搬过来"，而是判断：**哪些是二期承重墙，哪些是二期增强，哪些只保留接口形状，哪些必须延后**。

### 5.5.1 分类总览

| 分类 | 定义 | 二期处理方式 | 代表机制 |
|---|---|---|---|
| A. 运行时地基 | 后续 profile / compact / MCP / sub-agent 都依赖的宿主能力 | **必须进二期，优先于 Web UI / MCP 扩展** | `AgentSession`、`querySource`、message invariant guard、usage / rejection state |
| B. 工具平台化 | 解决"加新 tool 改动多、难调试、审批散落" | **必须进二期，但做最小闭环** | `defineTool.capabilities`、`summarize`、`resultPolicy`、permission chain |
| C. 长会话安全网 | 解决 token 爆炸、工具大结果、compact 后失忆 | **二期做 MVP，复杂策略留 v3** | offload、microcompact、manual compact、PostCompact Recovery |
| D. 生态接入形状 | 为 MCP / sub-agent 预留正确抽象，避免后续推倒 | **二期做窄版，但类型形状向 Claude 学** | `McpServerConnection` union、session-aware sub-agent |
| E. 观测与体验 | 让运行时能力可见、可调试 | **只做与 MVP 绑定的最小 trace / UI** | retry event、compact event、profile API |
| F. 明确延后 | Claude Code 很强但对二期不是承重墙 | **不进二期，只记录为 v3** | Bash v2、Bridge、custom Ink、telemetry/growthbook、复杂 swarm |

### 5.5.2 A 类：运行时地基（必须升级）

#### A1 · `AgentSession`：从"装配平台"升级为"运行时平台"

**Claude 源码依据**：
- [`QueryEngine.ts`](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/QueryEngine.ts#L184-L207) 明确持有会话级状态：messages / abort / permission denials / usage / readFileState。
- [`query.ts`](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/query.ts#L203-L217) 的 `queryLoop` 只持有单轮 loop 状态。

**Helixent 当前问题**：
- [`Agent`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts) 只有 ReAct loop，没有会话级宿主。
- usage、compact 状态、拒绝计数、sub-agent 血统如果继续塞 middleware/global，会越来越散。

**二期升级**：
```ts
export interface AgentSession {
  id: string;
  parentSessionId?: string;
  agent: Agent;
  usage: Map<string, TokenUsage>;
  currentSource: QuerySource;
  rejection: RejectionCircuitState;
  compactInProgress: boolean;
  consecutiveCompactFailures: number;
  contextStore: ContextStore;
}
```

**落点**：
- 保留 §1.10，并在 spec 里新增 requirement。
- `createAgentFromProfile()` 不只返回 `Agent`，还应能创建/绑定 `AgentSession`。
- sub-agent、compact、model retry 都从 session 读取 `sessionId/source/parentSessionId`。

#### A2 · `querySource`：不是日志字段，而是行为开关

**Claude 源码依据**：
- [`withRetry.ts`](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/services/api/withRetry.ts#L170-L517) 区分重试状态。
- compact / background 类请求不应像主对话一样无限消耗重试预算。

**二期升级**：
```ts
export type QuerySource =
  | "main"
  | "compact"
  | "microcompact"
  | `sub-agent:${string}`
  | "skill-fork"
  | "hook-agent";
```

**行为规则**：
- `main`：529 可有限重试，给用户可见状态。
- `compact` / `microcompact`：529 不做长重试，失败后回退不阻塞主对话。
- `sub-agent:*`：有限重试，失败汇总给父 agent。
- `hook-agent`：失败关闭，不反复烧 token。

#### A3 · Message invariant guard：compact / fallback 前的安全栅栏

**Claude 源码依据**：
- [`normalizeMessagesForAPI()`](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/utils/messages.ts#L1989-L2238)
- [`ensureToolResultPairing()`](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/utils/messages.ts#L5133-L5252)

**二期升级**：
- 新增 `validateApiMessageInvariants(messages)` 或 `normalizeMessagesForModel(messages)`。
- 至少保证：
  - `tool_use` 必须有对应 `tool_result`
  - `tool_result` 不能孤儿出现
  - compact / offload 不得切断 `tool_use ↔ tool_result`
  - fallback / error recovery 要补 synthetic tool_result

**为什么必须进二期**：
- 只要二期做 offload/compact/sub-agent，就必然会改写 messages。
- 没有 guard，问题会表现成 provider 400，很难从业务层定位。

### 5.5.3 B 类：工具平台化（必须做，但做窄）

#### B1 · `defineTool` 扩展：从函数工具升级为最小 Tool Contract

**Claude 源码依据**：
- [`Tool.ts`](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/Tool.ts#L362-L695) 的 `Tool` 包含权限、并发、只读、渲染、结果、上下文修改等完整契约。
- [`buildTool()`](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/Tool.ts#L743-L792) 给保守默认值。

**二期不全搬，只加 5 个字段**：
```ts
defineTool({
  name,
  description,
  parameters,
  execute,
  capabilities?: Capability[];
  summarize?: ToolSummarizer;
  resultPolicy?: ToolResultPolicy;
  requiresUserInteraction?: boolean | ((input) => boolean);
  isReadOnly?: boolean | ((input) => boolean);
});
```

**解决的问题**：
- approval 不再靠工具名硬编码。
- TUI/Web 不再各写一套 tool switch。
- 大结果处理不再靠工具名特殊判断。
- 只读 profile / research profile 可以基于 `isReadOnly/capabilities` 装配。

#### B2 · Permission chain：从 capability 命中升级为有序短路链

**Claude 源码依据**：
- [`hasPermissionsToUseTool()`](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/utils/permissions/permissions.ts#L473-L956)
- [`hasPermissionsToUseToolInner()`](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/utils/permissions/permissions.ts#L1158-L1319)

**二期最小链路**：
```text
工具级 deny
  -> 工具级 ask
  -> tool input / capability check
  -> requiresUserInteraction
  -> safety guard
  -> capability approval
  -> allow
```

**明确不做**：
- 不做 YOLO classifier。
- 不做企业 policy 合并。
- 不做复杂 Bash AST 权限。

#### B3 · 拒绝熔断器：防止模型撞墙

**Claude 借鉴**：
- 连续拒绝和总拒绝都要计数。
- 拒绝不是普通 tool error；反复拒绝会诱发模型循环尝试。

**二期规则**：
```ts
export const REJECTION_LIMITS = {
  consecutive: 3,
  total: 20,
} as const;
```

**落点**：
- approval middleware 负责记录 deny。
- agent step 开始前检查 `session.rejection.tripped`。
- trace event：`rejection_circuit_tripped`。

### 5.5.4 C 类：长会话安全网（二期 MVP）

#### C1 · Offload：优先级高于完整 compact

**为什么先做**：
- Helixent 当前最直接的问题是工具结果进入上下文后只增不减。
- Claude Code 的 compact 很完整，但我们不需要第一版就做 5 层。

**二期 MVP**：
- `resultPolicy.maxResultSizeChars`
- `ContextStore.put(ref, content)`
- tool_result 中保留 preview + ref
- 只对高体积、低风险工具先启用：`read_file` / `grep` / `glob`

**不做**：
- 不 offload tool args。
- 不 offload 写类工具的关键结果。
- 不做 API native `cache_edits`。

#### C2 · Microcompact：规则型清理，不先上智能摘要

**Claude 源码依据**：
- [`microcompactMessages()`](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/services/compact/microCompact.ts#L253-L293)
- time-based microcompact 见 [`microCompact.ts`](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/services/compact/microCompact.ts#L422-L530)

**二期 MVP**：
- 只清理旧的大工具结果。
- 保留最近 N 个工具结果。
- 永远不拆 `tool_use/tool_result` 对。

#### C3 · Manual compact：能用，但不做全自动复杂策略

**Claude 源码依据**：
- [`compactConversation()`](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/services/compact/compact.ts#L387-L763)
- [`buildPostCompactMessages()`](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/services/compact/compact.ts#L325-L338)

**二期 MVP**：
- TUI `/compact` 触发。
- 生成 8 段摘要。
- compact 后注入 recent files / todo snapshot / active skills 的最小 recovery。
- compact 失败最多 3 次后熔断。

**延后 v3**：
- auto compact。
- session memory compact。
- partial compact。
- preservedSegment 重链。
- API native context management。

### 5.5.5 D 类：生态接入形状（做窄版，接口别写死）

#### D1 · MCP：MVP 只做 stdio，但状态类型要学 Claude

**Claude 源码依据**：
- [`McpServerConfig`](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/services/mcp/types.ts#L124-L161)
- [`MCPServerConnection`](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/services/mcp/types.ts#L180-L227)
- [`connectToServer()`](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/services/mcp/client.ts#L595-L607)

**二期 MVP**：
```ts
type McpServerConnection =
  | { type: "pending"; name: string }
  | { type: "connected"; name: string; tools: Tool[]; cleanup: () => Promise<void> }
  | { type: "failed"; name: string; error: string }
  | { type: "disabled"; name: string; reason?: string };
```

**只做**：
- stdio transport
- `tools/list`
- `tools/call`
- failed server 不阻塞其它 server / 内置工具

**不做**：
- HTTP / SSE / WS
- needs-auth
- elicitation
- resources / prompts

#### D2 · Sub-agent：同步 1 层，但 session-aware

**Claude 源码依据**：
- [`spawnInProcessTeammate()`](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/utils/swarm/spawnInProcess.ts#L104-L204)
- [`TaskState`](file:///Users/bytedance/Documents/Codex/claude-code-analysis/src/tasks/types.ts#L12-L19)

**二期 MVP**：
- `delegate_task` 仍然同步返回。
- 内部必须带：
  - `parentSessionId`
  - `querySource = sub-agent:${id}`
  - `delegationDepth`
  - `AbortController`

**返回结构**：
```ts
interface DelegationResult {
  taskId: string;
  sessionId: string;
  status: "completed" | "failed" | "cancelled";
  summary: string;
  usage?: TokenUsage;
}
```

**延后**：
- tmux / iTerm2 pane
- mailbox
- plan approval request
- 多 agent swarm

### 5.5.6 E 类：观测与体验（只做 MVP 绑定项）

| 能力 | 二期是否做 | 原因 |
|---|---|---|
| `retrying` / `api_error` event | ✅ 做 | `withRetry` 如果不可见，用户会以为卡死 |
| `offload_triggered` / `compact_triggered` | ✅ 做 | 验证长会话安全网是否生效 |
| `rejection_circuit_tripped` | ✅ 做 | 解释 agent 为什么停住 |
| Web `/agents` profile 卡片 | 🟡 可做但后移 | 展示价值高，但不应挡住 runtime 地基 |
| Web trace 深度联动 | ❌ v3 | 依赖 session store / richer event model |

### 5.5.7 F 类：明确延后（避免二期失控）

| Claude Code 能力 | 延后原因 | 建议归属 |
|---|---|---|
| Bash v2 (`ShellCommand` / background / sandbox / AST permission) | 复杂度极高，会吞掉二期主线 | 单独 Bash v2 spec |
| Bridge / remote control | 与通用 agent 平台地基无关 | v3+ |
| Custom Ink renderer / packed cell screen | 性能优化，不是平台化前置 | v3+ |
| YOLO permission classifier | 安全和成本都重，且需要大量测试 | v3+ |
| Telemetry / GrowthBook / remote managed settings | 不符合开源透明优先级 | 暂不做 |
| Full swarm / mailbox / tmux / iTerm2 | 跨进程复杂度高 | sub-agent v3 |

### 5.5.8 建议后的推进顺序（更容易理解版）

```text
Phase 0  Runtime 地基
  - AgentSession
  - querySource
  - message invariant guard
  - rejection state

Phase 1  Tool Contract + Toolkit
  - defineTool capabilities / summarize / resultPolicy
  - Toolkit 稳定排序
  - coding toolkit 拆分

Phase 2  Permission Chain + Coding Parity
  - capability approval
  - safety guard
  - refusal circuit
  - createCodingAgent 薄壳化

Phase 3  Compact / Offload MVP
  - resultPolicy offload
  - microcompact
  - manual /compact

Phase 4  MCP MVP
  - stdio only
  - McpServerConnection union
  - MCP tools 包装为 Tool contract

Phase 5  Sub-agent MVP
  - delegate_task 同步 1 层
  - parentSessionId / querySource / delegationDepth

Phase 6  Web /agents
  - profile 只读卡片
  - runtime trace 只展示 MVP events
```

### 5.5.9 一句话取舍

二期不要变成"Claude Code 功能复刻"。  
二期真正要借鉴的是 Claude Code 的**承重结构**：会话宿主、工具契约、权限短路链、消息不变量、长会话安全网、生态连接状态。  
只要这些地基打好，MCP / sub-agent / compact / Web UI 后面都能自然长出来；反过来如果先做界面或生态接入，后面很容易因为缺 session / retry / permission / compact 宿主而返工。

---

## 6. 验收基线

- `bun run check` 全绿，pass 数 ≥ 245（v0 212 + offload/compact ≥ 12 + 其它 ≥ 21）
- v0 `createCodingAgent` 公开签名 / 行为零回归
- `helix --profile research` 工具集只含只读 + bash + todo + ask_user_question
- Web `/agents` 看到至少 2 张内置 profile 卡片
- coding agent 能调 `delegate_task("research", ...)` 拿回文本
- **长会话不再撞 token 上限**：连续 30+ 步 read_file 后 input_tokens 比 v0 减少 ≥ 30%
- **Offload 工作**：12K 字 read_file 结果在第 N+2 轮后被替换为 `[offloaded ref=off_xxx ...]`
- **Manual /compact 可用**：TUI 输入 `/compact` 后 messages 数显著减少且能继续对话
- 触发 trace event 在 Web 可见（`offload_triggered` / `microcompact_triggered`）
- **AgentSession 贯穿**：所有 model.invoke metadata 含 `source` / `sessionId`；sub-agent 调用含 `parentSessionId`
- **querySource 重试分类**：mock 后台 querySource 撞 529，断言不重试（前台 querySource 撞 529 触发标准重试矩阵）
- **拒绝熔断器**：连续 3 次工具拒绝后 agent 主循环必然终止，trace event 含 `rejection_circuit_tripped`

---

## 7. 方案风险评估与影响面（**review 后新增**）

> 这一节是对模块 1 / 2 设计的**反向自检**，列出"看起来很美但落地时会撞墙"的点。  
> 每条都标注源码位置 + 严重度 + 修正方案。  
> **如果你看完觉得改造影响过大，可以选择缩减 MVP（比如只做模块 1 不做 capability 重构）。**

---

### 7.1 风险等级定义

| 标记 | 含义 | 是否阻塞 |
|---|---|---|
| 🔴 高 | 不修正会导致编译/运行失败，或破坏 v0 测试 | 是，**必须先解决** |
| 🟡 中 | 行为偏差但不致命；语义需要明确 | 是，但可设计期决策 |
| 🟢 低 | 锦上添花；可推到 v3 | 否 |

---

### 7.2 🔴 高风险点

#### Risk-H1：MCP toolkit 的 parameters 类型不兼容现有 `Tool` 接口

**源码引用**：

- [`src/foundation/tools/function-tool.ts:9`](file:///Users/bytedance/Documents/Codex/helixent/src/foundation/tools/function-tool.ts#L9)
  ```ts
  export interface FunctionTool<
    P extends z.ZodSchema<Record<string, unknown>> = z.ZodSchema<Record<string, unknown>>,
    R = unknown,
  > { ... }
  ```
- [`src/community/openai/utils.ts:103-107`](file:///Users/bytedance/Documents/Codex/helixent/src/community/openai/utils.ts#L103-L107)
  ```ts
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters.toJSONSchema() },
  }));
  ```

**风险**：
- foundation 把 parameters 死锁成 zod schema
- MCP 服务器返回的是裸 JSON Schema（[MCP spec](https://spec.modelcontextprotocol.io/specification/server/tools/)）
- OpenAI provider 直接调 `parameters.toJSONSchema()`，如果 mcpToolkit 把 raw JSON Schema 塞进 `parameters`，**TS 编译炸 + provider 运行时崩**

**严重度**：🔴 高（阻塞模块 4 落地）

**修正方案 A（推荐）**：mcpToolkit 内部用 [`zod-from-json-schema`](https://www.npmjs.com/package/zod-from-json-schema) 反向转换
- 优点：foundation 类型契约不动，零回归
- 缺点：多 1 个 community 依赖，复杂 schema 可能转换不完美

**修正方案 B**：foundation 引入 `Tool = FunctionTool | RawJsonSchemaTool` 联合
- 优点：MCP 工具可以直接透传
- 缺点：openai provider 要分支处理；所有调用 `parameters.toJSONSchema()` 的地方都要 type guard

**决策点**：选 A 还是 B？

---

#### Risk-H2：Toolkit 工厂签名导致 profile / toolkit 循环 import

**源码引用**：

- 大纲 [模块 2.4.3 Toolkit 类型](file:///Users/bytedance/Documents/Codex/helixent/.trae/documents/generalize-agent-platform-outline.md#L455)：
  ```ts
  tools: Tool[] | ((ctx: AgentProfileRuntimeContext) => Tool[]);
  ```
- 大纲 [模块 1.3 AgentProfile 类型](file:///Users/bytedance/Documents/Codex/helixent/.trae/documents/generalize-agent-platform-outline.md#L91)：
  ```ts
  import type { Toolkit, Capability } from "../toolkits/types";
  ```

**风险**：
- `src/agent/profiles/types.ts` import `Toolkit` 类型
- `src/agent/toolkits/types.ts` 又要 import `AgentProfileRuntimeContext`
- TS / esbuild 处理 type-only 循环虽然不会运行时崩，但**会导致 IDE rename / 类型推断不稳**，且文档生成器（typedoc）会报错

**严重度**：🔴 高（影响所有后续模块的可读性）

**修正方案**：拆出一个**只含 toolkit 求值需要的子集**的 `ToolkitContext`：

```ts
// src/agent/toolkits/types.ts —— 不依赖 profile 任何东西
export interface ToolkitContext {
  cwd: string;
  askUserQuestion?: (params: AskUserQuestionParameters) => Promise<AskUserQuestionResult>;
  todoSystem?: { tool: Tool; middleware: AgentMiddleware };
  mcpServers?: Record<string, McpServerConfig>;
}

export interface Toolkit {
  id: string;
  description: string;
  tools: Tool[] | ((ctx: ToolkitContext) => Tool[]);
  capabilities: Capability[];
  defaultPolicy?: Partial<ToolResultPolicy>;
}
```

```ts
// src/agent/profiles/types.ts —— 单向依赖 toolkits
import type { ToolkitContext } from "../toolkits/types";

export interface AgentProfileRuntimeContext extends ToolkitContext {
  // toolkit 求值用不到的，但 middleware / initialMessages 要的：
  model: Model;
  skillsDirs: string[];
  askUser?: ...;
  approvalPersistence?: ApprovalPersistence;
  delegationDepth?: number;
  toolCapabilities?: Map<string, Set<Capability>>;
}
```

→ 修正大纲模块 2.4.3 的工厂签名为 `(ctx: ToolkitContext) => Tool[]`。

---

#### Risk-H3：TUI 全局 tool registry 污染 + v0 测试失效

**源码引用**：

- 大纲 [模块 2.4.6](file:///Users/bytedance/Documents/Codex/helixent/.trae/documents/generalize-agent-platform-outline.md#L508-L515)：
  ```ts
  const tools = new Map<string, Tool>();
  export function getToolByName(name: string): Tool | undefined { ... }
  ```
- [`src/cli/tui/message-text.ts:50-77`](file:///Users/bytedance/Documents/Codex/helixent/src/cli/tui/message-text.ts#L50-L77)：
  ```ts
  function toolUseText(content: ToolUseContent): string {
    switch (content.name) { ... }
  }
  ```
- [`web/__tests__/frontend-smoke.test.ts`](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-smoke.test.ts)（v0 测试，直接构造 ToolUseContent，不经过 agent 装配）

**风险**：
- 全局 mutable registry 是反模式：多 agent 实例 / 单测并发会**互相污染**
- v0 单测里直接 `messageToPlainText({ role: "assistant", content: [{ type: "tool_use", name: "bash", ... }] })` —— 此时 registry **是空的**，新方案下走 fallback，输出与 v0 不同 → 测试失败
- 用户**没装 agent 就开 TUI**（极端但可能）→ 全屏 fallback

**严重度**：🔴 高（破坏 v0 测试）

**修正方案**：
- **取消全局 registry**
- TUI 渲染从**当前 agent 实例的 tools 拿 summarize**：
  ```ts
  // src/cli/tui/message-text.ts
  export function messageToPlainText(
    message: NonSystemMessage,
    options?: { tools?: Tool[] }
  ): string | null { ... }

  function toolUseText(content: ToolUseContent, tools?: Tool[]): string {
    const tool = tools?.find((t) => t.name === content.name);
    if (tool?.summarize) {
      const { title, detail } = tool.summarize(content.input);
      return `${dim("⏺")} ${title}${detail ? `\n  ${dim(`└─ ${detail}`)}` : ""}`;
    }
    // fallback 完全保留 v0 switch ↓↓↓
    switch (content.name) { ... }
  }
  ```
- 调用方（`use-agent-loop.ts` / `message-history.tsx`）已经持有 agent 引用，传 `agent.tools` 即可
- v0 测试调 `messageToPlainText(msg)` 不传 tools → 走 fallback switch → 与 v0 输出一致 → **零回归**

→ 修正大纲模块 2.4.6：删除全局 registry 章节；2.4.1 `summarize` 字段保留；2.5.4 改为"渲染入口接受 tools 参数"。

---

### 7.3 🟡 中风险点

#### Risk-M1：tool.capabilities 与 toolkit.capabilities 覆盖语义未明确

**源码引用**：大纲 [模块 2.4.3](file:///Users/bytedance/Documents/Codex/helixent/.trae/documents/generalize-agent-platform-outline.md#L450-L460)（toolkit 级）+ [模块 2.4.1](file:///Users/bytedance/Documents/Codex/helixent/.trae/documents/generalize-agent-platform-outline.md#L385)（tool 级）

**风险**：
- `agent-core` toolkit 同时含 `todo_write`（无害）和 `ask_user_question`（`ask_user`）
- 如果 toolkit 标 `capabilities: ["ask_user"]`，但 todo 不该被审批拦
- 如果 todo 标 `capabilities: []` 覆盖 toolkit 默认，approval middleware 不会拦 → 正确
- 但语义没在大纲里写

**严重度**：🟡 中

**修正方案**：在大纲 1.4 装配伪码补一行覆盖规则：
```ts
toolCapabilities.set(t.name, new Set(t.capabilities ?? tk.capabilities));
//                                    ^^^^^^^^^^^^^^^ 优先 tool 级
```
并在 2.4.3 末尾加一句注释："**tool.capabilities 优先于 toolkit.capabilities**；只有 tool 不显式覆盖时才继承 toolkit 默认。"

---

#### Risk-M2：sub-agent 委派的 todoStore 是否隔离

**源码引用**：

- [`src/agent/todos/todos.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/todos/todos.ts) — `createTodoSystem()` 每次创建独立闭包
- 大纲 [模块 5](file:///Users/bytedance/Documents/Codex/helixent/.trae/documents/generalize-agent-platform-outline.md#L645) — `delegate_task` spawn 新 Agent

**风险**：
- sub-agent 跑自己的 `createAgentFromProfile`，会创建**新 todoSystem**
- lead 的 todo 列表与 sub 的 todo 列表互不可见
- 这是 v0 默认行为还是设计意图？没明确

**严重度**：🟡 中

**修正方案**：在大纲模块 5 加一行说明：
> sub-agent 默认**隔离 todoStore**（v0 行为延续）。如要共享，调用方显式传 `runtimeContext.todoSystem` 给 `createAgentFromProfile`。这避免了递归 ReAct 时 todo 互踩。

---

#### Risk-M3：agent.ts catch 分支返回结构化错误会破坏 tool_result 字符串契约

**源码引用**：

- [`src/agent/agent.ts:235-238`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L235-L238)
  ```ts
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { index, toolUseId: toolUse.id, toolName: toolUse.name, result: `Error: ${message}` };
  }
  ```
- [`src/agent/agent.ts:259-268`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L259-L268)（`tool_result.content` 是 `formatToolResultForMessage` 的返回值，最终是字符串）
- 大纲 [模块 2.5.2](file:///Users/bytedance/Documents/Codex/helixent/.trae/documents/generalize-agent-platform-outline.md#L555-L562) 想改成 `errorToolResult(...)` 结构化

**风险**：
- `tool_result.content` 在 [`agent.ts:259-268`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts#L259-L268) 走 `formatToolResultForMessage`，输出字符串
- Web trace 渲染（`web/public/app/traces.js`）按字符串处理 result
- 如果改成 `errorToolResult` 结构，看似 `formatToolResultForMessage` 能 normalize，但**zod issues 这种 array 字段会被 stringified 成无意义 JSON**

**严重度**：🟡 中（视觉退步）

**修正方案**：catch 分支只处理 `ZodError`，**仍然返回字符串**：

```ts
} catch (error) {
  if (error instanceof z.ZodError) {
    const lines = error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return { ..., result: `Error: Invalid input — ${lines}` };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { ..., result: `Error: ${message}` };
}
```

→ 修正大纲 2.5.2：**返回字符串而非 errorToolResult**。Web trace 零改动；旧测试断言 `Error:` 前缀仍命中。

---

### 7.4 🟢 低风险点

#### Risk-L1：`getToolResultPolicy(toolName)` 签名不兼容新方案

**源码引用**：

- [`src/agent/tool-result-policy.ts:14`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/tool-result-policy.ts#L14)：`export function getToolResultPolicy(toolName: string): ToolResultPolicy`
- [`src/agent/tool-result-runtime.ts:106`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/tool-result-runtime.ts#L106)：唯一调用方
- [`src/agent/__tests__/tool-result-policy.test.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/__tests__/tool-result-policy.test.ts)：直接断言 `getToolResultPolicy("read_file")` 返回值

**风险**：P3 想"改读 tool.resultPolicy"，但 unit test 是按工具**名**字符串测的，没有 tool 实例可查。

**严重度**：🟢 低

**修正方案**：保留旧签名，加可选第二参数：
```ts
export function getToolResultPolicy(toolName: string, tool?: Tool): ToolResultPolicy {
  if (tool?.resultPolicy) return { ...DEFAULT_POLICY, ...tool.resultPolicy };
  // v0 switch 完全保留 ↓↓↓
  switch (toolName) { ... }
}
```
- `tool-result-runtime.ts:106` 改为 `getToolResultPolicy(toolName, tools.find((t) => t.name === toolName))`
- v0 unit test 调用一参数版本继续走 switch → 0 修改

---

#### Risk-L2：source-analysis 文档过期

**源码引用**：[`source-analysis/helixent-tools-call-summary.md`](file:///Users/bytedance/Documents/Codex/helixent/.trae/documents/source-analysis/helixent-tools-call-summary.md)

**风险**：旧文档描述了"工具名硬编码"现状，模块 2 完成后过期。

**严重度**：🟢 低

**修正方案**：在文档头加一段 followup 注释，链接到 v2 spec；不删旧文档（保留历史）。

---

#### Risk-L3：research profile 不读 AGENTS.md → 与 coding 视觉差异大

**源码引用**：[`src/coding/agents/lead-agent.ts:48-61`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/agents/lead-agent.ts#L48-L61)

**风险**：当前 lead-agent 自动读 `${cwd}/AGENTS.md` 注入首条 user message。如果 research profile 没写 `initialMessages`，启动后第一条消息就是空的，与 coding profile 视觉差异大。

**严重度**：🟢 低

**修正方案**：抽 loader 到 `src/coding/profiles/agents-md-loader.ts`：
```ts
export async function loadAgentsMdMessage(cwd: string): Promise<NonSystemMessage[]> { ... }
```
coding 与 research profile 都引用即可。

---

### 7.5 整体影响面盘点

#### 受影响测试文件清单

| 测试 | 影响类型 | 修正动作 |
|---|---|---|
| [`src/agent/__tests__/tool-result-policy.test.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/__tests__/tool-result-policy.test.ts) | 签名向后兼容 | 0 修改（Risk-L1 修正后） |
| [`src/agent/__tests__/tool-result-runtime.test.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/__tests__/tool-result-runtime.test.ts) | normalize 路径不变 | 0 修改 |
| [`src/coding/tools/__tests__/*.test.ts × 12`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/tools/__tests__) | tool 各自加 capabilities + summarize 后类型不变 | 0 修改 |
| [`src/coding/permissions/__tests__/*`](file:///Users/bytedance/Documents/Codex/helixent/src/coding/permissions/__tests__) | 双路径兼容 | 加 capability 路径单测 |
| [`web/__tests__/frontend-smoke.test.ts`](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-smoke.test.ts) | TUI fallback 不动 | 0 修改（Risk-H3 修正后） |
| [`web/__tests__/frontend-clipboard.test.ts`](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-clipboard.test.ts) | 与改造无关 | 0 修改 |
| [`web/__tests__/frontend-collapse.test.ts`](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-collapse.test.ts) | 与改造无关 | 0 修改 |

#### 受影响调用方

| 调用方 | 文件 | 影响 |
|---|---|---|
| CLI 启动 | [`src/cli/index.tsx`](file:///Users/bytedance/Documents/Codex/helixent/src/cli/index.tsx) | 加 `--profile` option（兼容默认 `coding`） |
| TUI 主 hook | [`src/cli/tui/hooks/use-agent-loop.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/cli/tui/hooks/use-agent-loop.ts) | 调用 `messageToPlainText(msg, { tools: agent.tools })` |
| Web trace | `web/server.ts` / `web/public/app/traces.js` | 0 修改（result 仍是字符串） |
| Provider | [`src/community/openai/utils.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/community/openai/utils.ts) | 0 修改（除非选 Risk-H1 方案 B） |

---

### 7.6 决策清单（需要你拍板）

| # | 决策点 | 选项 | 倾向 |
|---|---|---|---|
| D1 | MCP parameters 类型适配 | A. mcpToolkit 内部 JSON Schema → zod / B. foundation 引入联合类型 | **A** |
| D2 | 是否做 capability 重构 | 全做 / 仅做 profile 抽象先不动 approval | **全做**（核心痛点） |
| D3 | 是否做 TUI summarize | 做（按 Risk-H3 修正） / 推迟到 v3 | **做** |
| D4 | 是否在 agent.ts 增强 zod 错误诊断 | 是 / 否 | **是**（修改极小） |
| D5 | 是否做 `bun run tool` playground | 是 / 推迟到 v3 | **推迟**（节流到 P5）|
| D6 | 是否做 `defineToolTest` helper | 是 / 推迟到 v3 | **推迟**（v0 现有测试够用） |

> **节流路径建议**：如果你担心改造面太大，可以**只做 D1+D2+D3+D4**，砍掉 D5+D6。这样 P4 阶段不存在，只剩 P1-P3 三阶段，工作量减半，价值依然覆盖你提的"加 tool 改动多 + 难调试"两个核心痛点。

---

### 7.7 修正后的最小 MVP 范围（节流版）

如选节流路径：

**保留**
- 模块 1 AgentProfile 完整
- 模块 2 仅做 `defineTool` 加 `capabilities` + `summarize` + 5 个 toolkit 拆分 + capability approval
- 模块 3 Web /agents（只读）
- 模块 4 MCP（采用 H1 修正方案 A）
- 模块 5 delegate_task（采用 M2 修正：默认隔离）

**砍掉**（移到 v3）
- `bun run tool` playground
- `defineToolTest` helper
- `tool.resultPolicy` 自定义（仍走 [`tool-result-policy.ts`](file:///Users/bytedance/Documents/Codex/helixent/src/agent/tool-result-policy.ts) v0 switch）
- 全局 tool registry

新增/修改文件数从 ~25 降到 ~15，回归风险显著降低。

---

## 8. 暂不做（Out of Scope，留 v3）

- Profile 文件加载（`~/.helix/profiles/*.yaml`）+ 用户编辑器
- Profile 可写 Web UI（增删改 / 表单 / 一键启动）
- MCP HTTP / SSE transport · 多 server 并行
- Sub-agent 多层 / 并行委派 · 嵌套 trace 双向同步
- 长期 / 跨 session 记忆系统
- Session 内 profile 热切换

---

## 8. 下一步

- 你 review 大纲 → 确认 / 调整 5 个模块的优先级与边界
- 确认后再展开 `.trae/specs/generalize-agent-platform/` 的 spec.md / tasks.md / checklist.md（这三份当前已是上一轮起草版本，可继续迭代）
- 再之后才进入实施
