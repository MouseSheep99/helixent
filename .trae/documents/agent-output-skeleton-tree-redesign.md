# Agent Output Skeleton Tree 重设计方案

## 1. 背景与痛点

当前 Agent Output 区域（`view/agent-output-graph.js` + `styles/agent-output-graph.css`）虽然已经是 graph 结构（`Run -> ReAct Step -> Thinking/Tool/Response`），但 UI 渲染上每一层都是一个**实心圆角卡片**：

| 层级 | DOM | 当前样式 |
|------|-----|---------|
| Run | `.agent-run` | `border + border-left:3px(色) + radius-md + bg-card + shadow-md` |
| ReAct Step | `.react-step` | `border + border-left:2px(色) + radius:14px + 半透明 bg` |
| Tool / Thinking / Response / Error | `.tool-call` `.agent-detail-node` | `border + border-left:2px(色) + radius:12px + 半透明 bg` |

截图里能直接看到 4 层嵌套的圆角矩形（Run 2 → ReAct 1 → Thinking / Response），每层都有自己的边框、内边距、阴影、左侧状态色条，视觉密度过高，用户的核心反馈：**"框有点多，能不能弱化一下"**。

参照右侧 **Hook & Tool Timeline Graph**（`view/timeline.js` + `styles/timeline.css`）的做法——用**薄行 + 左侧 1px 树状连线 + tone chip**承载所有层级，没有任何内层卡片框——本方案把 Agent Output 改造成**「Skeleton Tree」**：仅保留最外层 Run 的轻量容器，内部全部退化为「行节点」，靠树线和 chip 体现层级与状态。

## 2. 业界调研

我对照了几类与 ReAct / Agent trace 渲染相关的成熟产品：

| 工具 | 关键做法 | 借鉴点 |
|------|---------|--------|
| **LangSmith / LangChain trace** | 左侧细树状导航 + 右侧 pane，节点是行（chip + name + duration） | 树行 + chip + duration 元信息 |
| **OpenInference / Phoenix** | 嵌套 `<details>`，每层只用 1px 左线 + 缩进，不画框 | 全靠树线表达层级 |
| **Anthropic Console traces** | 顶层 Run 是卡片，内部 step/tool 是无边框行 | 「外卡内行」混合模式 |
| **Cursor / Codex agent timeline** | thinking/text 用浅底色 pre，无圆角框 | 详情用轻量 pre 而非卡片 |
| **VS Code 文件树 / DevTools elements** | 节点行 = chevron + icon/chip + title + meta，hover 高亮，开合靠 disclosure | 行节点的标准结构 |

共识：**层级用树线 + 缩进表达，不要用嵌套圆角框**；状态用 chip 颜色或单点指示，不要每层都画 border-left；只有需要明确边界（如多个独立 Run）的地方才保留卡片容器。

## 3. 整体设计思路（从用户视角出发）

Agent Output 区域不是「日志面板」，而是**用户与 Agent 协作的主要对话界面**。所有视觉决策必须围绕一个核心问题：**用户在不同场景下，最希望先看到什么？**

### 3.1 用户的三类阅读场景

| 场景 | 用户在找什么 | UI 应该如何回应 |
|------|------------|---------------|
| **A. 浏览模式**（最高频）：用户刚发完一个问题，等 Agent 回复 | 想快速看到「Agent 说了什么」+「做了哪几步」 | Run 默认展开 → 唯一的 Response 节点直接看到回复全文；中间步骤折叠成轻量行，不抢戏 |
| **B. 调试模式**（中频）：回复不对/卡壳/出错，用户想知道「Agent 怎么想的、调了什么工具、为啥失败」 | 想一层层下钻看 thinking、tool input/result、error | 行结构 + chip 状态色 + 一键展开；error 行红色高亮；点 Inspect 进 message dialog 看完整 raw |
| **C. 复盘模式**（低频）：跑完一长串后回头看哪步耗时/出问题 | 想一眼扫到「失败的 step / 慢的 tool / 关键 thinking」 | 跨 Run 的统一 chip 配色 + duration meta；error 永远默认开；右侧 Timeline 互为镜像 |

设计的核心张力：**让 A 场景一眼看到"答案"，让 B/C 场景一键拿到"过程"**。

### 3.2 信息层级 vs 视觉层级

把 Agent 产物按「用户看的频率」从高到低分四档，视觉权重对应递减：

```
档位 1：Response（用户最想看的最终回复）
   └─ 默认展开，正文字号 13px，浅底块
档位 2：Run 标题（"我问的什么、Agent 走了几步"）
   └─ 行结构标题 + RUN chip + status chip + Inspect
档位 3：ReAct Step / Tool 调用（过程概览）
   └─ 行结构，默认折叠，单步时自动展开
档位 4：Thinking / Tool input/result / Error（debug 时才看）
   └─ 行结构 + chip，默认折叠；点开浅底块展示
```

旧版本最大的问题：**4 档信息全部用同等强度的圆角卡片渲染**，用户视觉无法分主次。新方案靠 chip + 缩进 + 是否有外卡区分四档，A 场景用户视线直接落到 Response，B/C 场景按需展开。

### 3.3 与右侧 Timeline 的角色分工

很多类似产品（LangSmith、Phoenix、Anthropic Console）只有一个 trace 视图，但 Helixent 有两个并列区域，必须分工清晰：

| 维度 | Agent Output（左主区） | Hook & Tool Timeline（右侧栏） |
|------|----------------------|------------------------------|
| **目标用户视角** | 「我和 Agent 的对话」 | 「框架内部发生了什么」 |
| **内容** | 用户消息 + Agent 思考/回复 + 工具调用结果 | 所有 hook、SSE event、phase 转换 |
| **粒度** | 语义级（thinking/response/tool） | 事件级（hook_triggered/event 类型） |
| **默认显著度** | Response 内容 | Run 总览 + 出错 phase |
| **互动方式** | Inspect 进 message dialog 看 raw | 点 event 进 detail JSON |

⇒ Agent Output **是对话**，Timeline **是仪表盘**。两者用同一套 chip tone 是为了让用户在两边切换视线时不需要重新建立映射，但内容粒度和默认权重必须不同。

### 3.4 为未来能力预留视觉空间

Helixent 框架方向（来自 README 和 AGENTS.md）：
- 当前：lead agent + tools + skills + ReAct loop
- 未来：**MCP**（外部工具/资源）、**Memory**（长程记忆）、**Sub-agent**（子任务委派）、**Retrieval**（RAG）

**这些未来模块本次不实现**——等后端协议成熟后再做。本次方案只在前端架构层面保证：未来加新模块时，**新模块与现有模块互相独立**，不需要回头改本次实现的代码。具体的架构独立性约束见 §7.8。

### 3.5 视觉密度原则

- **横向**：能用 chip 表达的不要用 button；能用 meta 文字表达的不要用 chip。
- **纵向**：默认状态 = 当前 Run 占 1-1.5 屏，多余 step 折叠；用户主动展开时按需扩展。
- **颜色**：每行只允许一个强色（chip），其它走 text-secondary / text-tertiary。
- **动效**：只在 chevron 旋转、hover 高亮上花动效预算；不做卡片淡入、滑动等装饰动效（与 Timeline 一致）。

### 3.6 用户 query 的显著化（被忽视但关键）

当前 [view/output-cards.js#L75-L82](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/output-cards.js#L75-L82) 把用户的 query 渲染成 `tone: "user"` 的 `output-card`，标签是 `"User request"` + chip `input`。但视觉权重和 Run / Tool result 等其它卡片是同档的——用户**自己刚发出去的话，反而不显眼**。

这是一个反人类设计：**对话界面里，用户自己说的话应该是最容易识别的锚点**，因为：

1. 用户回头浏览时，第一眼要找到「我问了什么」才能定位 Agent 的回复对应到哪个问题。
2. 多 Run 时，user query 是天然的"段首标题"，比 `Run 1 / Run 2` 更具语义。
3. 大多数对话产品（ChatGPT / Claude / Cursor / Gemini）都把 user message 用**对齐方向（右）+ 气泡 + 配色**做强对比，让用户瞬间识别。

设计目标：
- **A. 锚定**：每个 Run 之前，user query 必须是首屏视线的起点。
- **B. 引述**：Run 标题里也要短引述 user query 的开头，让用户折叠 Run 后还能定位。
- **C. 不喧宾**：query 不能比 Agent 回复更抢戏，因为用户大多数时候是来看回复的。

具体规则放在 §7.9。

## 4. 设计目标
1. **降框** — 内部不再有嵌套圆角矩形，视觉密度跟右侧 Timeline 一致。
2. **保结构** — graph 数据模型 `runs[].steps[].{thinking, tools, response, errors}` 不动，只改渲染层。
3. **保信息** — Thinking 全文、Tool Input/Result、Inspect 按钮等核心信息一个不少，且可读性 ≥ 现版本。
4. **状态显著** — 状态色靠 chip + 顶层左侧 accent 条，不靠每层 border。
5. **与 Timeline 一致的视觉语言** — chip 命名/配色/树线样式与 `.timeline-type-chip` / `.timeline-tree-line` 对齐。
6. **零数据迁移** — 不动 `buildAgentOutputGraph`，不改测试期望的核心 class（`agent-output-graph`、`tool-call`、`agent-detail-node thinking/response`），保证现有测试通过。

## 5. 整体效果（文字示意）

```
┌─────────────────────────────────────────────────────────┐  ← 仅 Run 保留外卡
│ ▾  RUN  Run 2                                  success  │
│       你好呀 · 1 ReAct step · 0 tools         [Inspect] │
│ │                                                       │
│ ├─ ▾ STEP  ReAct 1                            success   │  ← 内部全是树行
│ │  │      Thinking + Response · 0 tools                 │
│ │  ├─ ▾ THINK  Thinking                       internal  │
│ │  │      用户现在说"你好呀"，这是简单的问候…              │
│ │  │      ┌───────────────────────────────────────┐    │
│ │  │      │ <展开后的 thinking 全文，浅底色 pre>  │    │  ← 详情轻量底色块
│ │  │      └───────────────────────────────────────┘    │
│ │  └─ ▾ RESP   Response                      assistant  │
│ │           你好！😊                                    │
│ │           ┌───────────────────────────────────────┐  │
│ │           │ 你好！😊                              │  │
│ │           └───────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

关键点：
- 唯一外框 = `.agent-run`（保留 Run 边界感，便于多 Run 时区分）。
- 内部 ReAct Step / Thinking / Response / Tool 全是「行节点」+ 左侧 1px 树线 + 缩进。
- 状态体现：Run 顶部 left accent（success/running/error 三色） + 每行一个 status chip。
- Tool 节点展开后，Input / Detected / Result 用 timeline 同款浅底 pre 块。

## 6. 现状分析（文件清单）

### 6.1 渲染源码

- [view/agent-output-graph.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/agent-output-graph.js)
  - `renderAgentRunNode` — Run 容器
  - `renderReactStepNode` — ReAct Step 容器
  - `renderToolCallNode` — Tool 容器
  - `renderAgentOutputItem` — Thinking / Response / Error 容器
  - `renderToolSection` — Tool Input/Detected/Result 段
  - `renderNodeChip` — 旧 chip（共 4 类色调，逻辑跟 Timeline chip 不一致）
- [view/output-cards.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/output-cards.js)
  - `renderMessageOutputCard` — 当前把 user query 渲染成普通卡片（§7.9 重设计的入口）

### 6.2 样式源码

- [styles/agent-output-graph.css](file:///Users/bytedance/Documents/Codex/helixent/web/public/styles/agent-output-graph.css) 全文（约 243 行）
  - `.agent-run`、`.react-step`、`.tool-call`、`.agent-detail-node` — 4 层卡片样式
  - `.agent-node-children` — 缩进容器（已有左 border 树线雏形）
  - `.agent-node-chip` — 旧 chip
  - `.agent-tool-section` — 工具详情段
  - thinking placeholder（已有）保持不动
- [styles/output-cards.css](file:///Users/bytedance/Documents/Codex/helixent/web/public/styles/output-cards.css)（如存在）— `.output-card.user` 样式，本次会被新的 `.user-query-bubble` 替代

### 6.3 不动区

- 数据模型（`buildAgentOutputGraph`、`createToolNode`、`updateRunStatus` 等）保持原状。
- DOM 顶层 class `agent-output-graph` / `tool-call` / `agent-detail-node thinking|response` 名称保留（测试断言使用）。
- 应用层事件绑定 `[data-message-index]` 在 [app/output.js#L24](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/output.js#L24) 不变。

### 6.4 测试断言（保持兼容）

- [frontend-view.test.ts#L430](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-view.test.ts#L430) `agent-output-graph`
- [frontend-view.test.ts#L516-520](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-view.test.ts#L516-L520) `agent-detail-node thinking` / `agent-detail-node response` / `tool-call`
- [frontend-view.test.ts#L565](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-view.test.ts#L565) `tool-call`
- [frontend-smoke.test.ts#L138-141](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-smoke.test.ts#L138-L141) `agent-output-graph` / `tool-call`

⇒ DOM class 命名约束：保留 `agent-output-graph`、`tool-call`、`agent-detail-node thinking|response`。其他 class 可以替换。

## 7. 设计决策

### 7.1 视觉语言对齐 Timeline

- 复用 chip tone 命名：`run` / `step` / `tool` / `model` / `human` / `error` / `prompt` / `skill` / `memory` / `mcp` / `todo` / `session`。
- Agent Output 内部新增/复用：
  - Run → chip `RUN`，tone `run`（蓝）
  - ReAct Step → chip `STEP`，tone `step`（青）
  - Thinking → chip `THINK`，tone `prompt`（紫，与 Timeline `prompt` 同色）
  - Tool → chip `TOOL`，tone `tool`（橙）
  - Response → chip `RESP`，tone `model`（绿，与 Timeline `model` 同色）
  - Error → chip `ERR`，tone `error`（红）

### 7.2 行结构（参考 timeline-node-row）

每行三段式 grid：

```
[chevron 16px][chip 56px][title fill][meta auto]
```

- chevron：用 `details > summary` 的箭头（沿用 `.agent-node-icon::before` 的 ›/旋转 90°）。
- chip：等同 `.timeline-type-chip` 风格（圆角 999、深色半透明底、tone 着色）。
- title：粗 12px，主色文字。
- meta：副色 11px，靠右；展示「subtitle」或 messageIndex Inspect 按钮（小尺寸文本按钮 + ghost 色）。

行高 32-36px，hover 高亮 `rgba(255,255,255,0.045)`，无圆角无边框，仅 padding 与 depth 变量控制缩进（同 timeline）。

### 7.3 树线

- 与 Timeline 完全一致：每行带一条左侧 1px 垂直线 + 12px 横钩，深度通过 `--depth` CSS var 控制。
- 顶层 Run 内部所有行从 `--depth: 1` 开始（Run 自身不画树线，因为它仍是外卡）。

### 7.4 唯一外卡：Run（弱化）

参考 timeline 内 Run 节点的弱化处理（在 timeline 里 Run 也只是一行带 `RUN` chip 的行节点，没有外卡），本方案对 Agent Output 的 Run 做**显著弱化**——但不退化到完全无边框，因为 Agent Output 区不像 Timeline 那样所有节点共享同一棵树，多个 Run 之间需要轻量分隔感。

具体：

- **去掉** `box-shadow`。
- **去掉** `linear-gradient` 与 `bg-card` 实心底色，改为纯 `background: rgba(255, 255, 255, 0.018)`（极浅）。
- **border** 从 `1px solid var(--border-subtle)` 改为 `1px solid transparent`，仅 hover 时显形 `var(--border-soft)`。
- **left accent** 从 `3px` 改为 `2px`，且 success 状态下颜色弱化为 `rgba(99, 216, 141, 0.45)`（半透明绿），running/error 保持完整饱和度。
- **radius** 从 `var(--radius-md)`（约 16px）改为 `10px`，更克制。
- **padding** 从 `14px 48px 14px 14px` 改为 `0`（行结构自身有 padding）。
- Run 头一行（`summary`）也统一成行结构（chevron + RUN chip + 标题 + status chip + Inspect）；视觉上 Run 更接近一条「带左色条的标题行」，而非传统卡片。
- 多 Run 之间 gap 收紧为 `10px`。
- 单 Run 时（`runs.length === 1`），left accent 颜色再额外淡化（添加 `.agent-output-graph[data-run-count="1"] .agent-run` 规则），让首屏没有强分隔感。

⇒ 这样 Run 既保留「逻辑分组」的暗示，又不会再像截图那样成为视觉重心。

### 7.5 详情区（展开后）

- Thinking / Response：展开后用 `<div class="agent-detail-text">` 浅底色（约 `rgba(0,0,0,0.18)`，对齐 `.timeline-graph-detail`）+ 12px monospace 或正文字号 13px、line-height 1.55；保留 markdown 风格（这一版仍走纯文本，markdown 渲染不在此次范围）。
- Tool Input / Detected / Result：用 `<pre class="agent-detail-pre">` 同款浅底 pre。Section 标题（`Input` / `Detected` / `Result`）改为小写灰 chip 风格（`text-tertiary`、letter-spacing），不再用 section 卡片。
- 详情区缩进与所属行的 `--depth + 1` 对齐，左侧不画树线（叶子内容，无子节点）。

### 7.6 状态色策略

| 位置 | 旧 | 新 |
|------|----|----|
| Run | border-left 3px 色 | 仅 left accent 2px 条 + 头行 status chip |
| Step | border-left 2px 色 + 自身 border + bg | 仅头行 status chip |
| Tool | border-left 2px 色 + 自身 border + bg | 仅头行 status chip（Input chip 含 tone） |
| Thinking/Response | border-left 2px 色 + 自身 border + bg | 仅头行 chip 着色 |
| Error | border-left 红 + 红底 | chip + 行内文字红色（`.agent-row.error` 类） |

⇒ 颜色不再叠加 4 层，主要靠 chip 单点表达。

### 7.7 容量与紧凑度

- 默认 ReAct Step 折叠收起（仅 Run 默认展开），减少首屏纵向高度。当前 `renderReactStepNode` 默认开（只在 error 时强制 open）→ 改为：仅 `step.status === "error"` 或当前 Run 只有 1 个 Step 时展开。
- Thinking / Response 默认收起，预览行展示 `summarizeMessageText`（已有），点开看全文。
- Tool 默认收起，预览行展示首个参数 `key: value`（已有 `summarizeToolInput`），点开看 Input / Result。
- Run 内子项 gap 从 10px 收紧到 4-6px。

### 7.8 可拓展性原则（架构独立性，不预实现新模块）

> ⚠️ 注意：MCP / Memory / Sub-agent / Retrieval 这些**未来模块本次不实现**——等后端协议成熟后再做。本节只规定**前端架构层面的独立性约束**，目的是确保未来加新模块时**不需要回头改本次实现的代码**。

#### 7.8.1 模块独立性约束

本次重构后的 Agent Output 渲染必须满足以下"开闭原则"：

| 约束 | 含义 |
|------|------|
| **render 主调度只认接口、不认类型** | `renderAgentOutputGraph(graph)` 主调度只调用 graph node 共有的接口（`type / status / title / chip / children / detail`），不在主流程里 `if (node.type === "tool")` |
| **chip / tone 通过字典查表** | `AGENT_OUTPUT_CHIP_TONES` 字典是唯一的类型 → chip label/tone 映射；新增类型只往字典加键，不改其它代码 |
| **行渲染器是通用的** | `renderAgentRow({ chip, title, subtitle, status, depth, detail })` 不感知具体节点类型；任何 graph node 都能映射到统一的行结构 |
| **没有 type 散落判断** | 全文 grep `node.type === ` 应该几乎只出现在字典查表 / fallback default 处，不在 render 逻辑里 |
| **CSS 通过 tone class 着色** | 状态色与类型色全部走 tone class（如 `.tone-tool`、`.tone-error`），新增 tone 只在 CSS 末尾加规则，不改通用样式 |

#### 7.8.2 当前与未来的边界

- **当前实现的节点类型**：`run / react_step / thinking / response / tool / error` — 仅限本次。
- **未来由后端推动新增**：当后端 SSE 开始发射新 trace（如 `mcp_tool_call`、`memory_recall`、`sub_agent_run`、`retrieval`）时，**那时**才在 builder 与字典里加对应键，**不在本次提前预登记**。
- **不预登记的原因**：避免方案被未来不确定需求污染；保持本次实现简单聚焦；架构独立性已经保证未来加节点不需回改本次代码。

#### 7.8.3 验证独立性的方式

未来加一个新节点类型（比如 `mcp_tool`）时，应该满足下面这条"独立性自检"才算合格：

- ✅ 改动范围 = builder 加一段产出 `mcp_tool` 节点的逻辑 + 字典加一行 + CSS 加一条 tone 规则。
- ❌ 如果要改 `renderAgentRow` / 通用 CSS / 主调度 — 说明本次架构没做到独立，要回头修架构。

### 7.9 用户 query 的显著化（呼应 §3.6）

#### 7.9.1 当前问题

[view/output-cards.js#L62-L82](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/output-cards.js#L62-L82) 中 `role === "user"` 的卡片：

- 用 `renderInteractiveOutputCard({ tone: "user", label: "User request", subtitle: "Prompt sent to the coding agent", chipLabel: "input", body: <div class="plain-text">{text}</div> })` 渲染
- 视觉上是普通 `output-card`，与 Run 卡片同档；标签 `"User request"` 是机器化措辞，不是用户视角。
- 没有任何视觉对比让用户**一眼**找到"自己说的话"。

#### 7.9.2 视觉重设计

把 user query 从「卡片」改造为**对话气泡**风格的强锚点：

```
                                    ┌─────────────────────────┐
                                    │  你好呀                 │  ← 右对齐气泡
                                    └─────────────────────────┘
   RUN  Run 2  你好呀…                                  success
   ├─ STEP  ReAct 1
   │   ├─ THINK  Thinking
   │   └─ RESP   Response
   │           你好！😊
```

#### 7.9.3 具体视觉规则

- **位置**：user query 出现在它对应的 Run 卡的**正上方**（不再嵌入 output-cards 流的同档卡片之间）。
- **对齐**：右对齐（`margin-left: auto`），最大宽度 70%。
- **气泡样式**：
  - `border-radius: 14px 14px 4px 14px`（右下角小圆角，暗示「来自右侧」）
  - `background: linear-gradient(135deg, rgba(96,165,250,0.16), rgba(96,165,250,0.10))`（淡蓝色，对齐 chip tone `user` 系）
  - `border: 1px solid rgba(96,165,250,0.35)`
  - `padding: 10px 14px`
  - `font-size: 13px`、`color: var(--text-primary)`、`line-height: 1.55`
  - `white-space: pre-wrap`
- **不带卡片头** — 不显示 `"User request"` 标签、不显示 `"Prompt sent to the coding agent"` 副标题、不显示 chip。原始内容直接是气泡里的文字。
- **可点 inspect** — 整个气泡仍可点击进 message dialog（沿用 `data-message-index`），但移除原来的 `<button>` 大块包装；用 `cursor: pointer` 提示。
- **AGENTS.md project context 例外** — 仍保留为低显著度的 system 卡片（不变），不改成气泡（不是用户主动说的话）。

#### 7.9.4 Run 标题中的 query 引述

- Run 标题第一行：`Run 2`
- Run subtitle：原本是 `"你好呀 · 1 ReAct step · 0 tools"`，已经引述了 query — **保留这个**，并在 Run 折叠态时确保可见，作为用户折叠后的"小目录"。

#### 7.9.5 流式状态

- 用户提交后立即显示气泡（已经存在的 messages 流转过去）；Agent 回复 / Run 出现是异步的——气泡先出现 → 等 Run 出现 → Run 落到气泡正下方。
- 不需要"loading"骨架，因为气泡本身已经显示。

#### 7.9.6 涉及的代码改动

- [view/output-cards.js#L62-L82](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/output-cards.js#L62-L82) `renderMessageOutputCard` 中 `role === "user"` 分支：改为返回新的 `renderUserQueryBubble({ index, text })`，不再走 `renderInteractiveOutputCard`。
- 新增 `renderUserQueryBubble(params)` 函数，结构：
  ```html
  <div class="user-query-bubble" data-message-index="{index}">{escapeHtml(text)}</div>
  ```
- AGENTS.md project context 分支不动（仍是 `renderInteractiveOutputCard`）。
- CSS 在 [styles/agent-output-graph.css](file:///Users/bytedance/Documents/Codex/helixent/web/public/styles/agent-output-graph.css) 末尾追加 `.user-query-bubble` 规则。
- 测试：现有断言查找 `user request` / `output-card.user` 的位置需要确认；如有，更新断言至 `.user-query-bubble`。

## 8. 改动范围 vs 不改动范围（前后端接口边界）

本次重设计是**纯前端视觉层重构**，明确不涉及任何前后端接口、协议、数据契约的变更。

### 8.1 后端零改动（明确不动）

- **HTTP API**（[web/server.ts](file:///Users/bytedance/Documents/Codex/helixent/web/server.ts)）：所有路由不动
  - `POST /api/sessions`
  - `GET /api/sessions/:id`
  - `POST /api/sessions/:id/messages`
  - `POST /api/sessions/:id/abort`
  - `GET /api/sessions/:id/events` (SSE)
  - `GET /api/traces`、`GET /api/traces/:id`、`DELETE /api/traces/:id`
  - `POST /api/sessions/:id/approval/:approvalId`、`POST /api/sessions/:id/question/:questionId`
  - `GET/POST /api/skills/...`、`GET/POST /api/config`、`POST /api/sessions/:id/prompt-versions`、`POST /api/sessions/:id/tool-enabled` 等
- **SSE 协议**（[web/types.ts#L46-L57](file:///Users/bytedance/Documents/Codex/helixent/web/types.ts#L46-L57) `ServerEvent` 联合类型）：不增不减不改
  - `ready / agent / streaming_state / message / trace / hook / approval / question / todo_update / commands / error` 这 11 种 event 类型保持原样
- **TraceEvent 协议**（[web/types.ts#L8-L44](file:///Users/bytedance/Documents/Codex/helixent/web/types.ts#L8-L44)）：`TraceKind` 联合（25 种）和 `TraceEvent` 字段（`id / sessionId / requestId / kind / at / label / data`）一字不改
- **Agent Output 数据来源**：仍由 SSE `message` / `trace` 事件驱动 → 前端 `state.traceRows` 累积 → `buildAgentOutputGraph(rows)` 派生 graph，整条数据流不动
- **Trace 持久化**：`~/.helixent/traces/<sessionId>.jsonl` 写盘逻辑不动
- **Hook / Tool / Skill 系统**：foundation / agent / coding 三层完全不动
- **测试 fixture**：smoke fixture 与 view fixture 不变

### 8.2 前端 view 层（受控改动）

- 改 [view/agent-output-graph.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/agent-output-graph.js) 的**渲染部分**（`renderAgentOutputGraph` 之后的所有 `render*` 函数）
- 改 [view/output-cards.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/output-cards.js) 中 `renderMessageOutputCard` 的 `role === "user"` 分支（§7.9）；新增 `renderUserQueryBubble`
- **不改** builder 部分（`buildAgentOutputGraph`、`createToolNode`、`updateRunStatus`、`isAgentOutputRow`、`ingestModelOutputBlock` 等）
- **不改** 导出 API：`isAgentOutputRow`、`buildAgentOutputGraph`、`renderAgentOutputGraph`、`renderMessageOutputCard` 等 named export 名称与签名保持不变
- **不改** 任何其它 view 子模块（messages / sent-prompt / timeline 等）

### 8.3 前端 app 层（零改动）

- [app/output.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/output.js) 不动 — `[data-message-index]` 委托绑定继续工作
- [app/state.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/state.js) / [app/api.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/api.js) / [app/session.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/session.js) 不动
- 所有 SSE 事件路由（`SERVER_EVENT_HANDLERS`）不动

### 8.4 前端样式层（受控改动）

- [styles/agent-output-graph.css](file:///Users/bytedance/Documents/Codex/helixent/web/public/styles/agent-output-graph.css) 整体重写主体，保留 thinking placeholder 段落；末尾追加 `.user-query-bubble` 规则（§7.9）
- **不改** 其它 CSS 子文件（包括 timeline.css）
- [styles.css](file:///Users/bytedance/Documents/Codex/helixent/web/public/styles.css) 主入口 `@import` 顺序不动

### 8.5 索引层（仅 cache busting）

- [index.html](file:///Users/bytedance/Documents/Codex/helixent/web/public/index.html) 仅 bump `?v=trace-lens-workbench-61` → `62` 以触发浏览器刷新；HTML 结构不动

### 8.6 测试断言兼容（强约束）

保留以下 DOM class 名称避免破坏现有测试，相当于把 view 层产出当作隐式契约：

- `agent-output-graph`（容器 root）
- `tool-call`（工具节点）
- `agent-detail-node thinking`、`agent-detail-node response`（详情节点）

⇒ 即便不再使用旧的 border/bg 样式，DOM `class` 命名仍然保留，只是这些 class 在新 CSS 中不再附着卡片样式。

### 8.7 影响半径总结表

| 层 | 文件 | 改动量 |
|----|------|------|
| 后端 | `web/server.ts` / `web/types.ts` / `web/trace.ts` 等 | **0** |
| SSE / Trace 协议 | `ServerEvent` / `TraceEvent` / `TraceKind` | **0** |
| Agent / Foundation / Coding | `src/**` | **0** |
| 前端 view 渲染 | `view/agent-output-graph.js` 渲染部分 | **重写** ~200 行 |
| 前端 view 渲染 | `view/output-cards.js` user 分支 + 新增 `renderUserQueryBubble` | **+~20 行** |
| 前端 view 数据 | `view/agent-output-graph.js` builder 部分 | **0** |
| 前端 view 其它子模块 | `view/*.js`（除上） | **0** |
| 前端 app 层 | `app/**.js` | **0** |
| 样式 | `styles/agent-output-graph.css` | **重写** ~150 行 + `.user-query-bubble` |
| 样式其它子文件 | `styles/*.css`（除上） | **0** |
| 入口 | `index.html` | **+1 字符** (cache version) |
| 测试 | `web/__tests__/**` | 仅在 user 卡片断言失效时更新 class 名（约 0-2 处） |

**净结论：前后端接口零变更，整个 Helixent 框架（foundation/agent/coding/community）零改动，仅前端渲染层与样式层受控调整。**

## 9. 改动清单（按文件）

### 9.1 [view/agent-output-graph.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/agent-output-graph.js)

只改渲染部分（`renderAgentOutputGraph` 之后），不动 builder。

- 新增 `AGENT_OUTPUT_CHIP_TONES` 字典：
  ```js
  const AGENT_OUTPUT_CHIP_TONES = {
    run: { label: "RUN", tone: "run" },
    react_step: { label: "STEP", tone: "step" },
    thinking: { label: "THINK", tone: "prompt" },
    response: { label: "RESP", tone: "model" },
    tool: { label: "TOOL", tone: "tool" },
    error: { label: "ERR", tone: "error" },
  };
  ```
- 新增 `renderAgentRow({ chevron, type, title, subtitle, status, depth, metaButton })` 通用行渲染器，结构对齐 Timeline。
- 重写 `renderAgentRunNode`：保留 `<details class="agent-run">` 外卡；`<summary>` 改为统一行结构（chevron + RUN chip + title + status chip + Inspect）。
- 重写 `renderReactStepNode`：去掉 `<details class="react-step">` 自有样式约束，改为 `<details class="agent-row react-step" data-status>` + 行结构（无外卡）；默认收起（除非只有 1 个 step 或 status=error）。
- 重写 `renderToolCallNode`：保留 `class="tool-call"`（测试需要）但去掉所有卡片样式，改为 `<details class="agent-row tool-call" data-status>` + 行结构；展开内容用 `.agent-detail-pre` 渲染 Input / Detected / Result。
- 重写 `renderAgentOutputItem`：保留 `class="agent-detail-node thinking|response"`（测试需要）但 DOM 改为 `<details class="agent-row agent-detail-node thinking" data-status>`；展开内容用 `.agent-detail-text` 渲染。
- 替换 `renderNodeChip` → 新 `renderAgentChip(label, tone)`，与 timeline-type-chip 视觉一致。
- 替换 `renderToolSection` → 紧凑 section（小 caps 标题 + `.agent-detail-pre`）。
- `agent-node-children` 容器：保留作为缩进 wrapper，但样式改为 timeline 同款（gap 1-2px、左侧仅靠每行的 tree-line 表达层级）。
- 不变：所有数据流（Inspect 按钮、messageIndex、tool input/result 取值）。

### 9.2 [styles/agent-output-graph.css](file:///Users/bytedance/Documents/Codex/helixent/web/public/styles/agent-output-graph.css)

整体重写主体；保留 thinking placeholder 动画。新结构（约 130 行）：

- `.agent-output-graph` — gap 10px。
- `.agent-run` — **弱化外卡**（详见 §7.4）：
  - `border: 1px solid transparent`，hover 时 `border-color: var(--border-soft)`
  - `background: rgba(255, 255, 255, 0.018)`（极浅，无 gradient、无 shadow）
  - `border-radius: 10px`
  - `border-left: 2px solid rgba(99, 216, 141, 0.45)`（success 弱化）
  - `[data-status=running] → border-left-color: var(--accent-cyan)`
  - `[data-status=error] → border-left-color: var(--accent-red); background: rgba(255,110,120,0.04)`
  - `padding: 0`（行结构自身有 padding）
- `.agent-output-graph[data-run-count="1"] .agent-run[data-status=success]` — `border-left-color: rgba(99, 216, 141, 0.28)`（单 Run 时进一步淡化）
- `.agent-run > summary` — 行结构 padding 8px 12px。
- `.agent-row` — 通用行：`grid-template-columns: 18px 56px minmax(0,1fr) auto`、gap 8px、padding `4px 8px 4px calc(4px + (var(--depth, 0) * 18px))`、min-height 32、border-radius 8（仅 hover 显形）；不画 border、不画底色。
- `.agent-row:hover` — `background: rgba(255,255,255,0.045)`。
- `.agent-row > .agent-tree-line` — 复用 timeline 的 tree-line 样式（1px 垂直 + 12px 横钩），与 `.timeline-tree-line` 视觉等价。
- `.agent-row[data-status=error]` — title 文本 `var(--accent-red)`。
- `.agent-chip` — 与 `.timeline-type-chip` 同尺寸/字号/字重；按 tone class（`run/step/tool/model/prompt/error`）使用与 timeline 完全相同的颜色变量。
- `.agent-row-title` / `.agent-row-subtitle` / `.agent-row-meta` — 与 timeline-node-title / -meta 等价。
- `.agent-detail-text` — 展开文本：`margin: 2px 8px 8px calc(38px + (var(--depth,0)*18px))`、`padding 10px 12px`、`border:1px solid var(--border-subtle)`、`border-radius 10px`、`background: rgba(0,0,0,0.18)`、`color: var(--text-secondary)`、`font-size 13px`、`line-height 1.55`、`white-space: pre-wrap`。
- `.agent-detail-pre` — 同 `.agent-detail-text` 但 `font-family: var(--font-mono)`、`font-size 12px`。
- `.agent-detail-section-title` — 小 caps 标签：`color var(--text-tertiary)`、`font-size 10px`、`letter-spacing 0.08em`、`text-transform uppercase`。
- `.agent-inspect-button` — 保留小按钮，padding 进一步收紧到 `4px 8px`。
- `details[open] > summary .agent-row > .agent-chevron::before` — 旋转 90°（沿用 chevron 思路，但放到 `.agent-chevron` 而非旧 `.agent-node-icon`，避免与新行结构耦合）。
- 删除：`.react-step`、`.tool-call`、`.agent-detail-node` 各自的 border / bg / radius / border-left 状态规则；`.agent-node-children` 旧的 padding-left + border-left 树线（树线现在在每行内）。
- 末尾追加 `.user-query-bubble` 规则（详见 §7.9.3）：右对齐、`max-width: 70%`、`border-radius: 14px 14px 4px 14px`、`background: linear-gradient(135deg, rgba(96,165,250,0.16), rgba(96,165,250,0.10))`、`border: 1px solid rgba(96,165,250,0.35)`、`padding: 10px 14px`、`cursor: pointer`、`white-space: pre-wrap`，配合 `:hover { border-color: rgba(96,165,250,0.55) }`。

### 9.3 [view/output-cards.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/output-cards.js)

- 保留所有现有 export（包括 `renderInteractiveOutputCard`、`renderSystemOutputCard` 等）。
- 改 `renderMessageOutputCard` 中 `role === "user"` 分支：
  - AGENTS.md project context 子分支不动。
  - 普通 user query 子分支改为 `return renderUserQueryBubble({ index, text });`
- 新增 `export function renderUserQueryBubble({ index, text })`：返回 `<div class="user-query-bubble" data-message-index="{index}">{escapeHtml(text)}</div>`。

### 9.4 不改

- [view/timeline.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/timeline.js) — 不动。
- [view/output-cards.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/output-cards.js) 中**除 user 分支外**的所有内容（Run Metrics、Tasks、Sent Prompt 卡、AGENTS.md context、tool result、approval/question 等）不动。
- [app/output.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/output.js) — `[data-message-index]` 绑定逻辑不动（user-query-bubble 复用同一个 attr 就能继续触发 inspect dialog）。
- 测试 — 现有断言绝大多数保留通过；如有断言查找 `output-card.user` / `User request` 字面量，更新为 `.user-query-bubble`。
- [index.html](file:///Users/bytedance/Documents/Codex/helixent/web/public/index.html) — 重新 bump cache busting `?v=trace-lens-workbench-61` → `62`。

## 10. 假设与决策

| 假设 / 决策 | 说明 |
|------------|------|
| Run 外卡弱化但保留 | 多 Run 场景需要轻量分组暗示，但避免成为视觉重心（详见 §7.4）。 |
| User query 改为右对齐气泡 | 让用户一眼定位"我说的话"；与对话产品惯例对齐（§3.6 / §7.9）。 |
| 不引入 markdown 渲染 | 当前是纯文本展示，markdown 渲染属于另一个范围；本方案保持一致。 |
| chip tone 与 timeline 同源 | 即便同样的概念在两边都出现（如 tool/model），用同色让视觉记忆一致。 |
| 默认 Step 收起 | 减少纵向密度；状态非 success 或单 step 时自动展开。 |
| 详情区不画左侧树线 | 详情是叶子内容，画线反而增加噪音；浅底块本身已表达「展开内容」。 |
| 不预实现 MCP/Memory/Sub-agent/Retrieval | 等后端协议成熟再做；本次只保证架构独立性（§7.8）。 |
| 不改 builder / 接口 / 测试 | 严格限制变更范围在视觉层；DOM 关键 class 保留以兼容现有断言；零接口改动。 |

## 11. 验证步骤

1. **类型 / Lint**：`bun run check:types` 通过；ESLint 0 错。
2. **测试**：`bun test` 全绿（141/141）。重点关注：
   - `frontend-view.test.ts` 中 `agent-output-graph` / `tool-call` / `agent-detail-node thinking|response` 断言。
   - `frontend-smoke.test.ts` smoke 流程不破坏。
3. **手测**（启动本机 server）：
   - 截图场景：`Run 2 → ReAct 1 → Thinking + Response`，对比改造前后视觉，确认内部无 4 层圆角嵌套，且 Run 卡片明显弱化。
   - 多 Run：发 2-3 次 prompt，确认 Run 之间仍有轻量分隔感但不抢戏。
   - 单 Run：刷新只剩 1 个 Run 时，确认 left accent 进一步淡化。
   - **User query 显著化**：发问后，确认问题以右对齐淡蓝气泡形式出现在 Run 卡正上方，视觉上比 Run 卡更先吸引注意；点气泡能打开 message dialog。
   - **多 Run + 多 query**：连发 3 个不同问题，确认每个气泡都和它对应的 Run 紧贴在一起，用户能一眼看出"哪个回复对应哪个问题"。
   - **AGENTS.md project context**：刷新 session 后第一条 system context 仍走低显著度的 `output-card.system` 卡片，**不**变成气泡。
   - Tool 场景：触发一次工具调用，展开 tool 行确认 Input / Result 浅底 pre 渲染清晰。
   - 错误场景：人工触发 error（如 disable tool），确认 chip 红 + 行红、Run 左条变红（保持饱和）。
   - Inspect 按钮：点击 Run 头部 / Tool 行内 Inspect，确认 message dialog 仍正常打开。
   - 折叠/展开：所有 `<details>` 开合正常，chevron 旋转正常。
4. **视觉一致性**：截图对比 Agent Output 与右侧 Timeline，确认 chip 风格、tree-line 风格、字号字重一致。
5. **架构独立性自检**（§7.8.3）：grep 整个 `view/agent-output-graph.js` 确认 `node.type === ` 几乎只出现在字典查表 / fallback default，不在 render 主流程里散落判断。

## 12. 实施顺序

1. 在 `view/agent-output-graph.js` 顶部新增 `AGENT_OUTPUT_CHIP_TONES` 与 `renderAgentRow` / `renderAgentChip`。
2. 重写 4 个渲染函数（Run / Step / Tool / Item），保留 DOM class 关键名；Run summary 也改成行结构、传 `data-run-count` 给容器。
3. 在 `view/output-cards.js` 加 `renderUserQueryBubble`，把 `role === "user"` 普通分支切到气泡。
4. 重写 `styles/agent-output-graph.css` 主体，保留 thinking placeholder 段；末尾加 `.user-query-bubble` 规则。
5. bump `index.html` cache version 到 62。
6. 跑 `bun run check`，必要时更新少量 user 卡片相关断言到 `.user-query-bubble`。
7. 重启 server，浏览器强刷做手测对照。

完成。
