# Trace Lens 折叠交互重构 —— 技术开发文档

> 状态：DRAFT，等待 review。本次为 Trae 前端工作台 (`web/public/*`) 的纯交互/视觉改造，**不涉及后端 API、SSE、消息协议或 trace 模型**。

---

## 0. 范围声明

| 维度 | 是否变更 | 说明 |
|---|---|---|
| 前端（`web/public/*` HTML/CSS/JS） | ✅ | 唯一变更面 |
| 前端测试（`web/__tests__/*.test.ts`） | ✅ | 新增 1 个文件 + 改写 1 处断言 |
| Bun 服务端（`web/server.ts` 等） | ❌ | 不动 |
| `src/foundation`、`src/agent`、`src/coding`、`src/cli`、`src/community` | ❌ | 不动 |
| 持久化数据 / trace JSONL 格式 | ❌ | 不动 |
| 新增 localStorage key | ✅ | `helixent.timelineCollapsed`（前端本地状态，不上行后端） |

---

## 1. 需求映射表

| # | 用户原话 | 解读 | 模块 |
|---|---|---|---|
| R1 | 右边做成可以折叠 | 镜像 sidebar，timeline-pane 支持独立折叠态 + 折叠后 56px rail | DOM/CSS/JS/State |
| R2 | 左侧折叠按钮换位置 | 移除 topbar 中 `☰`，改放 sidebar **右边缘** | DOM/CSS |
| R3 | 左右同时折叠是否允许 | **允许**——`body.sidebar-collapsed` 与 `body.timeline-collapsed` 正交 | CSS Grid |
| R4 | 边缘细条按钮 + chevron 箭头 | 新组件 `.edge-handle`：竖条 + 中央 CSS 三角，hover 高亮，状态翻转 | CSS |
| R5 | Skills/Tools/Traces panel 折叠 | 逻辑[已存在](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/session.js#L35-L40)但**无视觉指示**——补 chevron 图标 | DOM/CSS |
| R6 | 右侧折叠按钮要显眼 | 由 R4 的 edge-handle 形态解决（高对比度 + hover 强化） | CSS |

---

## 2. 现状基线（Phase 1 探索结论）

### 2.1 左侧 sidebar 折叠（既有实现）

| 维度 | 位置 |
|---|---|
| 触发按钮 | [index.html L17](file:///Users/bytedance/Documents/Codex/helixent/web/public/index.html#L17) topbar `☰` |
| els 注册 | [state.js L33-34](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/state.js#L33-L34) |
| toggle 函数 | [session.js L208-217](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/session.js#L208-L217) |
| restore | [session.js L203-206](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/session.js#L203-L206) |
| Grid 切换 | [layout.css L141-152](file:///Users/bytedance/Documents/Codex/helixent/web/public/styles/layout.css#L141-L152) |
| 折叠态隐藏 panel | [layout.css L185-195](file:///Users/bytedance/Documents/Codex/helixent/web/public/styles/layout.css#L185-L195) |
| sidebar-rail | [index.html L45-49](file:///Users/bytedance/Documents/Codex/helixent/web/public/index.html#L45-L49) |

### 2.2 panel 内部折叠（既有但隐形）

- 逻辑：[session.js L35-40](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/session.js#L35-L40) `closest(".sidebar-panel")?.classList.toggle("collapsed")`
- 样式：[layout.css L250-260](file:///Users/bytedance/Documents/Codex/helixent/web/public/styles/layout.css#L250-L260) `.sidebar-panel.collapsed { max-height: 56px }` + `.panel-body { display: none }` + `.panel-heading { cursor: pointer }`
- **缺陷**：heading 内只有 `<span>Traces</span>` 和操作按钮，无 chevron，用户感知不到可折叠

### 2.3 右侧 timeline-pane（无折叠能力）

- DOM：[index.html L134-179](file:///Users/bytedance/Documents/Codex/helixent/web/public/index.html#L134-L179)
- 仅有 `<details class="run-card">` Run Metrics + `.timeline-header` + `#timeline`
- 无按钮、无 rail、无 localStorage
- 响应式：[responsive.css L37-39](file:///Users/bytedance/Documents/Codex/helixent/web/public/styles/responsive.css#L37-L39) ≤1180px 直接 `display: none`

### 2.4 测试基线

- 共 17 个 `web/__tests__/*.test.ts`，上轮 `bun run check` = **208 pass / 0 fail**
- [frontend-smoke.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-smoke.test.ts) L17-36 通过 `Bun.file(...).text()` 读 index.html，断言一组 `id="..."` 字符串。**当前不断言** `id="toggleSidebar"` 也不断言 `sidebar-toggle`，所以本次按钮位置变更对它无影响；但我们要新增 smoke 断言确保 R1-R5 落地

---

## 3. 设计决策

| # | 决策 | 取值 | 备选/理由 |
|---|---|---|---|
| D1 | topbar `☰` 按钮去留 | **移除** | 由 R2 明确要求；位置改到 sidebar 右边缘 |
| D2 | edge-handle 形态 | 14px 宽全高竖条，半透明背景，中央 6×10px CSS 三角 | 截图中点阵装饰过浮夸；CSS 三角无依赖、跨浏览器一致 |
| D3 | 触发位置 | sidebar 右外缘 / timeline 左外缘 | `position: absolute; right/left: -7px` 凸出一半，凸显边界亲和性 |
| D4 | 箭头方向规则 | 始终指向"点击后会前往的方向" | 展开态 sidebar handle = `‹`（点击会向左收回），折叠态 = `›` |
| D5 | 复合折叠允许 | ✅ 双折叠时 grid = `56px / 1fr / 56px` | R3 明确要求 |
| D6 | localStorage key | 新增 `helixent.timelineCollapsed`，保留 `helixent.sidebarCollapsed` | 独立 key 便于独立恢复 |
| D7 | panel 折叠视觉 | heading 前缀 `<span class="panel-chevron">` 用 CSS 三角；展开态 ▾，折叠态 ▸（`rotate(-90deg)`） | 与 edge-handle 同语言 |
| D8 | 响应式 | ≤1180px 同时隐藏 `#toggleTimeline`；≤920px 同时隐藏 `#toggleSidebar` | 不可见 pane 配套按钮无意义 |
| D9 | cache busting | `v=trace-lens-workbench-70 → 71` | CSS+JS 同步 |
| D10 | 是否引入 SVG 图标库 | ❌ 不引入 | 增加体积、CSS 三角已够用 |
| D11 | timeline-rail 标签 | `RM / TL / EX`（Run Metrics / Timeline / Export） | 与 `TR/SK/TL` 风格一致 |
| D12 | 折叠态下的 edge-handle | 仍可见可点击 | rail 是"显示窄占位"，handle 提供反向操作入口 |

---

## 4. 改造清单（前端文件粒度）

> **后端变更：无**。以下全部为 `web/public/*` 与 `web/__tests__/*`。

### 4.1 [`web/public/index.html`](file:///Users/bytedance/Documents/Codex/helixent/web/public/index.html)

| 操作 | 位置 | 内容 |
|---|---|---|
| 删除 | L17 | 移除 topbar 中的 `<button id="toggleSidebar" class="ghost-button icon-button sidebar-toggle">☰</button>` |
| 新增 | `<aside class="sidebar" id="sidebar">` 内首子 | `<button id="toggleSidebar" class="edge-handle edge-handle-left" type="button" aria-label="Collapse sidebar" aria-pressed="false" title="Collapse sidebar"><span class="edge-handle-icon" aria-hidden="true"></span></button>` |
| 新增 | `<aside class="timeline-pane">` 内首子 | `<button id="toggleTimeline" class="edge-handle edge-handle-right" type="button" aria-label="Collapse timeline" aria-pressed="false" title="Collapse timeline"><span class="edge-handle-icon" aria-hidden="true"></span></button>` |
| 新增 | `<aside class="timeline-pane">` 内 | `<div class="timeline-rail" aria-hidden="true"><span>RM</span><span>TL</span><span>EX</span></div>` |
| 改造 | L51, L62, L72 三处 `.panel-heading` | 把 `<span>Traces</span>` 等改为 `<span class="panel-heading-label"><span class="panel-chevron" aria-hidden="true"></span><span>Traces</span></span>`（Skills/Tools 同改） |
| 修改 | L10, L291 | `v=trace-lens-workbench-70 → 71` |

### 4.2 [`web/public/app/state.js`](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/state.js)

| 操作 | 位置 | 内容 |
|---|---|---|
| 新增 els | L34 之后 | `toggleTimeline: $("toggleTimeline"),` |
| 保留 | L33 | `toggleSidebar: $("toggleSidebar")` 不变（id 不改） |

### 4.3 [`web/public/app/session.js`](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/session.js)

| 操作 | 位置 | 内容 |
|---|---|---|
| 新增导出 | 紧随 `setSidebarCollapsed` 之后 | `toggleTimeline / setTimelineCollapsed / restoreTimelineState` 三函数（镜像 sidebar 实现） |
| 修改 `setSidebarCollapsed` | L212-217 | 增加 `els.toggleSidebar.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar")` |
| bindEvents 新增 | L34 之后 | `els.toggleTimeline.addEventListener("click", toggleTimeline);` |
| 启动恢复 | `restoreSidebarState()` 调用点 | 紧随其后 `restoreTimelineState();` |

新增函数样板：
```js
export function toggleTimeline() {
  setTimelineCollapsed(!document.body.classList.contains("timeline-collapsed"));
}
export function setTimelineCollapsed(collapsed) {
  document.body.classList.toggle("timeline-collapsed", collapsed);
  els.toggleTimeline.setAttribute("aria-pressed", String(collapsed));
  const label = collapsed ? "Expand timeline" : "Collapse timeline";
  els.toggleTimeline.setAttribute("aria-label", label);
  els.toggleTimeline.title = label;
  localStorage.setItem("helixent.timelineCollapsed", String(collapsed));
}
export function restoreTimelineState() {
  setTimelineCollapsed(localStorage.getItem("helixent.timelineCollapsed") === "true");
}
```

### 4.4 [`web/public/styles/layout.css`](file:///Users/bytedance/Documents/Codex/helixent/web/public/styles/layout.css)

| 操作 | 位置 | 内容 |
|---|---|---|
| 删除 | L37-39 `.sidebar-toggle` | 不再使用 |
| 修改 | L141-152 `.workspace` 与 `.sidebar-collapsed .workspace` | 替换为四态 grid 规则（详见 §4.4 样板） |
| 新增 | 文件末尾 | `.edge-handle / .edge-handle-icon / .timeline-rail / .panel-chevron` 等规则 |
| 新增 | `.sidebar` / `.timeline-pane` 规则 | 加 `position: relative` 容纳 absolute handle |

样板：
```css
.sidebar, .timeline-pane { position: relative; }

.workspace { grid-template-columns: 300px minmax(0, 1fr) 360px; }
.sidebar-collapsed  .workspace { grid-template-columns:  56px minmax(0, 1fr) 360px; }
.timeline-collapsed .workspace { grid-template-columns: 300px minmax(0, 1fr)  56px; }
.sidebar-collapsed.timeline-collapsed .workspace { grid-template-columns: 56px minmax(0, 1fr) 56px; }

.edge-handle {
  position: absolute; top: 0; bottom: 0; width: 14px;
  display: flex; align-items: center; justify-content: center;
  border: none; background: transparent; cursor: pointer; z-index: 5;
  color: var(--text-tertiary);
  transition: background 0.15s ease, color 0.15s ease;
}
.edge-handle:hover {
  background: linear-gradient(90deg, transparent, rgba(79,163,255,0.12), transparent);
  color: var(--accent-primary-strong);
}
.edge-handle-left  { right: -7px; }
.edge-handle-right { left:  -7px; }

.edge-handle-icon {
  width: 0; height: 0;
  border-top: 5px solid transparent;
  border-bottom: 5px solid transparent;
  transition: transform 0.2s ease;
}
.edge-handle-left  .edge-handle-icon { border-right: 6px solid currentColor; } /* ‹ */
.edge-handle-right .edge-handle-icon { border-left:  6px solid currentColor; } /* › */
.sidebar-collapsed  .edge-handle-left  .edge-handle-icon { transform: rotate(180deg); }
.timeline-collapsed .edge-handle-right .edge-handle-icon { transform: rotate(180deg); }

.timeline-rail {
  display: none; align-items: center; justify-content: center; gap: 18px;
  writing-mode: vertical-rl; padding: 18px 0;
  color: var(--text-secondary); font-size: 11px; letter-spacing: 0.08em;
}
.timeline-collapsed .timeline-pane > :not(.edge-handle):not(.timeline-rail) { display: none; }
.timeline-collapsed .timeline-rail { display: flex; }

.panel-heading-label { display: inline-flex; align-items: center; gap: 8px; }
.panel-chevron {
  display: inline-block; width: 0; height: 0;
  border-left: 5px solid transparent;
  border-right: 5px solid transparent;
  border-top: 6px solid currentColor;
  transition: transform 0.2s ease;
  opacity: 0.6;
}
.sidebar-panel.collapsed .panel-chevron { transform: rotate(-90deg); }
```

### 4.5 [`web/public/styles/responsive.css`](file:///Users/bytedance/Documents/Codex/helixent/web/public/styles/responsive.css)

| 断点 | 现有规则 | 新增 |
|---|---|---|
| ≤1320px | `300/1fr/320` | 加三条 `.sidebar-collapsed`、`.timeline-collapsed`、双折叠的 grid 覆盖 |
| ≤1180px | `.timeline-pane { display: none }` | 加 `#toggleTimeline { display: none }` |
| ≤920px | `.sidebar { display: none }` | 加 `#toggleSidebar { display: none }` |

---

## 5. 测试方案

> 测试运行器：[Bun test](https://bun.sh/docs/cli/test)（`bun test`）；DOM 注入沿用 [frontend-clipboard.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-clipboard.test.ts) 已建立的 `installDom()` 模式。

### 5.1 既有测试影响评估

| 文件 | 是否受影响 | 说明 |
|---|---|---|
| [frontend-smoke.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-smoke.test.ts) | **是** | 第一个测试逐字符断言 index.html。当前断言里没有 `toggleSidebar`/`☰`，所以**移除按钮**本身不会让它挂；但我们**主动**新增断言以验证新结构 |
| 其余 16 个 | 否 | 不读 HTML 也不读折叠相关代码 |

### 5.2 新增测试（合计 1 个新文件 + 1 处既有文件追加断言）

#### T1 · 在 `frontend-smoke.test.ts` 既有 `page shell` 测试中追加断言

新增字符串断言（通过则证明 R1/R2/R4/R5 的 DOM 改造落地）：
```ts
// edge-handle DOM 已注入（R1 R2 R4）
expect(html).toContain('id="toggleSidebar"');
expect(html).toContain('id="toggleTimeline"');
expect(html).toContain('class="edge-handle edge-handle-left"');
expect(html).toContain('class="edge-handle edge-handle-right"');
// timeline-rail 存在（R1）
expect(html).toContain('class="timeline-rail"');
// topbar 不再有旧的 sidebar-toggle 类（R2）
expect(html).not.toContain('class="ghost-button icon-button sidebar-toggle"');
// panel-heading 含 chevron（R5）
expect(html).toContain('class="panel-chevron"');
// cache busting（D9）
expect(html).toContain("v=trace-lens-workbench-71");
expect(html).not.toContain("v=trace-lens-workbench-70");
```

#### T2 · 新增 `web/__tests__/frontend-collapse.test.ts`（4 个用例，覆盖运行时行为）

通过 `installDom()` 注入最小 DOM（document/window/navigator + `localStorage` 的简化 stub），动态导入 `session.js`，验证：

| 用例 | 断言 |
|---|---|
| C1 默认状态 | 调用 `restoreSidebarState()` + `restoreTimelineState()` 后，`document.body.classList` 不含 `sidebar-collapsed` 也不含 `timeline-collapsed`（R3 默认全展开） |
| C2 sidebar 折叠 | 调用 `toggleSidebar()` → `body.classList.contains("sidebar-collapsed") === true` 且 `localStorage.getItem("helixent.sidebarCollapsed") === "true"` 且 `els.toggleSidebar.getAttribute("aria-pressed") === "true"` |
| C3 timeline 折叠（R1） | 同上验 timeline 路径，key=`helixent.timelineCollapsed` |
| C4 双折叠正交（R3） | 顺序调用两次 toggle，两个 class 同时存在；再各 toggle 一次回到默认 |

> DOM stub 关键：`localStorage` 必须实现 `getItem/setItem`，因为 [session.js L204](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/session.js#L204) 直接访问。可在测试中注入轻量 Map-backed stub。

### 5.3 不写测试的部分

- 纯 CSS 折叠（visual-only）—— 走人工目视
- responsive.css 断点 —— 走人工目视
- 持久化恢复跨刷新 —— 集成测试性质，单测覆盖 localStorage 读写已足

### 5.4 手测 checklist

| # | 操作 | 期望 |
|---|---|---|
| H1 | 默认进入 | sidebar 右边缘有竖条 + `‹`；timeline 左边缘有竖条 + `›` |
| H2 | 点 sidebar handle | sidebar 收为 56px，rail 显 TR/SK/TL；箭头变 `›` |
| H3 | 再点 sidebar handle | 还原 |
| H4 | 点 timeline handle | timeline 收为 56px，rail 显 RM/TL/EX；箭头变 `‹` |
| H5 | 同时折两侧 | 中间工作区 1fr 撑满；两个 handle 都还可点 |
| H6 | 刷新页面 | 折叠状态各自恢复 |
| H7 | hover 任一 handle | 背景渐变高亮 + 箭头变蓝 |
| H8 | 点 Traces panel-heading | chevron 由 ▾ 旋转为 ▸；panel-body 隐藏 |
| H9 | Skills、Tools 同 H8 | 同 |
| H10 | 视口缩到 1100px | 右 handle 不可见（pane 也不可见） |
| H11 | 视口缩到 880px | 左 handle 也不可见 |
| H12 | 键盘 Tab | 两个 edge-handle 可聚焦；Enter/Space 切换 |

---

## 6. 验收标准

| # | 关联诉求 | 标准 |
|---|---|---|
| A1 | R1 | timeline-pane 可独立折叠为 56px；恢复持久化；rail 显示 RM/TL/EX |
| A2 | R2 | topbar 不再有 `☰`；折叠按钮位于 sidebar 右边缘 |
| A3 | R3 | sidebar/timeline 可独立或同时折叠；4 种状态 grid 比例正确 |
| A4 | R4 | edge-handle 形态：竖条 14px + 中央 CSS 三角；hover 高亮；箭头方向语义正确 |
| A5 | R5 | Traces/Skills/Tools heading 显示 chevron；状态翻转 |
| A6 | R6 | edge-handle 比 topbar 大按钮更显眼（hover/默认对比度足够） |
| A7 | 质量门 | `bun run check` ≥ **210 pass / 0 fail**（既有 208 + 新增 ≥2 用例：T1 追加 + T2 至少 4 但 T1 不算独立 test，conservatively +4 from C1-C4） |
| A8 | 兼容 | Chrome/Edge/Firefox/Safari 当前 LTS；移动响应式不破 |

> 数字修正：T1 是在已有 test 上追加 expect，不增加 test 计数；T2 新文件 4 个 `test(...)`，所以最终预期 `212 pass / 0 fail`。

---

## 7. 风险与回滚

| 风险 | 概率 | 缓解 |
|---|---|---|
| `position: absolute` 的 handle 与 sidebar 内 `overflow-y: auto` 冲突，被裁切 | 中 | sidebar 已是 `overflow-y: auto, overflow-x: hidden`；handle 用 `right: -7px` 凸出 sidebar 外，需测试是否被父级 `.workspace { overflow: hidden }` 裁切。**预案**：若被裁，改为 `right: 0`（贴在内壁，损失视觉对称但功能 OK） |
| edge-handle 与 panel 内既有控件（如 `Refresh` 按钮）热区重叠 | 低 | handle 在 pane 边缘外侧 7px，panel 控件在内侧 16-20px padding 内，无重叠 |
| 移除旧 `☰` 后 frontend-smoke 既有断言挂 | 低 | 已确认现有 smoke 不断言该按钮 |
| localStorage 在隐私模式 throw | 低 | session.js 既有 sidebar 实现就已直接访问 localStorage，没有 try/catch；本次保持同等风险等级，不引入新隐患 |
| 移动端窄屏出现按钮但 pane 已 `display: none` | 低 | 在 responsive.css 显式 `#toggleTimeline { display: none }` |

回滚：纯前端改动，git revert 一个提交即恢复。

---

## 8. 实施顺序

| 步骤 | 内容 | 文件 |
|---|---|---|
| S1 | DOM 改造（移除 topbar 按钮、新增 edge-handle、timeline-rail、panel chevron span、cache=71） | index.html |
| S2 | state.js 注册 `toggleTimeline` | state.js |
| S3 | session.js 新增 timeline 三函数 + bindEvents + restoreTimelineState 调用 + 同步 sidebar aria-label | session.js |
| S4 | layout.css 加 edge-handle/grid/rail/chevron 规则；删除 `.sidebar-toggle` | layout.css |
| S5 | responsive.css 三断点协调 | responsive.css |
| S6 | 在 frontend-smoke 追加 §5.2 T1 断言 | frontend-smoke.test.ts |
| S7 | 新建 frontend-collapse.test.ts（C1-C4） | frontend-collapse.test.ts |
| S8 | 跑 `bun run check`，期待 212 pass / 0 fail | — |
| S9 | 手测 §5.4 H1-H12 | 浏览器 |

---

## 9. 不在范围

- 不引入 SVG/Iconfont
- 不动 `.timeline-pane` 内部子组件（Run Metrics、filter pills、export-row）
- 不改 ≤1180px 隐藏 timeline-pane 的策略
- 不让 `timeline-rail` 文字可点击展开（保持与 sidebar-rail 一致：纯指示）
- 不重构 `.sidebar-panel.collapsed` 既有逻辑

---

## 10. Changelog（实施后填写）

> 待实施完毕后补 commit hash + `bun run check` 输出。
