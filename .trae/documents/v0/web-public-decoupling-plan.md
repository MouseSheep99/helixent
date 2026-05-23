# Web Public 前端解耦方案

## 1. 目标

把 `web/public/view.js`、`web/public/app.js`、`web/public/styles.css` 三个文件按职责拆分为多个模块，降低单文件长度，提升可读性和后续维护成本，但不破坏：

- 后端 `web/server.ts` 的静态路由
- `web/public/index.html` 的入口引用方式
- 现有测试 `web/__tests__/*.test.ts` 的 import 路径
- 现有 `View.x` / `TraceExport.x` 调用点

第一步只做物理拆分和聚合层 re-export，不重写任何渲染逻辑、状态管理或样式语义。

## 2. 非目标

- 不改后端接口，不改 SSE event。
- 不改 `index.html` 的 `<link>` / `<script>` 入口数量和路径。
- 不改 `web/__tests__/*.test.ts` 的 import 路径和断言语义。
- 不重命名公开导出 (`renderRequestHTML`、`renderTimelineHTML`、`buildAgentOutputGraph` 等)。
- 不修改 `web/public/export.js`、`web/public/design-mockup*.html`。
- 不引入构建步骤、打包工具或 TypeScript 编译。
- 不引入 CSS 预处理器；继续用浏览器原生 `@import`。

## 3. 当前现状

### 3.1 文件大小

```text
web/public/view.js      2485 lines
web/public/app.js       1212 lines
web/public/styles.css   2677 lines
web/public/index.html    263 lines
```

### 3.2 入口与依赖关系

- HTML 入口：
  - `<link rel="stylesheet" href="/assets/styles.css?v=trace-lens-workbench-60" />`
  - `<script type="module" src="/assets/app.js?v=trace-lens-workbench-60"></script>`
- 后端 `web/server.ts` line 136-139：`/assets/<file>` 直接读 `web/public/<file>`。
- `app.js` 顶部：
  - `import * as View from "./view.js"`
  - `import * as TraceExport from "./export.js"`
- 测试 import：
  - `web/__tests__/frontend-view.test.ts` → `../public/view.js`
  - `web/__tests__/frontend-smoke.test.ts` → `../public/view.js`、`../public/export.js`
  - `web/__tests__/model-providers.test.ts` → `../public/view.js`
  - `web/__tests__/frontend-export.test.ts` → `../public/export.js`

### 3.3 view.js 内容分布

按 grep 已验证，`view.js` 大致按以下功能聚成几大块：

| Section | 主要导出/函数 | 行数估计 |
|---------|---------------|---------|
| Provider / Model 配置 | `providerBaseURLFor`、`providerTypeFor`、`renderProviderOptions`、`renderConfiguredModelsHTML`、`renderDefaultModelOptions` | ~60 |
| Trace 列表 / Replay | `replayEventsToState`、`renderTracesHTML` | ~30 |
| Skills / Tools / Commands | `renderSkillsHTML`、`renderToolsHTML`、`renderToolRow`、`groupTools`、`toolGroupName`、`renderCommandsHTML`、`renderCommandStripHTML` | ~100 |
| Prompt Playground (Request 区) | `renderRequestHTML`、`renderPromptPlayground`、`renderPromptToolbar`、`compactPromptMeta`、`renderPromptReadOnly`、`renderRequestPackagePanelHTML`、`renderAgentToolsBarHTML`、`renderPromptDiffPanelHTML`、`buildRequestMetricItems`、`renderPromptDiff*`、`renderPromptToolToggles`、`renderPromptVersions` 等 | ~520 |
| Messages / Output 卡片 | `renderMessagesHTML`、`renderMessageCard`、`renderOutputHTML`、`renderThinkingPlaceholderCard`、`mergeLegacyOutputRows`、`isAgentOutputRow` | ~80 |
| Agent Output Graph | `buildAgentOutputGraph`、`renderAgentOutputGraph`、`renderAgentRunNode`、`renderReactStepNode`、`renderToolCallNode`、`renderAgentOutputItem`、相关 helper | ~470 |
| Sent Prompt 弹窗 | `splitAssembledPrompt`、`renderSentPromptDialogHTML`、`renderSentPromptIcon` | ~80 |
| Pending human action 卡片 | `renderPendingHumanActionCards`、`renderApprovalOutputCard`、`renderQuestionOutputCard`、`renderApprovalHTML`、`renderQuestionHTML`、`buildQuestionAnswers` | ~80 |
| Timeline Graph | `renderTimelineHTML`、`buildTimelineGraph`、`filterTimelineGraph`、`renderTimelineGraphHTML`、节点构建/分类/状态/渲染 helper | ~520 |
| Timeline 旧扁平 fallback | `compactTimelineEvents`、`renderTimelineItem`、`timelineBadge`、`shouldShowTimelineEvent`、`friendlyTimelineKind`、`timelineIcon` | ~80 |
| Run Metrics / Tasks | `renderMetricsHTML`、`renderMetricCard`、`renderTasksHTML`、`formatProgressStatus`、`latestProgressFromEvents`、`latestTodosFromEvents` | ~70 |
| Trace 工具函数 | `createTodoTraceEvent`、`latestEvent`、`contentToText`、`chip`、`escapeHtml`、`escapeAttr`、`formatTime`、`formatBytes`、`formatTokenCount`、`todoIcon` | ~70 |

### 3.4 app.js 内容分布

| Section | 主要函数 |
|---------|----------|
| State / DOM 引用 | `state`、`els`、`SESSION_STORAGE_KEY` |
| Bootstrap / 路由 | `init`、`bindEvents`、`restoreSidebarState`、`toggleSidebar`、`setSidebarCollapsed` |
| Config / Providers | `loadConfig`、`saveConfig`、`renderProviders`、`renderConfigModels`、`openConfigDialog`、`removeConfiguredModel`、`editConfiguredModel`、`providerIdForModel`、`resetModelForm` |
| Session 生命周期 | `resumeOrStartSession`、`startSession`、`applySessionSnapshot`、`connectEvents`、`handleServerEvent`、`handleAgentEvent`、`abortRun`、`clearSession`、`flashStatus` |
| Prompt Playground | `submitPrompt`、`syncPromptRuntime`、`savePromptVersion`、`buildPromptSnapshotFromEditor`、`currentPromptSnapshot`、`resetPromptVersion`、`activatePromptVersion`、`deletePromptVersion`、`previewPromptQuery`、`bindPromptRequestActions`、`bindPromptDraftSync`、`updatePromptStats`、`schedulePromptDraftSync`、`sendPromptDraft`、`flushPromptDraftFromEditor`、`setPromptSaveHint`、`setPromptSyncStatusForState`、`setPromptSyncStatus`、`formatPromptSyncTime`、`resetPromptDraft`、`buildDraftPromptSnapshot`、`renderPromptDiff`、`renderRequest`、`renderAgentToolsBar`、`toggleAgentTool`、`applyEnabledTools`、`setupPackageToggle` |
| Skills | `loadSkills`、`renderSkills`、`openSkillEditor`、`saveSkill`、`deleteSkill` |
| Traces | `loadTraces`、`renderTraces`、`openTrace`、`deleteTrace` |
| Tools / Commands UI | `renderTools`、`openToolSchema`、`buildToolExample`、`exampleValueForSchema`、`renderCommands`、`setTimelineFilter`、`insertCommand` |
| Output / Timeline / Run state | `renderOutput`、`openSentPromptDialog`、`sendApproval`、`renderTimeline`、`renderRunState`、`renderTodoPanel`、`submitQuestion`、`renderTodo`、`openMessageDialog` |
| Trace export | `copyTraceExport`、`downloadTraceExport`、`buildSelectedTraceExport`、`exportFileName`、`downloadText`、`setExportStatus` |
| 共用工具 | `appendTraceRow`、`outputMessageForTraceRow`、`api`、`showError` |

### 3.5 styles.css 分区

Section 边界已经能从选择器名字直接看出来：

```text
:root variables / global / chips
topbar / brand / session summary
workspace / sidebar / panels
output / request / prompt playground
prompt diff / version / metrics / run card
output card / agent output graph
sent prompt dialog / message card
timeline (graph + legacy)
modal / question / composer
responsive @media queries
```

## 4. 解耦总策略

### 4.1 三大约束

1. **HTML 入口不动**：仍然 `<link href="/assets/styles.css">` + `<script src="/assets/app.js">`。
2. **`view.js` 的公开 API 不动**：保留 `web/public/view.js` 文件，作为聚合 / re-export 入口。所有外部 import 仍然 `from "./view.js"` 或 `../public/view.js`。
3. **`styles.css` 入口不动**：保留 `web/public/styles.css`，内部用 `@import url("./styles/<part>.css")` 拆分。

### 4.2 模块拆分方法

- JS 用 ESM `export` + 在 `view.js` 顶部 `export *` 聚合：
  ```js
  export * from "./view/providers.js";
  export * from "./view/timeline-graph.js";
  ...
  ```
  - 不在子模块用 `default` 导出，统一用 named。
  - 子模块之间共享的工具集中放进 `view/utils.js`，所有子模块从 `./utils.js` 引用，避免循环依赖。
  - 子模块之间互相依赖必须沿着固定方向（utils → primitives → renderers → graph builders），不出现互相 import。

- `app.js` 拆成入口 `app.js` + `app/<module>.js`：
  - 保留 `app.js` 作为 bootstrap：仅 `import` 子模块、初始化、绑定事件、暴露必要的 globals（如 `window.app`，仅当 HTML inline `onclick` 需要才加，目前未发现，所以无需暴露）。
  - 子模块通过显式传参共享 `state` / `els`，不引入全局单例之外的隐藏耦合。
  - 第一阶段允许 `state` 与 `els` 仍然在 `app.js` 内集中创建，传给子模块；第二阶段才考虑改成 `createState() / createEls()`。

- `styles.css` 拆成入口 `styles.css` + `styles/<part>.css`：
  - 入口文件仅放 `:root` / 全局 reset 与一组顶部 `@import`。
  - 每个子文件保持现状语义不变，整体顺序按现在的物理顺序排，避免改 cascade 优先级。
  - 响应式 `@media` 段单独成一个文件，仍放在最后被 `@import`。

## 5. JS 拆分细节

### 5.1 `web/public/view.js`（保留为聚合入口）

新结构：

```text
web/public/
├── view.js                # 仅做 re-export 聚合
├── view/
│   ├── utils.js           # escapeHtml/escapeAttr/chip/formatTime/formatBytes/formatTokenCount/todoIcon/contentToText/latestEvent
│   ├── providers.js       # provider/model 配置渲染
│   ├── traces.js          # renderTracesHTML / replayEventsToState
│   ├── skills-tools.js    # renderSkillsHTML / renderToolsHTML / renderCommandsHTML / renderCommandStripHTML 及其 helper
│   ├── prompt-request.js  # renderRequestHTML / renderRequestPackagePanelHTML / renderAgentToolsBarHTML / renderPromptDiffPanelHTML / renderPrompt* helpers / buildRequestMetricItems / computePromptStats
│   ├── messages.js        # renderMessagesHTML / renderMessageCard / summarizeMessageText / renderBlock / renderAssistantMessageBlock
│   ├── output-cards.js    # renderOutputHTML / renderInteractiveOutputCard / renderSystemOutputCard / renderOutputCardInner / renderThinkingPlaceholderCard / renderMessageOutputCard / mergeLegacyOutputRows / renderPendingHumanActionCards / renderApprovalOutputCard / renderQuestionOutputCard
│   ├── agent-output-graph.js  # isAgentOutputRow / buildAgentOutputGraph / renderAgentOutputGraph / renderAgentRunNode / renderReactStepNode / renderToolCallNode / renderAgentOutputItem / 相关 helper
│   ├── sent-prompt.js     # renderSentPromptIcon / splitAssembledPrompt / renderSentPromptDialogHTML
│   ├── timeline.js        # renderTimelineHTML / buildTimelineGraph / filterTimelineGraph / renderTimelineGraphHTML / 节点构建 / 分类 / 状态 / 渲染 / phase chip
│   ├── timeline-legacy.js # compactTimelineEvents / renderTimelineItem / timelineBadge / shouldShowTimelineEvent / friendlyTimelineKind / timelineIcon
│   ├── metrics-tasks.js   # renderMetricsHTML / renderMetricCard / renderTasksHTML / formatProgressStatus / latestProgressFromEvents / latestTodosFromEvents
│   └── human-actions.js   # renderApprovalHTML / renderQuestionHTML / renderQuestionItem / buildQuestionAnswers / createTodoTraceEvent
└── view.js（聚合）
```

`view.js` 内容收敛成（示例）：

```js
export * from "./view/utils.js";
export * from "./view/providers.js";
export * from "./view/traces.js";
export * from "./view/skills-tools.js";
export * from "./view/prompt-request.js";
export * from "./view/messages.js";
export * from "./view/output-cards.js";
export * from "./view/agent-output-graph.js";
export * from "./view/sent-prompt.js";
export * from "./view/timeline.js";
export * from "./view/timeline-legacy.js";
export * from "./view/metrics-tasks.js";
export * from "./view/human-actions.js";
```

### 5.2 模块依赖方向

```text
utils.js
   ↑
   ├── providers.js
   ├── traces.js
   ├── skills-tools.js
   ├── messages.js
   ├── sent-prompt.js
   ├── timeline-legacy.js
   ├── metrics-tasks.js
   └── human-actions.js
            ↑
            └── output-cards.js (需要 messages / sent-prompt / human-actions)
                   ↑
                   └── agent-output-graph.js (需要 output-cards / messages / sent-prompt)
   ↑
   └── prompt-request.js  (需要 utils 与 messages)
   ↑
   └── timeline.js        (需要 utils 与 timeline-legacy 用于 filter fallback / compact 工具)
```

约束：
- `view.js` 只 re-export，不放业务逻辑。
- 子模块不允许 `import` 自己之上的层（防循环依赖）。
- 函数原始字面量、CSS class 名、HTML 结构 **不变**。

### 5.3 `web/public/app.js`（保留为 bootstrap 入口）

新结构：

```text
web/public/
├── app.js                # bootstrap：状态初始化、事件绑定、ServerEvent 路由
└── app/
    ├── state.js          # 创建 state / els / 常量；保持 export 让其它子模块 import
    ├── api.js            # api(path, options) / showError / flashStatus
    ├── session.js        # resumeOrStartSession / startSession / applySessionSnapshot / connectEvents / handleServerEvent / handleAgentEvent / abortRun / clearSession / appendTraceRow / outputMessageForTraceRow
    ├── config.js         # loadConfig / saveConfig / renderProviders / renderConfigModels / openConfigDialog / removeConfiguredModel / editConfiguredModel / providerIdForModel / resetModelForm
    ├── prompt.js         # submitPrompt / syncPromptRuntime / savePromptVersion / buildPromptSnapshotFromEditor / currentPromptSnapshot / resetPromptVersion / activatePromptVersion / deletePromptVersion / previewPromptQuery / bindPromptRequestActions / bindPromptDraftSync / updatePromptStats / schedulePromptDraftSync / sendPromptDraft / flushPromptDraftFromEditor / setPromptSaveHint / setPromptSyncStatusForState / setPromptSyncStatus / formatPromptSyncTime / resetPromptDraft / buildDraftPromptSnapshot / renderPromptDiff / renderRequest / renderAgentToolsBar / toggleAgentTool / applyEnabledTools / setupPackageToggle
    ├── skills.js         # loadSkills / renderSkills / openSkillEditor / saveSkill / deleteSkill
    ├── traces.js         # loadTraces / renderTraces / openTrace / deleteTrace
    ├── tools.js          # renderTools / openToolSchema / buildToolExample / exampleValueForSchema
    ├── commands.js       # renderCommands / insertCommand / setTimelineFilter
    ├── output.js         # renderOutput / openSentPromptDialog / sendApproval / openMessageDialog / renderTimeline / renderRunState / renderTodoPanel / submitQuestion / renderTodo
    └── trace-export.js   # copyTraceExport / downloadTraceExport / buildSelectedTraceExport / exportFileName / downloadText / setExportStatus
```

`app.js` 收敛后的职责：

```js
import { state, els } from "./app/state.js";
import { bindEvents, init } from "./app/bootstrap.js";       // 可选拆出
import { handleServerEvent } from "./app/session.js";
// ...

init();                           // 顶层启动
```

### 5.4 共享 state / els

- `state` 和 `els` 只在 `app/state.js` 创建一次，导出为常量，由各子模块按需 import。
- 因为是同一进程同一个模块，ESM 单例语义保证所有子模块拿到的都是同一份对象。
- 不引入 mutable 全局 `window.state`。
- 子模块需要的 `View` / `TraceExport` 命名空间，仍然在子模块内部 `import * as View from "../view.js"`，避免 app 子模块和 view 子模块直接耦合。

### 5.5 ServerEvent / SSE 路由

- `connectEvents` / `handleServerEvent` / `handleAgentEvent` 必须保留在同一个文件中，统一在 `app/session.js`，避免事件类型分散导致丢分支。
- `app/session.js` 内部按 event.type 调用对应模块（`renderRequest`、`renderTimeline`、`renderOutput` 等）。

## 6. CSS 拆分细节

### 6.1 `web/public/styles.css`（保留为聚合入口）

新结构：

```text
web/public/
├── styles.css                    # 仅 :root / 全局 reset / @import 列表
└── styles/
    ├── base.css                  # :root + 全局 element + button 基础类
    ├── layout.css                # app-shell / topbar / brand / sidebar / workspace / center / panels / pane
    ├── chips.css                 # chip / live-status / warning-chip / success-chip / danger-chip / subtle-chip / status-flash
    ├── prompt.css                # prompt-playground / prompt-toolbar / prompt-editor / prompt-version / prompt-tool-* / prompt-status-pill / muted-inline / prompt-meta-line / prompt-validation
    ├── prompt-diff.css           # diff-grid / diff-row / diff-line / diff-pair / diff-side / diff-tool-list / prompt-diff-panel / prompt-diff-summary-item
    ├── request.css               # request-package-panel / request-package-pre / request-package-tools-bar / agent-tools-bar / agent-tool-chip / context-* / request-* / config-section
    ├── output-cards.css          # output-card 基础 / output-stack / output-list / output-card-* / message-card / message-modal-card / message-meta / role-label
    ├── agent-output-graph.css    # agent-output-graph / agent-run / react-step / agent-detail-node / agent-node-* / agent-tool-section / agent-detail-empty / agent-inspect-button / thinking-placeholder
    ├── sent-prompt.css           # sent-prompt-icon / sent-prompt-modal-card / sent-prompt-dialog* / sent-prompt-segment / sent-prompt-empty-added / sent-prompt-legend / legend-swatch
    ├── timeline.css              # timeline / timeline-graph / timeline-node / timeline-tree-line / timeline-type-chip / timeline-graph-children / timeline-graph-detail / timeline-tabs / filter-pill
    ├── timeline-legacy.css       # timeline-item / timeline-icon / timeline-summary-* / timeline-title / timeline-badge
    ├── metrics-tasks.css         # metrics-grid / metrics-stack / metric-card / metric-value / run-card / run-metrics-* / task-list / task-row / task-copy / mini-count
    ├── modal.css                 # modal / modal-card / modal-actions / sr-only / inline-select / search / icon-button / list / list-item / trace-item / model-row / tool-row / prompt-version-item / list-item-* / danger-mini
    ├── composer.css              # composer / question-stack / question-card / question-options / question-option / choice-row
    └── responsive.css            # @media queries（必须最后 @import）
```

`styles.css` 内容收敛成（示例）：

```css
@import url("./styles/base.css");
@import url("./styles/layout.css");
@import url("./styles/chips.css");
@import url("./styles/prompt.css");
@import url("./styles/prompt-diff.css");
@import url("./styles/request.css");
@import url("./styles/output-cards.css");
@import url("./styles/agent-output-graph.css");
@import url("./styles/sent-prompt.css");
@import url("./styles/timeline.css");
@import url("./styles/timeline-legacy.css");
@import url("./styles/metrics-tasks.css");
@import url("./styles/modal.css");
@import url("./styles/composer.css");
@import url("./styles/responsive.css");
```

### 6.2 Cascade 风险与处理

- 顺序按现有 `styles.css` 物理顺序拆，保证 cascade 不变。
- `responsive.css` 永远放最后 import。
- 不抽公共变量到子文件；`:root` 全部留在 `base.css`。
- `@import` 只在 `styles.css` 顶层使用一次，不在子文件里再 `@import`。
- 不允许同一个 selector 出现在两个子文件，遇到重复声明（例如 `.prompt-diff-card`）合并到同一个文件。

### 6.3 Cache busting

- HTML `<link>` 仍然 `?v=trace-lens-workbench-60`。
- 因为浏览器加载 `styles.css` 时会发起子请求拉每个 `@import`，子文件不会自动带主文件的 query；
  - 第一阶段不强制为子文件加 `?v=`，因为子文件文件名是新建的，浏览器没有旧缓存。
  - 后续每次发版只 bump `styles.css` 主文件 `?v=` 即可触发主文件刷新；子文件如果改动需要单独 bump，建议在 `@import url("./styles/<file>.css?v=trace-lens-workbench-60")` 内手动加版本号。
- 同步把 `index.html` 上的 `?v=trace-lens-workbench-60` 提升一档（例如 `61`），确保第一次发布拆分成果时浏览器立刻拿到新主文件。

## 7. 修改范围

### 7.1 必改文件

- `web/public/view.js`：内容只剩 re-export。
- `web/public/app.js`：内容只剩 bootstrap + 顶层 import。
- `web/public/styles.css`：内容只剩 `@import` 列表。
- 新增目录：
  - `web/public/view/`
  - `web/public/app/`
  - `web/public/styles/`
- `web/public/index.html`：仅 bump `?v=trace-lens-workbench-60` 至 `61`，路径不变。

### 7.2 不改的文件

- `web/server.ts`、`web/types.ts`、`web/trace.ts`、`web/prompt-versions.ts`、`web/skills.ts`、`web/tools.ts`
- `src/agent/*`、`src/foundation/*`、`src/coding/*`、`src/cli/*`
- `web/public/export.js`
- `web/public/design-mockup*.html`
- `web/__tests__/*.test.ts`：保持现有 import 路径不动。

## 8. 关键决策

| 主题 | 选择 | 理由 |
|------|------|------|
| 是否引入打包工具 | 否 | 现有方案是浏览器原生 ESM + 静态文件，引入 bundler 改动面太大 |
| 是否拆 `view.js` 为多入口 | 否 | 保留单一聚合入口，外部 import 不变，可控性最高 |
| `app.js` 子模块如何共享 state | 用 ESM 单例 import | 保持简单，无需引入全局 store 或事件总线 |
| 是否拆 `index.html` | 否 | HTML 长度可控，且 inline 一些表单结构不便分离 |
| 是否同时把 `export.js` 拆 | 否 | 当前长度可控，第二阶段再考虑 |
| 是否一次性删除 timeline-legacy | 否 | timeline-legacy 仍是 `compactTimelineEvents`/`shouldShowTimelineEvent` 等公开 export 使用入口；先拆模块，删除单独再做 |
| 是否拆 `styles.css` 用 `@import` | 是 | 浏览器原生支持，无需打包 |
| `?v=` cache busting 升级方式 | bump 主入口版本号到 61 | 不需要在每个子模块都加版本号，主入口刷新即触发其它子文件按需重新校验 |

## 9. 风险与对策

| 风险 | 对策 |
|------|------|
| 模块拆分后出现循环依赖 | 严格遵循依赖方向；`utils.js` 不依赖任何子模块；agent-output-graph 只依赖 output-cards / messages / sent-prompt / utils |
| ESM `export *` 命名冲突 | 拆分前先用 grep 检查每个公开导出在仓库内仅出现一次；如出现命名重复（如 `escapeHtml`），保证只有一个文件 export |
| CSS cascade 改变样式表现 | 保持子文件物理顺序与原文件一致；`responsive.css` 永远最后 import |
| 浏览器 `@import` 串行加载导致首屏变慢 | 子文件均放在同一域名下；后续若发现卡顿可改用多 `<link>`，第一阶段不优化 |
| 测试 import 失效 | 测试只 import `view.js` / `export.js`，聚合层保留命名导出，不变更签名 |
| `app.js` 隐式访问 inline `onclick` | 已用 grep 验证 HTML 没有 inline `onclick` 调用 `app.js` 内部函数；如有遗漏，处理为暴露到 `window.app` |
| `state` / `els` 子模块共享导致初始化时序问题 | `app/state.js` 必须只做声明 + 初始值，不在 import 时访问 DOM；`els` 的 DOM 查询挪到 `init()` 内执行 |
| 静态资源缓存 | bump `index.html` 的 `?v=` 至 61 |

## 10. 执行顺序

第一阶段：JS 解耦
1. 新建 `web/public/view/utils.js`，迁移 `escapeHtml`、`escapeAttr`、`chip`、`formatTime`、`formatBytes`、`formatTokenCount`、`todoIcon`、`contentToText`、`latestEvent`。
2. 在 `view.js` 顶部 `export * from "./view/utils.js"`，删除其中已迁移的函数。运行 `bun run check`。
3. 按 §5.1 顺序逐个迁移：`providers.js` → `traces.js` → `skills-tools.js` → `messages.js` → `sent-prompt.js` → `human-actions.js` → `output-cards.js` → `agent-output-graph.js` → `prompt-request.js` → `metrics-tasks.js` → `timeline-legacy.js` → `timeline.js`。
4. 每迁移一个模块后跑一次 `bun test web/__tests__/frontend-view.test.ts`，确保 export 一致。

第二阶段：app.js 解耦
5. 新建 `web/public/app/state.js`，迁移 `state`、`els` 占位、`SESSION_STORAGE_KEY` 与 `$`。
6. 按 §5.3 顺序逐个迁移：`api.js` → `session.js` → `config.js` → `prompt.js` → `skills.js` → `traces.js` → `tools.js` → `commands.js` → `output.js` → `trace-export.js`。
7. 每迁移一个模块后启动 `bun run web/server.ts` 手动验证：开新 session、发一条 query、看 Agent Output、看 Timeline、做一次 trace replay。

第三阶段：CSS 解耦
8. 按 §6.1 顺序逐段迁移子文件，每迁一段保留浏览器手动验证。
9. 最终把 `styles.css` 仅留 `@import` 列表。
10. bump `index.html` 的 `?v=` 至 `61`。

第四阶段：收尾
11. 跑 `bun run check`、`bun test`，确保 0 fail。
12. 手动验证 Web Playground：
    - Prompt Lab 编辑 + 自动保存 + flush submit
    - 发 query → Agent Output Graph 正常
    - Hook & Tool Timeline Graph 正常
    - Run Metrics 折叠
    - Trace 列表 + replay
    - Skill 列表 / Tool schema 弹窗
13. 更新 `AGENTS.md`（如需要）记录新目录结构。

## 11. 验证步骤

### 11.1 自动化

```bash
bun run check
bun test web/__tests__/frontend-view.test.ts
bun test web/__tests__/frontend-smoke.test.ts
bun test web/__tests__/frontend-export.test.ts
bun test web/__tests__/model-providers.test.ts
```

### 11.2 手动

1. `bun run web/server.ts` 启动。
2. 浏览器打开 `http://127.0.0.1:4317/`。
3. 检查无 404、无 ESM import 报错（DevTools Network + Console）。
4. 操作 Prompt Lab，确认 draft auto-save / flush 正常。
5. 发一条 query，确认 Agent Output Graph、Timeline Graph 渲染正常。
6. 打开历史 Trace 做 replay，确认结构与之前一致。
7. 检查 Run Metrics 折叠、Tasks（Run Metrics 内 metric）。
8. 触发 approval/question 流程，确认 pending 卡片渲染。

## 12. 验收标准

- 所有自动化测试通过。
- `web/public/view.js`、`web/public/app.js`、`web/public/styles.css` 三个入口文件长度均 < 200 行。
- 没有任何 `web/public/*` 子文件超过 700 行。
- HTML 入口、后端路由、测试 import 路径完全未改。
- 浏览器手动验证全部通过。

## 13. 后续可选

- 第二阶段：把 `state` 改成显式 `createAppState()` + 子模块通过参数注入，移除模块级 mutable 单例。
- 把 `view/output-cards.js` 与 `view/agent-output-graph.js` 共享的 helper（`renderSentPromptIcon` 等）抽成 `view/cards-shared.js`。
- 拆 `web/public/export.js`（如再增长）。
- 引入 TypeScript 检查 / `tsc --checkJs`。
- 考虑用 `import maps` 让 HTML 显式声明模块路径，提升可控性。

## 14. 可拓展性设计

解耦不仅是按当前代码切块，还要为未来新增能力预留落点。结合 Helixent 已有方向（`react + tools/MCP + skills + memory + lead/sub agent + trace`），下面把可能的新增场景和对应的扩展点固化进方案。

### 14.1 未来新增的典型场景

| 场景 | 表现形式 |
|------|---------|
| 新增后端 REST 接口 | 新 `GET/POST /api/...` 路径，前端要发请求并刷新 UI |
| 新增 SSE `ServerEvent` 类型 | `web/types.ts` `ServerEvent` 联合类型加新分支 |
| 新增 `TraceKind` | `web/types.ts` `TraceKind` 加新值，timeline / agent-output 要分类显示 |
| 新增 Agent Output 节点类型 | 例如 sub-agent 输出、memory recall、retrieval result |
| 新增 Timeline Phase / Agent Execution | 例如 `mcp` / `memory` / `retrieval` phase；`Agent Execution: sub-research` |
| 新增右侧栏面板 | 例如 Cost / Memory inspector / MCP Servers |
| 新增 Slash command / Tool schema 字段 | UI 需要新 chip / tab |
| 新增主题或视觉样式分支 | 例如暗黑/亮色切换、新组件样式 |

### 14.2 扩展点 1：API 客户端层

在 `web/public/app/api.js` 内：

- 提供唯一 `api(path, options)` 通用客户端，不内嵌任何业务逻辑。
- 业务调用统一在各 `app/<module>.js` 里写「领域 API 函数」，例如 `app/skills.js` 内 `fetchSkills() / saveSkill(skill)`、`app/prompt.js` 内 `fetchPromptVersions()`。
- 新增后端路径时只需要：
  - 在对应领域模块里加新方法 `mcpServers.list()`、不动 `api.js`。
  - 不允许任何 `app/<module>.js` 之外的子模块直接 `fetch()`。
- `view/*.js` 永远只接收数据，不发请求；保证 `view` 子模块对后端接口数量保持透明。

### 14.3 扩展点 2：ServerEvent 路由表

在 `web/public/app/session.js` 内：

- `handleServerEvent(event)` 改写成 **路由表 + 默认分支** 的形式：

```js
const SERVER_EVENT_HANDLERS = {
  ready: handleReady,
  agent: handleAgentEvent,
  streaming_state: handleStreamingState,
  message: handleMessage,
  trace: handleTrace,
  hook: handleTrace,
  approval: handleApproval,
  question: handleQuestion,
  todo_update: handleTodoUpdate,
  commands: handleCommands,
  error: handleError,
};

export function handleServerEvent(event) {
  const handler = SERVER_EVENT_HANDLERS[event.type] ?? handleUnknownServerEvent;
  handler(event);
}
```

- 未来加新 `ServerEvent` 类型只需在表里加一行 + 对应 handler，不再扫描全函数。
- `handleUnknownServerEvent` 默认走 `console.warn` + `state.events.push`，避免静默丢消息。
- 同样的策略复用到 `handleAgentEvent`，按 `event.type` 路由到子处理器。

### 14.4 扩展点 3：TraceKind 分类表

在 `web/public/view/timeline.js`、`view/agent-output-graph.js` 内：

- 把 `phaseForTimelineEvent` / `classifyTimelineEvent` / `isAgentOutputRow` 都改写成 **声明式表**：

```js
const TIMELINE_PHASE_BY_KIND = {
  input_context: "prompt_phase",
  prompt_version_applied: "prompt_phase",
  skills_inventory: "skills",
  // ...
};
const TIMELINE_EXTRA_PHASE_RESOLVERS = []; // 留给扩展注册

export function registerTimelinePhase(kind, phase) {
  TIMELINE_PHASE_BY_KIND[kind] = phase;
}
```

- 未来加 `TraceKind`（如 `mcp_call_started`、`memory_recalled`）只要：
  - 在表里加一项映射；
  - 或在子模块顶部 `registerTimelinePhase("mcp_call_started", "mcp")` 声明；
- 不需要再 grep 一遍所有 `switch`。
- Agent Output Graph 同理：`AGENT_OUTPUT_KIND_FILTER`、`AGENT_OUTPUT_ITEM_TYPE` 等改成可注册的对象。
- 未识别 kind 默认归入 `unscoped` phase / `unknown` item type，不丢失。

### 14.5 扩展点 4：固定 Phase / Agent Execution 字典

在 `view/timeline.js` 顶部声明：

```js
export const TIMELINE_PHASE_TYPES = [
  "prompt_phase",
  "skills",
  "model_call",
  "tool_planning",
  "tool_execution",
  "human_gate",
  "todo",
  "errors",
  "unscoped",
  // 预留，按需启用：
  // "mcp",
  // "memory",
  // "retrieval",
];
```

- Phase 类型集中声明，渲染顺序、phase chip 颜色都从这里查。
- 新增 phase 只需要：
  - 在数组里加一项；
  - 在 `phaseChip()` 里给一个颜色；
  - 在 `TIMELINE_PHASE_TITLES` 里给一个标题。
- 不需要改主树 builder 或事件归类逻辑（除非新事件需要进新 phase，那同步 §14.4 注册即可）。

`Agent Execution` 类型同理：`lead`、`sub-agent` 都从同一个常量数组生成 chip。

### 14.6 扩展点 5：右侧栏 / 面板插槽

`web/public/index.html` 右侧 `aside.timeline-pane` 已经按区域顺序排：

```text
Run Metrics（可折叠）
Hook & Tool Timeline
```

未来新增面板（例如 Memory inspector、MCP Servers）按下面流程：

1. 在 `index.html` 的 `aside.timeline-pane` 里加一个 `<section>` 占位，给唯一 `id`。
2. 在 `app/<new-module>.js` 内实现该面板的 render + 事件绑定。
3. 在 `app/state.js` 的 `els` 里追加一行 DOM 引用。
4. 在 `app/session.js` 路由表里追加新 ServerEvent 分支（如有）。
- 不需要改 `app.js` 入口，bootstrap 自动 import 新子模块即可。
- 不需要改 `view.js`，新面板的 HTML 渲染函数放进 `view/<new-module>.js` 并在聚合层 `export *`。

### 14.7 扩展点 6：CSS 主题与新组件样式

- `styles/base.css` 内 `:root` 集中所有设计 token（颜色、间距、圆角、字体）。
- 未来加新组件样式：新增 `styles/<new-module>.css`，并在 `styles.css` 入口的 `@import` 列表里追加一行。
- 主题切换：在 `:root` 下加 `[data-theme="..."]` 覆盖块；不修改子文件。
- 不允许新组件再写自己的硬编码颜色，必须用 `var(--accent-*)` token。

### 14.8 扩展点 7：Agent Output Graph 子节点类型

`view/agent-output-graph.js` 里新增：

```js
export const AGENT_OUTPUT_NODE_TYPES = {
  run: { ... },
  agent_execution: { ... },
  react_step: { ... },
  tool: { ... },
  thinking: { ... },
  response: { ... },
  error: { ... },
  // 预留：
  // memory_recall: { ... },
  // retrieval: { ... },
  // sub_agent: { ... },
};
```

- 新增节点类型只需要：
  - 在表里加一项；
  - 在 `renderAgentOutputItem` 里加一个分支（默认走 fallback render）；
  - 在 `agent-output-graph.css` 里加一段类型颜色。
- 不破坏现有 `Run / ReAct Step / Tool` 主骨架。

### 14.9 扩展点 8：Trace export 渠道

`web/public/export.js` 当前是单文件。预留：

- 未来加新渠道（例如 OpenTelemetry / Helixent Cloud）时，将其拆为 `export/<channel>.js`，在 `export.js` 聚合 re-export。
- 渠道注册表 `EXPORT_CHANNELS` 列在 `export.js` 顶部，UI 直接遍历渲染按钮，不再写死。
- 第一阶段不动 `export.js`，但本方案中 `app/trace-export.js` 必须保持「按渠道名查表调用」的写法，避免硬编码 `if/else`。

### 14.10 扩展点对照表

| 未来新增 | 落点文件 | 是否需要改入口（`view.js` / `app.js` / `styles.css`） |
|---------|---------|---------------------------------------------------------|
| 新 `/api/...` 接口 | `app/<module>.js` 的领域 API 函数 | 否 |
| 新 `ServerEvent.type` | `app/session.js` 路由表 | 否 |
| 新 `AgentEvent.type` | `app/session.js` 内 `handleAgentEvent` 子路由表 | 否 |
| 新 `TraceKind` | `view/timeline.js` 表 + `view/agent-output-graph.js` 表 | 否 |
| 新 Timeline Phase | `view/timeline.js` `TIMELINE_PHASE_TYPES` + `phaseChip` + `TIMELINE_PHASE_TITLES` + `styles/timeline.css` | 否 |
| 新 Agent Execution 类型 | `view/timeline.js` 与 `view/agent-output-graph.js` 中的 execution 字典 | 否 |
| 新 Agent Output 节点类型 | `view/agent-output-graph.js` `AGENT_OUTPUT_NODE_TYPES` + `styles/agent-output-graph.css` | 否 |
| 新右侧栏面板 | `index.html` 加 `<section>` + 新增 `app/<x>.js` + `view/<x>.js` + `styles/<x>.css`（@import 列表追加一行） | 是（HTML 必须加 DOM 占位；`styles.css` 入口追加一行 @import） |
| 新 Trace export 渠道 | `web/public/export/<channel>.js` + `export.js` 聚合 | 否 |
| 新主题 token | `styles/base.css` `:root` 加变量 | 否 |

### 14.11 扩展原则（Definition of Done）

未来新增组件必须满足：

1. 新 `/api/...` 必须在 `app/<module>.js` 中暴露一个 typed-ish 的领域函数，不允许散落 `fetch()`。
2. 新 `ServerEvent` / `AgentEvent` / `TraceKind` 必须在对应路由表 / 分类表中显式注册，避免散布 `if (event.type === ...)`。
3. 新 UI 子模块必须放进 `view/<x>.js` 并由 `view.js` 聚合 re-export；不允许 `app/*` 子模块直接写 HTML 渲染。
4. 新 CSS 必须放进 `styles/<x>.css` 并由 `styles.css` 入口 `@import`。
5. 新 phase / execution / node 类型必须更新对应集中字典，并在 `bun test` 中补一组结构断言。
6. 解耦后任何只写一行 `if (event.type === ...)` 的硬编码补丁都属于反模式，应改为注册到对应表里。
