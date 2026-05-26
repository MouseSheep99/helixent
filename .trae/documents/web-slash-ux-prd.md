# Web Slash 指令 UX 体验升级 PRD

> Status: Draft · Owner: TBD · Triage: ready-for-agent
> 关联 PRD：[web-slash-commands-prd.md](file:///Users/bytedance/Documents/Codex/helixent/.trae/documents/web-slash-commands-prd.md)（一致性问题）、[web-slash-commands-tdd.md](file:///Users/bytedance/Documents/Codex/helixent/.trae/documents/web-slash-commands-tdd.md)（已落地的解析/分发层）
> 关联代码：
>
> * [web/public/index.html](file:///Users/bytedance/Documents/Codex/helixent/web/public/index.html#L120-L129)（composer 表单）
>
> * [web/public/app/commands.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/commands.js)
>
> * [web/public/view/skills-tools.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/skills-tools.js#L73-L82)（renderCommandsHTML）
>
> * [web/public/view/agent-output-graph.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/agent-output-graph.js)（Agent Output 渲染）
>
> * [web/public/view/timeline.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/timeline.js)（Hook & Tool Timeline 渲染）

***

## Problem Statement

「Web Slash Commands 一致性 PRD」让 `/clear`、`/help`、`/exit` 等斜杠指令在 Web 上能跑通了，但作为 **UX 体验** 还差三块：

1. **没有键入辅助**：当前 textarea 仅依赖原生 `<datalist>`，触发条件依赖浏览器实现（实际上很多浏览器只在按下方向键或聚焦后才显示候选），用户输入 `/` 时没有可发现性强的下拉框，更没有按命中字符高亮。对比 IDE / Cursor / Claude Code 终端的体验差距明显。
2. **输入框里看不出"这是命令"**：用户连续输入 `/help` 时，textarea 看起来跟普通文本毫无区别。希望键入 `/xxx`（已注册的斜杠指令）后，命令名以\*\*胶囊（chip / pill）\*\*样式被独立渲染出来，用户一眼能看出"这是一条指令"。
3. **Agent Output 与 Hook & Tool Timeline 没有为指令做专属表达**：

   * 用户气泡里就一行 `/help` 文字，无法和普通用户消息一眼区分；

   * Agent Output 的 reasoning trail 里命令的合成回复只是一段普通 `final-answer-text`；

   * Hook & Tool Timeline 上只看到一个 `user_input` 节点和一个 `model_output_block: text`，没有任何"这一轮是指令交互"的视觉锚点。

后果：

* 新用户不知道 Web 支持斜杠指令；

* 老用户记得有 `/clear`，但对于其他 `/help`、`/skill-name` 类命令没有发现路径；

* 对话历史/导出里 `/clear`、`/help` 与真实模型对话视觉混杂，回看时容易误解。

## Solution

把 Web 上的 slash 指令从「能跑」升级到「看得见、用得顺、回看清楚」，分三条交付线：

### A. 键入辅助：Slash Suggestion Popover

在 textarea 上方挂一个**自定义浮层**（替代 `<datalist>` 的可发现性问题，但仍允许 `<datalist>` 作为 a11y 兜底）。触发条件：

* textarea 的当前光标行以 `/` 开头，且 `/` 后还没有空格。

* 浮层内容来自 `state.commands`（已经包含 builtin + skill），按命中前缀字符高亮，按 builtin/skill 分组。

* 键盘交互：`↑/↓` 选择，`Enter` 或 `Tab` 补全，`Esc` 关闭。

* 鼠标交互：点击候选项即补全到 textarea。

* 无候选时浮层隐藏（不阻塞普通文本输入）。

* 命中后自动追加一个空格，让用户继续输入参数。

参考用户附图 1（Cursor / Claude Code 的下拉补全）。

### B. 输入框命令胶囊：Command Chip in textarea

textarea 在前缀是已注册命令时（`parseSlashInputClient` 返回 `builtin` 或 `skill`），把 `/cmd` 子串以**胶囊视觉**显示。两种实现路径，按"实施代价 vs 视觉效果"折中（决策见 §Implementation Decisions）：

* B1（推荐，低成本）：textarea 保持原状，**在 textarea 上方显示一个独立的 chip 行**，写明「`/help` will be sent as a slash command」，用户可点 chip 上的 ✕ 把整段命令清掉。

* B2（高成本）：把 textarea 替换为 `contenteditable` 的迷你富文本编辑器，命令片段渲染成真正的 inline chip。本期不做。

参考用户附图 2（输入框里的 `/to-prd` 胶囊）。

### C. Agent Output / Timeline 专属渲染：Command Card

后端发送的 `command_executed` 事件是已有的（见 [web/types.ts](file:///Users/bytedance/Documents/Codex/helixent/web/types.ts#L58)）。这次让前端把它升级为**一等公民**：

1. **用户气泡**：检测到 user message 是合法的 `/cmd`（不是普通文本）时，渲染成「指令气泡」样式（不同色阶、左侧加 `❯` 图标 + 命令名 chip）。
2. **Agent Output**：合成回复（`/help`）不再混入普通 reasoning trail，而是渲染为独立的 **Command Card**：标题 = `/help`，副标题 = "Built-in command"，内容区按 monospace 排布帮助文本。
3. **Hook & Tool Timeline**：为 `command_executed` 事件添加单独节点（kind = `command_executed`），分类落到一个新的 `slash_command` 类目，归到 user\_input phase 之下，与 model\_call / tool\_execution 平级。
4. **过滤器**：Timeline 过滤器加入 `slash` 类目，方便回看一长条 trace 时只看指令交互。

### D. 区分「本地命令」与「入模命令」（Local vs Prompted）

**问题背景**：当前 helixent 的 slash command 分两个语义层，但前端目前完全没区分：

* **Local command（本地命令）**：dispatcher 在 server.ts 的 early-return 分支处理（`state-mutation` / `render-message` / `unsupported`），合成消息**不会写入** **`session.agent.messages`**，模型下一轮看不到这条交互。例如 `/clear` `/help` `/exit`（在 web 上 unsupported）。

* **Prompted command（入模命令）**：fallthrough 到 `session.agent.stream(userMessage)`，**会进入** **`messages`** **并参与后续多轮对话**。例如 `/skill-name ...`、未识别 `/xxx`（按普通文本发给模型）。

**用户痛点**：用户键入 `/help` 后无法判断这条交互是否会污染下一轮模型上下文，直接影响 prompt 工程的可预测性；同样地，键入 `/skill-name` 时希望被明确告知「这条会发送给模型」。

**解决方案**：在 chip / 用户气泡 / Command Card / Timeline 节点上都标注一个语义标签：

* **Local**：灰底 chip + `❯` 图标 + 副标题「Local · won't reach the model」。

* **Prompted**：蓝底 chip + `→` 图标 + 副标题「Sent to model · will appear in context」。

* 未识别 `/xxx`：橘底 chip + `?` 图标 + 副标题「Unknown · will be sent as plain text」。

**信息来源**（无需新事件契约）：

* `parseSlashInputClient` 返回 `kind`（`builtin` / `skill` / `unknown` / `not-slash`）；

* `command-registry` 的 `BUILTIN_COMMANDS` 表对每个 builtin 标注一个新字段 `effect: "local" | "prompted"`（`clear/help/exit/quit` 都是 `local`）；

* skill 类目无脑视为 `prompted`；

* `unknown` 视为 `prompted`（因为它会 fallthrough 给模型）。

前端视觉决策表：

| parseResult.kind | command.effect                | chip 颜色  | 副标题                           | Timeline 标签      |
| ---------------- | ----------------------------- | -------- | ----------------------------- | ---------------- |
| `builtin`        | `local`（clear/help/exit/quit） | 灰        | Local · won't reach the model | `slash:local`    |
| `builtin`        | `prompted`（未来扩展用）             | 蓝        | Sent to model                 | `slash:prompted` |
| `skill`          | (always prompted)             | 蓝        | Sent to model · skill         | `slash:prompted` |
| `unknown`        | (treat as prompted)           | 橘        | Unknown · sent as plain text  | `slash:unknown`  |
| `not-slash`      | —                             | 不显示 chip | —                             | —                |

### E. Skills 目录变更检测（Hot-reload of Skills）

**问题背景**：用户向 `.agents/skills/` / `skills/` / `~/.helixent/skills/` 等目录**通过 IDE 直接拷贝/创建**新的 skill 文件夹后，Web 前端不会立刻看到 `/new-skill`。

根本原因（已经定位）：

* [web/server.ts#L355](file:///Users/bytedance/Documents/Codex/helixent/web/server.ts#L355) 在创建 session 时一次性 `loadAvailableCommands(skillsDirs)`，结果缓存在 `session.commands`。

* 之后**只有当用户从 web UI 通过** **`POST /api/skills`、`PUT /api/skills/:slug`、`DELETE /api/skills/:slug`** **操作时**，才会调 [refreshSessionCommands()](file:///Users/bytedance/Documents/Codex/helixent/web/server.ts#L820-L826) 重新扫盘并通过 SSE 推 `commands` 事件。

* 用户用 IDE / git checkout / `npx skills add` 等**外部手段**修改目录，server 完全无感。

* 即使刷新页面也不会变，因为 `snapshotSession` 直接读取 `session.commands` 的缓存，不再扫盘。

**用户痛点**：

* 用 `npx skills@latest add ...` 装上的新 skill，在 Web 上输入 `/skill-name` 仍然报 Unknown，体验割裂。

* 老用户对"目录里有就有"的心智模型与现状冲突，需要重启 server 才能见效。

**解决方案**（按代价由小到大三选一，PRD 推荐先做 ① + ② 的组合）：

1. **Refresh on connect / on snapshot**（必做）：每当一个新的 SSE 客户端连接 / `snapshotSession` 被调用时，先调用一次 `refreshSessionCommands(session)`，让 **刷新页面 = 重新扫盘**。代价极小（一次 `fs.readdir`），对启动期延迟可忽略。
2. **Manual refresh endpoint + UI button**（推荐做）：

   * 后端新增 `POST /api/sessions/:id/skills/refresh`（或 sessionless 的 `POST /api/skills/refresh`），调用 `refreshSessionCommands()`。

   * 前端在 sidebar Skills 区块右上角加一个「Reload」按钮（icon 圆形旋转箭头）；点击后请求该 endpoint，server emit `commands` 事件，前端就地更新。

   * 适合用户自己装完 skill 就能"手动一下立刻见效"。
3. **File watcher**（可选，不必本期上）：用 `node:fs.watch` 或 `chokidar` 监听 `getSkillsDirs(cwd)` 中存在的目录，事件 debounce 后调 `refreshSessionCommands()`。代价是要处理跨平台 watcher 兼容性（macOS FSEvents vs Linux inotify vs WSL）以及 `~` 展开后路径的递归监听。**本期不上**，留给二期。

**对外契约影响**：

* 复用既有 `commands` SSE 事件契约（[web/types.ts](file:///Users/bytedance/Documents/Codex/helixent/web/types.ts) 的 `{ type: "commands"; commands: SlashCommand[] }`），无需新增事件。

* 新增 1 个 HTTP endpoint：`POST /api/skills/refresh`（无 body 或可选 `{ sessionId? }`），返回 `{ commands }`。

**对外可发现性**：

* 在 `/help` 帮助文本最后追加一行说明：「Skills are loaded from the configured skills directories on session start, page refresh, or via the Reload button.」让用户清楚不会自动热加载。

***

## User Stories

1. 作为 Web 用户，我希望在输入框中键入 `/` 后立刻看到一个候选指令浮层，这样我能发现并选择我能用的指令。
2. 作为 Web 用户，我希望候选浮层把我已经键入的字符（如 `/he`）做高亮匹配（如 `**h**andoff` 与 `**h**elp`），这样我能快速锁定目标。
3. 作为 Web 用户，我希望按 `↓` `↑` 在候选项之间移动，按 `Enter` 或 `Tab` 把当前选中项补全到输入框，按 `Esc` 关掉浮层，这样不需要离开键盘。
4. 作为 Web 用户，我希望候选浮层在我把 `/` 删掉或继续输入空格之后自动消失，这样它不打扰普通文本输入。
5. 作为 Web 用户，我希望浮层把 builtin 和 skill 分组展示并标注 description，这样我能区分系统命令和技能。
6. 作为 Web 用户，我希望我键入合法 `/cmd` 之后，输入框上方出现一个 chip 提示「will be sent as `/cmd`」，这样我能确认即将发送的是一条指令而不是普通消息。
7. 作为 Web 用户，我希望未识别的 `/xxx` 不显示 chip 但显示警示 toast「未识别命令」，这样我不会误以为正在调用某个工具。
8. 作为 Web 用户，我希望 `/help` 在 Agent Output 里渲染为一张独立的 Command Card，标题写明「Slash command · `/help`」，正文按等宽字体排版帮助清单，这样我能跟普通模型回复区分开。
9. 作为 Web 用户，我希望我发送的 `/help` 在用户气泡上以胶囊样式显示「`/help` · Built-in」，这样我回看历史时一眼能识别这一轮是指令交互。
10. 作为 Web 用户，我希望 Hook & Tool Timeline 上为 `command_executed` 事件单独显示一个节点，分类标注为 `slash`，归到 user\_input phase 之下，这样我在 timeline 里能定位"我什么时候执行了什么命令"。
11. 作为 Web 用户，我希望 Timeline 顶部的过滤器栏加一个 `Slash` 选项，开启后只看指令相关事件，这样回放长 trace 时能聚焦命令交互。
12. 作为 Web 开发者，我希望 Slash 指令在 Agent Output 和 Timeline 上的渲染是基于 `command_executed` 这一条 SSE 事件，而不是嗅探 message content，这样未来新增 `/compact` 等指令时无需再改前端嗅探逻辑。
13. 作为 Web 用户，我希望 `/clear` 这种"无可见 assistant 回复"的指令也在 Agent Output 顶部短暂提示 "Session cleared"（自动消失）而不是只在右上角 flash status，这样状态变更可发现性更强。
14. 作为可访问性用户，我希望浮层是 `role="listbox"`，候选项是 `role="option"`，textarea `aria-controls` 指向浮层，`aria-activedescendant` 指向当前选中项，这样屏幕阅读器能正常报读。
15. 作为 Web 用户，我希望浮层的位置紧贴在 textarea 上方，不会被 sidebar/timeline 折叠状态影响，且窗口宽度变化时自动跟随 textarea，这样它在任何布局下都易用。
16. 作为 Web 用户，我希望在键入合法 `/cmd` 之后，输入框上方的 chip 上明确标注「Local · won't reach the model」或「Sent to model」，这样我能准确判断这条命令是否会污染下一轮的模型上下文。
17. 作为 Web 用户，我希望 Agent Output 上的 Command Card 也保留 Local/Prompted 标签，这样我回看历史时能立刻识别哪些轮次实际进入了模型上下文、哪些只是本地操作。
18. 作为 Web 用户，我希望 Timeline 过滤器细分为 `Slash · Local` 和 `Slash · Prompted` 两个 chip，这样我能单独审查"哪些 slash 命令真正进入了对话历史"。
19. 作为 prompt 工程师，我希望未识别的 `/xxx` 在被 fallthrough 当作 plain text 发送前，输入框 chip 显示橘底警告「Unknown · sent as plain text」，这样我不会误以为这一行是无副作用的本地命令。
20. 作为 helixent 维护者，我希望 `BUILTIN_COMMANDS` 表的每一项都显式标注 `effect: "local" | "prompted"`，这样新增 builtin 时（比如未来的 `/compact`）必须做出明确选择，不会因为遗漏而错走默认行为。
21. 作为 Web 用户，我希望我用 IDE 直接往 `.agents/skills/` 拖一个新 skill 后，**刷新页面**就能在浮层和 sidebar 看到新命令，无需重启 server。
22. 作为 Web 用户，我希望 sidebar 的 Skills 区块右上角有一个「Reload」按钮，点一下立刻重扫 skills 目录并广播给前端，无需刷新页面。
23. 作为 Web 用户，我希望 reload 完成后浮层 / sidebar / `/help` 输出三个地方同步更新，并有一个轻量 toast「Skills reloaded · N commands」做反馈。
24. 作为 helixent 维护者，我希望 `/help` 帮助底部包含一行说明，告诉用户 skills 不是自动热加载的，需要刷新或 Reload。

***

## Implementation Decisions

### 模块划分

新增 / 改动的模块按职责分两层：**纯函数 helper** + **DOM 控制器**。helper 单测，控制器烟雾测试。

#### M1. `slash-suggestion`（新模块，纯函数）

位置建议：`web/public/view/slash-suggestion.js`。

职责：

* 输入：`{ text, caretOffset, commands }`。

* 输出：`{ open: boolean, query: string, items: SuggestionItem[], activeIndex: number }`。

* `SuggestionItem` 形如 `{ name, type: 'builtin' | 'skill', description, matchHighlight: Array<[start, end]> }`。

* 不直接动 DOM；浮层渲染由 controller 调用 `renderSuggestionPopoverHTML(items, activeIndex)`。

行为决策：

* 当 caret 所在「逻辑行」从行首到 caret 的子串以 `/` 开头且不含空格 → `open: true`。

* query = 该子串去掉首字符 `/`，全部小写化后做前缀 + 子串包含双重匹配；前缀命中排在前。

* `activeIndex` 由 controller 维护并传回 helper（helper 只做 clamp）。

* 候选最多 10 项；首项默认选中。

* 高亮区间用「query 在 name 中的连续位置」生成，单测覆盖大小写、跨字符、零命中场景。

#### M2. `composer-controller`（新增 DOM 控制器，挂到现有 `web/public/app/composer.js` 或 `commands.js` 扩展）

职责：

* 监听 `promptInput` 的 `input` / `keydown` / `blur` / `click` 事件。

* 调用 M1 计算下拉状态，更新浮层 DOM。

* 处理 `↑/↓/Enter/Tab/Esc`，选中后回写 textarea 并关闭浮层。

* 维护「指令 chip」hint：textarea 上方的状态条。每次 `input` 后判断 `parseSlashInputClient(text, state.commands)`：

  * `builtin` / `skill` → 显示绿色胶囊「`/cmd` · Built-in」或「`/cmd` · Skill」。

  * `unknown` → 显示橘色胶囊「Unknown command: `/xxx`」。

  * `not-slash` → 不显示胶囊。

* chip 上的「✕」按钮点击后清空 textarea 内 `/cmd` 前缀（不动后续参数）。

可访问性：

* 浮层用 `role="listbox"`，候选项 `role="option" id="slash-opt-N"`。

* textarea 加 `aria-controls="slashSuggestionPopover" aria-autocomplete="list" aria-expanded="..." aria-activedescendant="..."`。

* 浮层关闭时所有 ARIA 属性同步重置。

CSS：

* 复用现有 `--surface` / `--border` token；浮层是 `position: absolute`，挂在 textarea 父容器内（`.composer` 已是 form，加 `position: relative`）。

* 高亮用 `<mark>` 元素 + 现有 `--accent` token，避免新引入颜色。

#### M3. `command_executed` 渲染升级

后端 SSE 已经发 `command_executed`（[web/types.ts#L58](file:///Users/bytedance/Documents/Codex/helixent/web/types.ts#L58)）。本次让前端把它落地为渲染节点，而不是只 flashStatus。

实施点：

* **state**：在 `state.traceRows` 里追加一行 `{ type: "command_executed", name, reason?, at }`，作为渲染来源。

* **agent-output-graph**：

  * `isAgentOutputRow` 增加 `command_executed` 分支（true）。

  * `buildAgentOutputGraph` 把 `command_executed` 视为 run 边界（与 user message 同级）：在 run 中追加 `commandCard` 节点，渲染时单独输出一张 Command Card；`/help` 的合成 assistant message 由 dispatcher 用 `__synthetic` 标记，找到与上一个 user `/cmd` 相邻时合并到同一张 Command Card 中（折叠展开）。

  * `/clear` 类没有 assistant 回复的，命令卡渲染为单行 dim chip "Session cleared"，3s 后自动隐藏（CSS animation）。

* **timeline**：

  * `web/public/view/timeline.js` 的 `eventCategory()` 增加 `command_executed → "slash"`。

  * `eventPhaseKey()` 把它归到 `user_input` phase。

  * 顶部过滤器 chip 列表新增 `Slash`。

  * `web/public/view/timeline-legacy.js` 的图标和 filter 同步更新。

* **input message bubble**：

  * `agent-output-graph.js` 的 `renderUserTurn` 检查 user message 文本是否匹配 `^/[a-z][\w-]*` 且 `parseSlashInputClient` 命中 → 渲染 `chat-command-bubble` 样式（深蓝底 + chip）。

  * 不命中时保持原 `user-bubble`。

#### M4. 移除/降级 `<datalist>` fallback（决策点）

现有 `<datalist id="commandPicker">` 不删除，作为「JS 失败兜底」继续保留。M2 浮层显示时 `aria-hidden=true` 隐藏 datalist 的视觉副作用（部分浏览器仍会画一个原生小箭头，CSS 用 `appearance: none` 抑制）。

### 接口契约

不新增 SSE 事件；`command_executed` 既有契约不变。这是有意为之：本次是纯前端渲染升级。

### `effect` 字段（命令副作用语义）

`SlashCommand` 类型新增**必填**字段 `effect: "local" | "prompted"`：

* `local`：dispatcher 在 server early-return 分支处理，**不进** **`session.agent.messages`**。

  * 当前 `clear / help / exit / quit` 全部为 `local`。

* `prompted`：会通过 `agent.stream(userMessage)` 进入对话历史。

  * 当前所有 skill 自动视为 `prompted`（不在 `BUILTIN_COMMANDS` 里）。

  * 未识别 `/xxx` fallthrough 也视为 `prompted`（前端展示时）。

把字段设为**必填**而非可选，是为了让任何新增 builtin 都必须显式声明语义；缺省可能导致下一个开发者错走"我以为是 local 但实际进了 messages"的坑。

后端 `command_executed` 事件**新增可选字段** `effect: "local" | "prompted"`，方便前端不重复查表（前端目前已经从 `state.commands` 拿得到，但带上字段更稳健）。这一改动是**可选的兼容扩展**，前端必须容忍缺省。

### 与已落地代码的衔接

* `parseSlashInputClient` 已存在于 [session.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/session.js#L423-L435)，不动。

* `dispatch` 后端已 emit `command_executed`，前端已注册事件类型，但目前只 flashStatus，本次扩展为渲染来源。

* `__synthetic` 标记前端已识别（[outputMessageForTraceRow](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/session.js#L467-L475)）。M3 把它升级为 Command Card 的内容来源。

### 选型与折衷

* **不引入第三方 combobox 库**：避免拉新依赖、维持纯 ESM 部署，自己写一个 \~150 行的 helper + controller。

* **不上 contenteditable 富文本**：textarea 行为最稳定，chip-as-hint 比 chip-in-textarea 简单 5 倍而效果接近。

* **`<datalist>`** **不删**：兜底 + 避免 a11y 回归。

***

## Testing Decisions

测试金字塔自下而上：

### T1. `slash-suggestion` 单测（纯函数，bun test）

文件：`web/__tests__/slash-suggestion.test.ts`。

覆盖：

* 输入不含 `/` → `open: false`。

* 输入 `/` 单字符 → 列出全部 commands，activeIndex=0。

* 输入 `/he` → 命中 `help` / `handoff`，前缀命中优先；高亮区间正确。

* 输入 `/help foo`（含空格）→ `open: false`（已经在写 args）。

* caretOffset 不在 `/cmd` 字段中 → `open: false`（光标移到中间普通文本时）。

* commands 含大小写混杂 → 匹配大小写不敏感。

* commands 为空数组 → `items: []`，`open: true` 仍允许（用于显示 "no commands"）。

### T2. `command_executed` 渲染契约单测

文件：`web/__tests__/frontend-command-card.test.ts`。

覆盖：

* 单条 user message + command\_executed `/clear` → graph.runs 里产出 `commandCard: { name: "clear" }`，无 assistant 回复。

* 单条 user message + command\_executed `/help` + 合成 assistant `__synthetic: true` → 同一个 commandCard 里 detail 包含 help 文本，**不再走 reasoning trail**。

* timeline `eventCategory(command_executed)` 返回 `"slash"`；`eventPhaseKey` 返回 `"user_input"`。

* timeline filter `slash` 仅展示 command 类事件。

* **回归用例**：在 web server 层连续 submit `/help` 三次，断言 `session.agent.messages.length` 不变（确认 local 命令不污染上下文）。

* **回归用例**：submit `/help` 之后再 submit 普通 user message，断言模型上下文里没有 `/help` 这一条。

* chip 的 effect 标签：`builtin/clear` → `local`；`skill/foo` → `prompted`；`unknown/xxx` → `prompted`。

### T3. composer 烟雾测试（dom-only，可选）

文件：`web/__tests__/frontend-composer-suggestion.test.ts`。

仅测 `renderSuggestionPopoverHTML` 输出快照（不 mount controller）；交互流由人工验证。

### T4. Skills hot-reload 集成测试

文件：`web/__tests__/skills-refresh.test.ts`。

覆盖：

* 创建 session 后，往 fixture skills 目录写一个新 `SKILL.md`，调用 `POST /api/skills/refresh`，断言响应 `commands` 中包含新 skill；并断言 SSE 上收到 `commands` 事件。

* 调用 `snapshotSession` 之前先在目录追加一个 skill，断言 snapshot 返回的 `commands` 包含它（验证 §E ① 必做项）。

* 删除目录中一个 skill 后调用 refresh，断言它从 commands 中消失。

### 测试反例（不写）

* 不测光标定位精确像素（jsdom 不支持，且属于 CSS 表现）。

* 不测 SSE 重放（已有 `frontend-smoke.test.ts` 覆盖）。

### 现有相邻测试参考

* [frontend-canonical-graph.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-canonical-graph.test.ts)（图结构契约）

* [frontend-timeline-export.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-timeline-export.test.ts)（filter 行为）

* [frontend-todo-noise.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-todo-noise.test.ts)（事件 dedup）

* [command-registry.test.ts](file:///Users/bytedance/Documents/Codex/helixent/src/cli/tui/__tests__/command-registry.test.ts) / [slash-dispatcher.test.ts](file:///Users/bytedance/Documents/Codex/helixent/src/cli/tui/__tests__/slash-dispatcher.test.ts)（解析/分发层）

***

## Out of Scope

* **CLI TUI 浮层**：CLI 已有 ink-based 候选，这次不动。

* **嵌入式 chip 富文本输入**（B2 方案）：本期不上，留给二期或 contenteditable 重构时。

* **新增 builtin / skill**：不动 `BUILTIN_COMMANDS` 集合。

* **后端事件契约改动**：`command_executed` 字段不增不删；本次纯前端。

* **Trace 文件落盘格式**：`command_executed` 是否写入 `.jsonl` 不在本期决策（默认沿用现状：仅 `message` 与 `trace`/`hook` 落盘）。

* **多语言**：候选浮层文案先用英文 + 沿用现有 zh-EN 混排策略。

* **Skills 文件系统 watcher（自动 hot-reload）**：跨平台稳定性 + `~` 路径展开 + 递归监听都比较麻烦，本期只交付「刷新页面」+「Reload 按钮」，watcher 留二期。

***

## Further Notes

* `web/public/index.html` 当前写死 `list="commandPicker"` 的 `<datalist>`，浮层覆盖在它上面但保留兜底。

* 如果将来要做 `/compact` 这类**会修改消息历史**的指令，Command Card 是天然落点（card 内可同时展示「截断了 N 条」之类摘要），无需再设计。

* 用户附图 2 的「`/to-prd` chip 在 textarea 内」是 contenteditable 实现的，本期 chip-as-hint 方案在视觉上接近但不在框内。后续二期可一次性重构 composer 为 contenteditable 升级到附图 2 的视觉。

* 浮层位置算法：以 `promptInput` 的 `getBoundingClientRect()` + 父容器的 `composer` 为锚，向上展开（top = -popoverHeight - 4）。窗口尺寸变化通过 `ResizeObserver(promptInput)` 重新计算。

