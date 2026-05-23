# Web 图片输入接入 — 技术开发文档

> 文档类型：技术开发文档（Technical Spec）
> 范围：Web Prompt Playground 多模态图片输入
> 状态：Plan 模式产出，待 user approve 后进入 EXECUTION

***

## 1. 功能点（Feature List）

| ID  | 功能                                                                                      | 验收标准                                                                                                                |
| --- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| F1  | composer 增加「+ Image」按钮，弹出系统文件选择器（多选）                                                    | 选中后 ≤ **4** 张图片以**小尺寸缩略图卡片**形式出现在 textarea 上方，每张可单独删除                                                               |
| F2  | composer 支持把图片拖拽到对话框区域                                                                  | dragover 时 composer 视觉高亮；drop 后图片以缩略图加入待发列表                                                                         |
| F3  | textarea 支持截图直接 `Ctrl/Cmd+V` 粘贴                                                         | 粘贴板含 image/\* file 项目时自动加入待发列表，粘贴其他文本不受影响                                                                           |
| F4  | 单张图片大小 ≤ **5 MB**（编码前原始字节，与 Anthropic API 硬限对齐），超限前端弹错并跳过                               | 错误提示走现有 `showError` 通道；不上传、不入待发列表                                                                                   |
| F5  | 仅接受 `image/png` `image/jpeg` `image/webp` `image/gif` 四种 mime（OpenAI ∩ Anthropic 共同支持集） | 其它扩展名/mime 在前端被拒；服务端二次校验同样规则                                                                                        |
| F6  | 单条消息附带图片 + 文本同时发送，文本可空（仅发图）                                                             | 文本与图片至少一项非空才允许发送；都空则保持现有 return 行为                                                                                  |
| F7  | 用户气泡显示已发送的图片缩略图 + 文本                                                                    | 缩略图显示在文本上方；点击气泡仍可打开 Inspect 弹窗                                                                                      |
| F8  | Inspect 弹窗显示**缩略图列表**，缩略图也可点开大图                                                         | 弹窗顶部按顺序渲染缩略图行，下方为文本；不再直接铺原图，避免大 base64 撑爆弹窗                                                                         |
| F9  | 历史 session 恢复（刷新页面）能正确还原图片消息                                                            | 后端 `SessionSnapshot.messages` 含 image\_url，前端原样渲染                                                                   |
| F10 | OpenAI 与 Anthropic 两类 provider 均能成功接收带图请求                                               | OpenAI 直通 base64 data URL；Anthropic 自动转换为 `source.type = "base64"` 格式                                               |
| F11 | 全局**大图预览模式（Lightbox）**                                                                  | 任何缩略图（composer 待发区 / 用户气泡 / Inspect 弹窗 / Timeline 详情）点击后打开同一个全屏 lightbox：暗黑遮罩 + 居中显示原图 + 关闭按钮 + ESC 关闭 + ←/→ 切换同组多图 |
| F12 | Agent Output 行结构对图片消息的视觉适配                                                              | 用户行（Run summary）的 title 同时反映文本摘要 +「📎 N images」chip；user 节点的 detail 区渲染缩略图行                                         |
| F13 | Hook & Timeline 的 `input_context` 含图时显示图片占位 chip + 详情缩略图                                | timeline 节点不再把整段 base64 倒进 `<pre>` JSON；序列化前用 `[image n bytes]` 占位串替换 dataUrl，详情 body 末尾追加缩略图行                      |

***

## 2. 设计决策（一次性锁定）

| #   | 决策                                                                                                                                                                                                                                                                                         | 备注                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| D1  | 图片来源：仅本地文件（File picker / 拖拽 / 粘贴）                                                                                                                                                                                                                                                          | 不做远程 URL 输入框                               |
| D2  | 编码策略：base64 data URL 内联进 `UserMessage.content`                                                                                                                                                                                                                                             | 不落盘、不上传、无独立 endpoint                       |
| D3  | **单张 ≤ 5 MB（编码前），单条消息 ≤ 4 张**。依据：Anthropic 官方 Vision 文档明文给出**整请求 ≤ 32 MB（标准 endpoint）**；base64 编码膨胀 \~1.34 倍 → 整请求 32 MB ÷ 1.34 ÷ 4 张 ≈ 5.97 MB / 张，保守取 5 MB / 张并留余量给 text + system + tools schema。**注意：「单图 5 MB」不是官方 Vision 文档明文条目，而是我们由 32 MB 整请求上限反推的方案侧阈值** | 控制 trace jsonl 体积 + 不爆 32 MB 请求体           |
| D4  | 不做图片压缩 / 缩放 / 格式转换                                                                                                                                                                                                                                                                         | 用户自控；后续可选 follow-up                        |
| D5  | 不改 SSE 事件类型 / TraceKind / PromptSnapshot 协议                                                                                                                                                                                                                                                | 协议层零变更                                     |
| D6  | 长期数据管理（落盘 + 静态服务 URL / Anthropic Files API `source.type=file`） 作为 follow-up                                                                                                                                                                                                                | 当前接口形状已向前兼容                                |
| D7  | 引入统一**图片视图模型** `ImageViewModel = { url, mimeType?, name?, size?, source: "user" \| "input_context" \| "trace" \| "tool_input" \| "tool_result", messageIndex?, traceEventId? }`，所有缩略图渲染、lightbox、timeline 占位串替换都走同一份提取函数 `extractImagesFromMessage(msg)` / `extractImagesFromEvent(event)` | 单一数据源，避免散落 if 判断                           |
| D8  | 引入唯一全局组件 `imageLightbox`（DOM `<dialog id="imageLightbox">`），所有点击放大入口共用                                                                                                                                                                                                                     | 跨 composer / 气泡 / Inspect / Timeline，零重复实现 |
| D9  | Trace / SSE 协议层不动；前端在**渲染前**对 `event.data.messages[].content[].image_url.url` 做「保留前 80 字符 + `...[base64 N MB]`」的 *display-only* 摘要替换                                                                                                                                                       | 不丢真实数据（仍存于 trace），UI 不卡                    |
| D10 | **Multi-turn 性能警告**：base64 在每次 history 重发时整体打包，会随轮次膨胀；当用户在同一 session 累计图片超过 N 张（建议 ≥ 8）时前端给一条软提示，引导后续清理 history（或等 D6 落地后改走 `source.type=file`）                                                                                                                                            | 与 Anthropic 官方推荐对齐                         |
| D11 | **图片排在文本前**（image-then-text 顺序）：Anthropic 官方 Vision 文档 Tip 明确「Claude works best when images come before text」。`buildUserMessageContent(text, images)` 输出顺序为 `[image, image, ..., text]`；前端 user 气泡缩略图也渲染在文本上方（已与 F7 一致）                                                                       | 提升模型对图片的关注度，零成本                            |

***

## 3. 后端改动范围（Backend）

### 3.1 改动文件

#### 3.1.1 [src/community/anthropic/utils.ts](file:///Users/bytedance/Documents/Codex/helixent/src/community/anthropic/utils.ts#L46-L56)

**问题**：当前实现把 `ImageURLContent.image_url.url` 直接塞进 Anthropic `source.type = "url"`。当 url 是 `data:image/...;base64,...` 时，Anthropic API 会以 `invalid_request_error: image source url must be http or https` 拒绝（详见附录 A 引用）。

**Anthropic 官方约束（来自** **[docs.claude.com/en/docs/build-with-claude/vision](https://docs.claude.com/en/docs/build-with-claude/vision)，详见 §A 附录）**：

* `source.type` 三种取值：`base64` / `url` / `file`（Files API beta，header `anthropic-beta: files-api-2025-04-14`）

* `source.type=base64` 必须搭配 `media_type` ∈ {`image/jpeg`, `image/png`, `image/gif`, `image/webp`}，且 `data` 是**纯 base64 字符串，不含** **`data:...,`** **前缀**

* `source.type=url` 必须是 http/https 公网可访问 URL（Amazon Bedrock / Vertex AI 仅支持 base64）

* **整请求大小 ≤ 32 MB（标准 endpoint）**；本方案据此反推 **单图 ≤ 5 MB / 单条 ≤ 4 张**（D3）

* 单请求图片数 ≤ 100（200k 上下文模型）/ 600（其它）

* 长边 ≤ 8000 px（>20 张图时降到 2000 px）

* GIF 仅第一帧被使用；动画不支持

* Multi-turn 含图建议改走 Files API 以避免 base64 history 累积（D10）

* Best practice: image-before-text（D11）

**改动**：

* 新增内部函数 `parseImageDataUrl(url: string): { mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string } | null`，正则严格匹配 `^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$`。

* `convertToAnthropicMessages` 中 `part.type === "image_url"` 分支改造：

  * data URL 命中 → `{ type: "image", source: { type: "base64", media_type, data } }`

  * 其它 → 保留原有 `{ type: "image", source: { type: "url", url } }` 通道（向后兼容公网 https URL）

**不引入新依赖、不改对外导出符号、不改函数签名。**

#### 3.1.2 [web/types.ts](file:///Users/bytedance/Documents/Codex/helixent/web/types.ts#L106-L109)

新增 `WebImageInput` 与扩展 `SubmitMessageBody`：

```ts
export interface WebImageInput {
  name?: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  dataUrl: string;          // 完整 data URL：data:<mimeType>;base64,<b64>
  size?: number;            // 编码前原始字节数，用于服务端校验
  detail?: "auto" | "high" | "low";
}

export interface SubmitMessageBody {
  text: string;
  requestedSkillName?: string | null;
  images?: WebImageInput[];   // 新增，可选，向后兼容
}
```

#### 3.1.3 [web/server.ts](file:///Users/bytedance/Documents/Codex/helixent/web/server.ts#L391-L429)

**改动 1**：抽出纯函数 `buildUserMessageContent(text: string, images?: WebImageInput[]): UserMessageContent`，便于单测。

**改动 2**：`submitMessage` 中：

* 在内置命令 `/clear` `/help` `/exit` 分支前完成 images 校验：

  * 数组长度 ≤ **4**（D3），违反 → `HttpError(400, "Too many images (max 4)")`

  * mime 在白名单（D5/F5）

  * `dataUrl` 必须以 `data:<mimeType>;base64,` 开头

  * `size`（若提供）≤ **5 MB**（方案侧阈值，由 32 MB 整请求反推）；服务端按 `dataUrl.length * 0.75` 二次估算原始体积上限 ≤ 5 MB

  * 整请求 base64 总和 ≤ **28 MB**（保守阈值，对齐 Anthropic 官方明文 32 MB 整请求上限，留 4 MB 余量给 text + system + tools schema）

* 内置命令分支保持纯文本，images 在命令场景被忽略

* 普通分支用 `buildUserMessageContent(text, body.images)` 替代硬编码 `[{ type: "text", text }]`；**输出顺序为 image 优先（D11）**：`[image, image, ..., text]`

* F6：当 `text` 为空但 `images.length > 0` 时允许发送（修改第 392-394 行的 `if (!text)` 校验为 `if (!text && !(body.images?.length))`）

#### 3.1.4 不动的后端代码

| 文件                                                                                                                                                              | 不动原因                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [src/foundation/messages/types/content.ts](file:///Users/bytedance/Documents/Codex/helixent/src/foundation/messages/types/content.ts#L14-L72)                   | `ImageURLContent` / `UserMessageContent` 已就绪                                                                |
| [src/foundation/messages/types/message.ts](file:///Users/bytedance/Documents/Codex/helixent/src/foundation/messages/types/message.ts#L20-L27)                   | `UserMessage.content` 已支持图片段                                                                                |
| [src/community/openai/utils.ts](file:///Users/bytedance/Documents/Codex/helixent/src/community/openai/utils.ts#L19-L20)                                         | OpenAI Chat Completions API 直接接受 `{ type: "image_url", image_url: { url } }` 含 data URL；user 分支整体 push，0 改造 |
| [src/community/openai/model-provider.ts](file:///Users/bytedance/Documents/Codex/helixent/src/community/openai/model-provider.ts)                               | 仅转发，无需改动                                                                                                    |
| [src/community/anthropic/model-provider.ts](file:///Users/bytedance/Documents/Codex/helixent/src/community/anthropic/model-provider.ts)                         | 仅转发，无需改动                                                                                                    |
| [src/agent/agent.ts](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent.ts)                                                                       | UserMessage 传递透明                                                                                            |
| [src/agent/agent-middleware.ts](file:///Users/bytedance/Documents/Codex/helixent/src/agent/agent-middleware.ts)                                                 | middleware 不依赖 content 形态                                                                                   |
| [web/trace.ts](file:///Users/bytedance/Documents/Codex/helixent/web/trace.ts)                                                                                   | jsonl 写盘 `JSON.stringify(message)` 自动覆盖 image\_url                                                          |
| [web/prompt-versions.ts](file:///Users/bytedance/Documents/Codex/helixent/web/prompt-versions.ts)                                                               | snapshot.messages 已是 `NonSystemMessage[]`，可直接保存含图消息                                                         |
| [web/skills.ts](file:///Users/bytedance/Documents/Codex/helixent/web/skills.ts) / [web/tools.ts](file:///Users/bytedance/Documents/Codex/helixent/web/tools.ts) | 与图片输入正交                                                                                                     |
| CLI（`src/cli/**`）                                                                                                                                               | 本次 TUI composer 不接附件 UI                                                                                     |

***

## 4. 前端改动范围（Frontend）

### 4.1 新增文件

#### 4.1.1 `web/public/view/images.js`（新增）

集中放图片相关纯渲染 / 视图模型工具，避免散落多文件：

```js
export function extractImagesFromMessage(message) { /* 扫 content[]，返回 ImageViewModel[] */ }
export function extractImagesFromEvent(event)     { /* input_context / model_output_block 也支持 */ }
export function renderThumbnailStrip(images, { size = 64, group = "default" } = {}) { /* 通用缩略图行 */ }
export function summarizeMessageWithImages(message) { /* 给 Run title 用：返回 { text, imageCount } */ }
export function sanitizeImagesForDebugDump(value)  { /* 深拷贝并把 image_url.url 的 data URL 替换成 [image N MB] 摘要，供 timeline <pre> 用 */ }
```

`renderThumbnailStrip` 渲染 `<button class="image-thumb" data-image-group="<group>" data-image-index="<i>" data-image-url="<url>">…</button>`，由全局 lightbox 统一委托捕获。

#### 4.1.2 `web/public/view/image-lightbox.js`（新增）

单实例全屏组件：

* 暴露 `openLightbox({ images, startIndex })` / `closeLightbox()`。

* 监听全局 `click` 委托：捕获 `[data-image-url]`，按 `data-image-group` 聚合一组、`data-image-index` 定位起点。

* 支持 ESC 关闭、`←/→` 切换、点击遮罩关闭、显示「i / N」编号 + 文件名。

* 不预加载非当前图（懒解码），切换时再喂新 `<img src>`。

#### 4.1.3 `web/public/styles/image-lightbox.css`（新增）

样式：`<dialog>` 全屏 + 半透明背景 + 居中 `<img>`（max-width 90vw / max-height 90vh）+ 关闭按钮 + 左右切换按钮。

### 4.2 改动文件

#### 4.2.1 [web/public/index.html](file:///Users/bytedance/Documents/Codex/helixent/web/public/index.html#L122-L127)

* composer 内 textarea 上方插入 `<div id="composerAttachments" class="composer-attachments" hidden></div>`。

* composer 末尾增加附件按钮：

  ```html
  <input id="composerImageInput" type="file"
         accept="image/png,image/jpeg,image/webp,image/gif"
         multiple hidden>
  <label class="secondary-button" for="composerImageInput">+ Image</label>
  ```

* `<body>` 末尾插入 lightbox dialog 模板：

  ```html
  <dialog id="imageLightbox" class="image-lightbox">
    <button class="image-lightbox-close" type="button" aria-label="Close">×</button>
    <button class="image-lightbox-prev" type="button" aria-label="Previous">‹</button>
    <img class="image-lightbox-img" alt="">
    <button class="image-lightbox-next" type="button" aria-label="Next">›</button>
    <div class="image-lightbox-meta"></div>
  </dialog>
  ```

* 新增 `<link rel="stylesheet" href="styles/image-lightbox.css?v=trace-lens-workbench-63">`。

* 新增 `<script type="module" src="view/image-lightbox.js?v=trace-lens-workbench-63"></script>`。

* bump 全部静态资源 cache version：`?v=trace-lens-workbench-62 → 63`。

#### 4.2.2 [web/public/app/state.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/state.js)

* `state.pendingImages: WebImageInput[] = []`。

* `els.composerAttachments` / `els.composerImageInput` / `els.imageLightbox` 缓存。

#### 4.2.3 [web/public/app/session.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/session.js#L203-L218)

* `bindEvents()` 增加：

  * `els.composerImageInput.change` → `handleImagePick(event)`

  * `els.composer` 的 `dragover`（preventDefault + class `dragging`）/ `dragleave` / `drop`

  * `els.promptInput` 的 `paste` → 拦截 `clipboardData.items` 中 `kind === "file"` 且 mime 命中白名单

  * 委托 `click` 处理 `.composer-attachment-card` 上的图片本身（打开 lightbox）/ 删除按钮（移除待发）

* 新增 `addPendingImages(files)`：mime + size 校验 → `FileReader.readAsDataURL` → push `state.pendingImages` → `renderComposerAttachments()`

* 新增 `removePendingImage(index)` + `renderComposerAttachments()`（小尺寸 64×64 卡片 + 文件名 hover tooltip + 删除按钮）。**待发缩略图也带** **`data-image-url`** **/** **`data-image-group="composer"`，点图（非删除按钮）即触发 lightbox**。

* `submitPrompt(event)` 改造：

  * 文本与图片至少一项非空（F6）才允许发送

  * body 改为 `{ text, images: state.pendingImages }`

  * 成功后清空 `state.pendingImages` 与 input 文件列表

#### 4.2.4 [web/public/view/output-cards.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/output-cards.js#L62-L94)

* `renderMessageOutputCard` 中 `role === "user"` 普通分支：调用 `extractImagesFromMessage(message)` 拿到 `ImageViewModel[]` + 拆出 text 部分，传给 `renderUserQueryBubble`。

* 扩展 `renderUserQueryBubble({ index, text = "", images = [] })`：

  ```js
  const stripHtml = images.length
    ? renderThumbnailStrip(images, { size: 96, group: `bubble-${index}` })
    : "";
  return `<div class="user-query-bubble" role="button" tabindex="0" data-message-index="${index}">
    ${stripHtml ? `<div class="user-query-bubble-images">${stripHtml}</div>` : ""}
    ${text ? `<div class="user-query-bubble-text">${escapeHtml(text)}</div>` : ""}
  </div>`;
  ```

* AGENTS.md 项目上下文分支保持不动（仅文本）。

#### 4.2.5 [web/public/app/output.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/output.js#L8-L15)

`openMessageDialog(index)` 改造：

* 调 `extractImagesFromMessage(message)`，若非空，先在 `els.messageDialogBody` 顶部插入 `renderThumbnailStrip(images, { size: 120, group: "dialog" })`（**不直接放原图**，避免大 base64 同时 decode）。

* 文本部分继续用 `contentToText`，但跳过 `image_url` 段（防止又输出 `[image] data:...` 长串，已统一交给缩略图条体现）。

* 缩略图自然走全局 lightbox 委托打开大图。

#### 4.2.6 [web/public/view/agent-output-graph.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/agent-output-graph.js)

**Run 节点**（builder 段）：

* 在构造 `currentRun` 时，把 `extractImagesFromMessage(message)` 结果存进 `currentRun.images`，并改 `title`：

  ```js
  const summary = summarizeMessageWithImages(message);
  // summary.text 用于 Run title；summary.imageCount 用于 chip
  ```

* 新增 `currentRun.imageCount` 字段。

**Run summary 渲染**（`renderAgentRunNode`）：

* title 仍是文本摘要，meta 区在 `imageCount > 0` 时插入额外 chip：`<span class="agent-chip" data-tone="prompt">📎 {n}</span>`（沿用现有 chip tone 字典，不新增 tone）。

* detail 区（user item，`renderAgentOutputItem` 命中 `type === "user"` 的分支若有；否则 user 不展开）保持现状；本次重点是 summary 行的 chip + 缩略图条放在 user item 详情。

* 在 user item 的 body 渲染时（`agentOutputItemConfig` user 分支或新增分支），detail body 末尾追加 `renderThumbnailStrip(item.images, { size: 80, group: \`run-${run.index}-user\` })\`。

**Tool 节点**：

* `renderToolSection` 在序列化 `<pre>` 之前用 `sanitizeImagesForDebugDump(value)` 包一层（D9），避免 tool input/result 万一含 base64 导致页面卡（防御性）。

* 同时在 detail body 末尾，若 `extractImagesFromValue(value)` 非空，追加 `renderThumbnailStrip(images, { size: 64, group: \`tool-${toolUseId}\` })\`。

#### 4.2.7 [web/public/view/timeline.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/timeline.js)

* `createTimelineEventNode(event)`：构造 node 前，对 event 的 `data` 做一次浅拷贝并经 `sanitizeImagesForDebugDump` 处理后再传入子节点（保留原 event 引用给数据层；只替换 *display* 用副本）。

* `timelineEventSubtitle(event)` 里给 `input_context` 增加分支：若 `extractImagesFromEvent(event).length > 0`，subtitle 追加「· 📎 N images」。

* `renderTimelineItem`（在 `timeline-legacy.js`）：在 `<pre>` 后追加 `renderThumbnailStrip(images, { size: 56, group: \`timeline-${event.id}\` })`（仅当 ` extractImagesFromEvent(event).length > 0\` 时输出）。

* `timelineBadge(event)` 给 `input_context` 增加 badge：含图时返回 `${imageCount} img`。

#### 4.2.8 [web/public/view/timeline-legacy.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/timeline-legacy.js#L37-L54)

* `renderTimelineItem(event)` 中 `<pre>${escapeHtml(JSON.stringify(event.data || {}, null, 2))}</pre>` 之前调一次 `sanitizeImagesForDebugDump(event.data)` 替换 dataUrl，再 stringify（D9）。

* 末尾按 §4.2.7 追加缩略图条。

#### 4.2.9 [web/public/styles/composer.css](file:///Users/bytedance/Documents/Codex/helixent/web/public/styles/composer.css)

新增样式：

* `.composer-attachments`（flex wrap，gap 8px）

* `.composer-attachment-card`（64×64，圆角，相对定位，cursor pointer）

* `.composer-attachment-card img`（cover）

* `.composer-attachment-card button.remove`（右上角删除按钮）

* `.composer.dragging`（虚线高亮）

#### 4.2.10 [web/public/styles/agent-output-graph.css](file:///Users/bytedance/Documents/Codex/helixent/web/public/styles/agent-output-graph.css)

末尾追加：

* `.user-query-bubble-images`（flex wrap，gap 6px，margin-bottom 6px）

* `.image-thumb-strip`（flex wrap，gap 6px）

* `.image-thumb`（按钮：border 0，padding 0，cursor zoom-in）

* `.image-thumb img`（border-radius 6px，object-fit cover，**根据传入的 size CSS var 控制宽高**）

* 注意：`.image-thumb` 在 timeline / inspect / agent-output 三处共用，避免重复定义。

#### 4.2.11 [web/public/view/utils.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/utils.js#L8-L15)

`contentToText(content)` 中 `image_url` 分支调整：返回简短 `[image]`（去掉 url 部分）；调用方若需要原 url 走 `extractImagesFromMessage`。

> **影响面**：[utils.js#L13](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/utils.js#L13) 现行测试 [frontend-view.test.ts#L745](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-view.test.ts#L745) 断言含 url，需同步更新（见 §5.2）。

### 4.3 不动的前端代码

| 文件                                                                                                                    | 不动原因                                                 |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| [web/public/view/messages.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/messages.js)           | 列表用 preview 文本即可（`contentToText` 已退化为 `[image]`）     |
| [web/public/view/sent-prompt.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/sent-prompt.js)     | sent-prompt dialog 走 prompt 文本                       |
| [web/public/view/skills-tools.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/skills-tools.js)   | 与图片输入正交                                              |
| [web/public/app/api.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/api.js)                       | 已支持任意 JSON body                                      |
| [web/public/app/prompt.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/prompt.js)                 | prompt-version 编辑器走 messages JSON 文本，可直接含 image\_url |
| [web/public/app/traces.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/app/traces.js)                 | trace 文件复用同一渲染链路，自动支持                                |
| [web/public/view/metrics-tasks.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/view/metrics-tasks.js) | 与图片正交                                                |
| [web/public/export.js](file:///Users/bytedance/Documents/Codex/helixent/web/public/export.js)                         | 导出走 markdown，沿用 `[image]` 占位                         |

***

## 5. 测试文件（Tests）

### 5.1 新增

#### 5.1.1 `src/community/anthropic/__tests__/utils.test.ts`

| Case | 输入                                                     | 期望                                                                                                       |
| ---- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| T1   | user 消息含 `image_url`，url 为 `https://example.com/a.png` | 输出含 `{ type: "image", source: { type: "url", url } }`                                                    |
| T2   | url 为 `data:image/png;base64,iVBORw0KGgo...`           | 输出 `{ source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo..." } }`（data 不含 `data:` 前缀） |
| T3   | url 为 `data:image/webp;base64,UklGR...`                | `media_type === "image/webp"`                                                                            |
| T4   | url 为 `data:image/jpeg;base64,/9j/4A...`               | `media_type === "image/jpeg"`                                                                            |
| T5   | url 为 `data:application/pdf;base64,JVBER...`           | 走 url 通道（保持向后兼容）                                                                                         |
| T6   | 多个 image\_url 段混合（一张 https + 一张 data URL）              | 各自落到正确的 source 通道，顺序保留                                                                                   |
| T7   | text + image\_url + text 混合                            | 输出顺序保留                                                                                                   |

#### 5.1.2 `web/__tests__/server-images.test.ts`（新增）

针对从 `web/server.ts` 抽出的纯函数 `buildUserMessageContent`：

| Case | 输入                           | 期望                             |
| ---- | ---------------------------- | ------------------------------ |
| S1   | text + 0 张图片                 | 单段 `text`                      |
| S2   | text + 2 张 data URL 图片       | 输出 `[image, image, text]` 共 3 段（**D11 image-before-text 顺序**） |
| S3   | 空 text + 1 张图片               | 仅 1 段 image\_url               |
| S4   | images 含 detail 字段           | 透传到 `image_url.detail`         |
| S5   | images 长度 > 4                | 抛 `HttpError(400)`             |
| S6   | mime 不在白名单                   | 抛 `HttpError(400)`             |
| S7   | dataUrl 头与 mimeType 不匹配      | 抛 `HttpError(400)`             |
| S8   | 单张 size > 5 MB               | 抛 `HttpError(400)`             |
| S9   | images 总 base64 size > 28 MB | 抛 `HttpError(400)`             |

#### 5.1.3 `web/__tests__/frontend-images.test.ts`（新增）

针对 `web/public/view/images.js` 纯函数：

| Case | 函数                           | 输入                                                              | 期望                                                                          |
| ---- | ---------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| I1   | `extractImagesFromMessage`   | user message 含 1 text + 2 image\_url                            | 返回 2 个 ImageViewModel，`source: "user"`                                      |
| I2   | `extractImagesFromMessage`   | assistant message（无图）                                           | 返回 `[]`                                                                     |
| I3   | `extractImagesFromEvent`     | `kind: "input_context", data.messages[].content[]` 含 image\_url | 返回带 `source: "input_context"` 的 ImageViewModel                              |
| I4   | `summarizeMessageWithImages` | text "hi" + 3 image                                             | `{ text: "hi", imageCount: 3 }`                                             |
| I5   | `summarizeMessageWithImages` | 空 text + 2 image                                                | `{ text: "", imageCount: 2 }`，调用方应将 title 显示为 `2 images`                    |
| I6   | `sanitizeImagesForDebugDump` | 嵌套对象含 `image_url.url = "data:image/png;base64,AAA...4KB..."`    | 返回深拷贝，对应 url 被替换为 `[image image/png 3 B]`（保留 mimeType + 原始 byte 估算）         |
| I7   | `sanitizeImagesForDebugDump` | url 是 `https://...`                                             | 不替换（保留原值）                                                                   |
| I8   | `renderThumbnailStrip`       | 2 张图 + group "g"                                                | 输出 2 个 `<button class="image-thumb" data-image-group="g" data-image-index>` |

#### 5.1.4 `web/__tests__/frontend-image-lightbox.test.ts`（新增）

针对 `view/image-lightbox.js`：

| Case | 输入                                            | 期望                                                                    |
| ---- | --------------------------------------------- | --------------------------------------------------------------------- |
| L1   | `openLightbox({ images, startIndex: 0 })` 后调用 | dialog `open` 属性 = true，`<img>` src 等于 images\[0].url，meta 显示 `1 / N` |
| L2   | 触发 `next()`                                   | `<img>` src 切到 images\[1].url，meta 显示 `2 / N`                         |
| L3   | 触发 `prev()` 跨边界                               | wrap 到末张                                                              |
| L4   | 触发 `closeLightbox()`                          | dialog `open` 属性 = false                                              |
| L5   | 模拟 `click` 在带 `data-image-url` 的元素            | 自动打开 lightbox（验证全局委托）                                                 |
| L6   | 模拟 ESC 按键                                     | dialog 关闭                                                             |

> 这些组件依赖 `<dialog>` API；测试在 happy-dom 环境下若不支持，可降级为对内部状态机（`state.currentIndex`/`state.images`）的断言。

### 5.2 修改

#### 5.2.1 [web/__tests__/frontend-view.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-view.test.ts)

| 行号                                                                                                          | 旧断言                                                                                               | 新断言                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [L544-L545](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-view.test.ts#L544-L545) | `<div class="agent-detail-text">`                                                                 | 保持不变                                                                                                                                                        |
| [L745](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-view.test.ts#L745)           | `contentToText({ image_url })` 含 `[image] data:...`                                               | 改为只断言 `[image]`（不含 url）                                                                                                                                     |
| 新增 case A                                                                                                   | `renderUserQueryBubble({ index: 0, text: "hi", images: [{ url: "data:image/png;base64,AAA" }] })` | 输出含 `<button class="image-thumb"`、`data-image-url="data:image/png;base64,AAA"`、`data-image-group="bubble-0"`、`<div class="user-query-bubble-text">hi</div>` |
| 新增 case B                                                                                                   | text 为空、仅 1 张图片                                                                                   | 含 `image-thumb`、不含 `user-query-bubble-text`                                                                                                                 |
| 新增 case C                                                                                                   | `agent-output-graph` 中 user message 含 2 图                                                         | Run summary 含 `📎 2` chip（chip text 校验）                                                                                                                     |
| 新增 case D                                                                                                   | timeline `input_context` 事件 data 含 image\_url（dataUrl）                                            | `renderTimelineItem` 输出的 `<pre>` 不含完整 `data:image/png;base64,` 长串，含 `[image image/png` 占位                                                                   |

### 5.3 不动的测试

| 文件                                                                                                                              | 状态 |
| ------------------------------------------------------------------------------------------------------------------------------- | -- |
| [web/__tests__/frontend-export.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-export.test.ts) | 不变 |
| [web/__tests__/frontend-smoke.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/frontend-smoke.test.ts)   | 不变 |
| [web/__tests__/model-providers.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/model-providers.test.ts) | 不变 |
| [web/__tests__/prompt-versions.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/prompt-versions.test.ts) | 不变 |
| [web/__tests__/skills.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/skills.test.ts)                   | 不变 |
| [web/__tests__/tools.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/tools.test.ts)                     | 不变 |
| [web/__tests__/trace.test.ts](file:///Users/bytedance/Documents/Codex/helixent/web/__tests__/trace.test.ts)                     | 不变 |
| `src/coding/tools/__tests__/*`                                                                                                  | 不变 |
| `src/agent/__tests__/*`                                                                                                         | 不变 |
| `src/cli/tui/__tests__/*`                                                                                                       | 不变 |
| `src/cli/settings/__tests__/*`                                                                                                  | 不变 |

***

## 6. Out-of-Scope（明确不做）

* Files API / 后端落盘 + 静态服务 URL（D6 follow-up）

* 图片下采样 / 自动压缩 / EXIF 剥离

* 远程 https URL 粘贴框

* Assistant 输出图片（协议层 `AssistantMessageContent` 本次不扩）

* PDF / 视频输入

* TUI（Ink）composer 附件 UI

* AGENTS.md / README 文档同步

***

## 7. 风险与缓解

| 风险                                              | 影响                 | 缓解                                                                             |
| ----------------------------------------------- | ------------------ | ------------------------------------------------------------------------------ |
| 单条 message 含 4 × 5 MB base64 → 单行 jsonl ≈ 27 MB | trace 文件膨胀、UI 卡    | 由 D3 上限控制；后续 D6 落盘 / Anthropic Files API 根除                                    |
| Anthropic data URL 解析正则边角情况漏配                   | 转换失败、Anthropic 400 | 正则严格只匹配 `data:image/(png\|jpeg\|gif\|webp);base64,`；其它走 url 通道由 Anthropic 自身报错 |
| 单图 / 整请求超 Anthropic 上限（5 MB / 32 MB）            | 模型直接 400           | 前端 + 服务端双重校验；服务端 28 MB 阈值留 4 MB 余量                                             |
| Multi-turn 中 base64 history 累计变大                | 每轮请求体随 turns 线性放大  | D10 软提示；长期通过 Files API `source.type=file` 改为引用                                 |
| 图片 long edge > 8000 px 被 Anthropic 拒收           | 模型 400             | 前端不主动 resize（D4），但在错误处理里识别 Anthropic 错误信息透传给用户                                 |
| `FileReader` 大文件阻塞主线程                           | 短时卡顿               | 上限 5 MB；用户可感                                                                   |
| 旧 prompt-version 不含 image，激活兼容                  | 无                  | 全部改动向后兼容                                                                       |
| 旧 trace 回放不含 image                              | 渲染分支需 fallback     | `renderUserQueryBubble` 默认 `images = []`                                       |

***

## 8. Verification（执行后验证）

1. `bun run check`（lint + typecheck + 全量 tests）全绿，含 §5.1 新增、§5.2 修改用例。
2. 启动 `bun web/server.ts`，浏览器打开 <http://127.0.0.1:4317：>

   * **OpenAI 模型**：拖拽 1 张 PNG + 文字「描述这张图」，模型回复正确感知图像，trace 中 `input_context.messages` 含 `image_url`。

   * **Anthropic 模型**：同样操作，无 `invalid_request_error`，模型正常回复。

   * 多张：4 张图依次拖入，第 5 张被前端拒。

   * 截图粘贴：`Cmd+Shift+4` 截图后 `Cmd+V` 粘到 textarea，缩略图出现。

   * 超大图：>5 MB 文件被前端拒绝，弹出错误 toast。

   * 仅图无文：发送成功。

   * 仅文无图：发送成功（不退化）。
3. 刷新页面：历史 user 气泡仍渲染缩略图。
4. 删除 image 后再发送：气泡只剩文本，无残留。
5. `/clear` 命令仍能清空。
6. 旧 trace 文件（无 image）打开无回归。

***

## 9. 实施顺序（Execution Steps）

> 每步独立可提交、可回滚；推荐顺序按依赖向前。

### Stage A — 后端 + 协议

1. `src/community/anthropic/utils.ts` 加 `parseImageDataUrl` + 改 image\_url 分支；写 §5.1.1 单测。
2. `web/types.ts` 加 `WebImageInput` / 扩 `SubmitMessageBody`。
3. `web/server.ts` 抽 `buildUserMessageContent` 纯函数 + 校验 + 改 `submitMessage`；写 §5.1.2 单测。

### Stage B — 前端基建（视图模型 + Lightbox）

1. 新建 `web/public/view/images.js`：`extractImagesFromMessage` / `extractImagesFromEvent` / `summarizeMessageWithImages` / `renderThumbnailStrip` / `sanitizeImagesForDebugDump`；写 §5.1.3 单测。
2. 新建 `web/public/view/image-lightbox.js` + `web/public/styles/image-lightbox.css`；写 §5.1.4 单测。
3. `web/public/index.html` 注册 lightbox dialog 模板 + script + style + bump cache version 62→63。

### Stage C — Composer 与 user 气泡

1. `web/public/app/state.js` 加 `pendingImages` / dom refs。
2. `web/public/app/session.js` file picker / drop / paste / submit body / 待发缩略图也可点开 lightbox。
3. `web/public/styles/composer.css` 新增 composer 附件样式。
4. `web/public/view/output-cards.js` user 气泡 + `renderUserQueryBubble({ images })`。
5. `web/public/view/utils.js` `contentToText` `image_url` 分支退化为 `[image]`。
6. `web/public/app/output.js` Inspect dialog 加缩略图条（不再放原图）。
7. `web/public/styles/agent-output-graph.css` 新增 `.image-thumb` / `.user-query-bubble-images`。

### Stage D — Agent Output / Timeline 适配

1. `web/public/view/agent-output-graph.js` Run builder 接 `summarizeMessageWithImages`；Run summary 渲 `📎 N` chip；user item detail 接缩略图条；tool detail 防御性 `sanitizeImagesForDebugDump`。
2. `web/public/view/timeline.js` 接 `extractImagesFromEvent` 改 subtitle / badge；createTimelineEventNode 用 sanitize 拷贝。
3. `web/public/view/timeline-legacy.js` `renderTimelineItem` `<pre>` 用 sanitize；末尾追加缩略图条。

### Stage E — 测试与回归

1. 更新 §5.2 frontend-view\.test.ts 断言（utils 改名 + 新增 4 case）。
2. `bun run check`：lint + typecheck + tests 全绿。
3. 浏览器手测 §8 全部用例（OpenAI / Anthropic / 多图 / 拖拽 / 粘贴 / 超大拒收 / 历史回放 / lightbox 切换）。

***

## 10. 图片视图模型 / 组件复用总览

```
                          ┌────────────────────────────┐
                          │   message / event source   │
                          └─────────────┬──────────────┘
                                        │
              ┌─────────────────────────┴──────────────────────────┐
              ▼                                                    ▼
  extractImagesFromMessage()                        extractImagesFromEvent()
              │                                                    │
              └─────────────────────┬──────────────────────────────┘
                                    ▼
                          ImageViewModel[]
                                    │
       ┌──────────────────┬─────────┼─────────┬───────────────────┐
       ▼                  ▼         ▼         ▼                   ▼
 user-query-bubble   composer   agent-out  inspect          timeline
 (output-cards)      待发卡片    user item   弹窗            <pre> 后
       │                  │         │         │                   │
       └──────────────────┴────┬────┴─────────┴───────────────────┘
                               ▼
                   renderThumbnailStrip()
                               │
                  全部输出 <button data-image-url>
                               │
                               ▼
              全局 click 委托  →  imageLightbox.openLightbox
                               │
                               ▼
                       <dialog id="imageLightbox">
                       (ESC / ←/→ / 关闭按钮)
```

要点：

* **唯一提取入口** → 控制 ImageViewModel 字段稳定。

* **唯一渲染入口** → 缩略图样式、点击行为、a11y 一处维护。

* **唯一 Lightbox** → DOM 只有一份，无内存泄漏。

* **Sanitize 仅作用于 dump 视图** → 真实 SSE / Trace / 状态完全不变。

***

## 11. 协议层影响清单（一目了然）

| 层                             | 是否变化                | 备注                                 |
| ----------------------------- | ------------------- | ---------------------------------- |
| `UserMessage.content` 类型      | 不变                  | 早已支持 image\_url                    |
| `SubmitMessageBody` HTTP body | **新增可选字段** `images` | 向后兼容                               |
| SSE 事件类型 / TraceKind          | 不变                  | image\_url 走数据字段，不新增 kind          |
| `SessionSnapshot.messages`    | 不变                  | 自动含 image\_url（已是 union 一部分）       |
| Prompt-version snapshot       | 不变                  | `messages: NonSystemMessage[]` 已支持 |
| Trace jsonl 写入                | 不变（只是体积更大）          | follow-up 落盘方案根除                   |
| OpenAI Provider 通路            | **不变**              | data URL 直通                        |
| Anthropic Provider 通路         | **改造 1 处**          | data URL → base64 source           |
| CLI / TUI                     | 不变                  | 不接附件 UI                            |

每步独立可提交、可回滚。

***

## A. 附录：Anthropic Vision API 官方依据

> **来源（三 URL 镜像同源，正文一致）**：
>
> * `https://docs.claude.com/en/docs/build-with-claude/vision`（fetched 2026-05-21）
> * `https://platform.claude.com/docs/en/build-with-claude/vision`（同一份文档，部分网络下 region restricted）
> * `https://docs.anthropic.com/en/docs/build-with-claude/vision`（旧域名重定向）
>
> 三个 URL 指向 Anthropic 官方 Vision 文档同一份内容，方案以官方文档原文为准。

### A.1 三种 image source 形态

```json
// base64
{ "type": "image", "source": { "type": "base64", "media_type": "image/jpeg", "data": "<纯 base64，不含 data:,前缀>" } }

// URL
{ "type": "image", "source": { "type": "url", "url": "https://upload.wikimedia.org/.../ant.jpg" } }

// Files API（beta，需 header anthropic-beta: files-api-2025-04-14）
{ "type": "image", "source": { "type": "file", "file_id": "file_abc123" } }
```

### A.2 关键限制（与本方案直接相关）

| 项                    | 官方文档原文                                              | 本方案对齐方式                          |
| -------------------- | --------------------------------------------------- | -------------------------------- |
| 支持 mime              | JPEG / PNG / GIF / WebP                             | F5 / D5                          |
| **整请求大小（标准 endpoint）** | **≤ 32 MB**（官方明文）                                  | 服务端 28 MB 阈值（留 4 MB 余量）          |
| 单图大小                 | **官方 Vision 文档无明文条目**；由 32 MB / 1.34 / 4 张反推 ≈ 5.97 MB | 方案侧保守阈值 5 MB（D3，前后端双重校验）         |
| 单请求图片数               | ≤ 100（200k 上下文模型）/ 600（其它）                          | D3（4 张远低于上限）                     |
| Long edge            | ≤ 8000 px；>20 张图时降到 2000 px                         | 风险表 + 错误透传，前端不主动 resize          |
| Multi-turn 含图        | 推荐 Files API（避免 base64 history 累积）                  | D6 follow-up + D10 软提示           |
| GIF                  | 仅第一帧                                                | 风险表备注，UI 不特别提示                   |
| Bedrock / Vertex     | **仅支持 base64**（不支持 url）                             | OpenAI/Anthropic 主线不受影响           |
| Best practice 顺序     | image-before-text                                   | D11 + `buildUserMessageContent` |

### A.3 主要 FAQ 摘录

* **Claude can read image URLs**：`source.type = "url"` 自 2025 起支持，URL 只能是 http/https 公网。

* **Image metadata**：Claude 不解析 EXIF / metadata。

* **Animated GIF**：仅第一帧被使用。

### A.4 OpenAI 侧对照（[platform.openai.com/docs/guides/vision](https://platform.openai.com/docs/guides/vision)）

* `image_url.url` 同时接受 `https://...` 与 `data:image/{png|jpeg|gif|webp};base64,{b64}`。

* `detail: "auto" | "low" | "high"` 可选。

* 单图、整请求大小限制由具体模型 + endpoint 决定，OpenAI 通常更宽松，因此本方案以 Anthropic 限制为最严边界（32 MB 整请求 → 反推 5 MB / 4 张）。

### A.5 方案逐条 vs 官方文档核对结论（**最终核对：无冲突**）

| #   | 方案条目                                                       | 官方文档原文                                  | 结论    |
| --- | ---------------------------------------------------------- | --------------------------------------- | ----- |
| 1   | `source.type` ∈ `base64` / `url` / `file`                   | 文档列出三种                                  | ✅ 一致  |
| 2   | base64 `data` 不含 `data:,` 前缀                                | 官方 cURL/Python/TS 例子均传 `BASE64_IMAGE_DATA` 纯字符串 | ✅ 一致  |
| 3   | `media_type` ∈ jpeg/png/gif/webp                            | 官方 "Image format" 节                      | ✅ 一致  |
| 4   | url 必须 http/https                                           | 官方 base64 / URL example 二选一             | ✅ 一致  |
| 5   | 单图 ≤ 5 MB（方案侧）                                              | 官方无明文，由 32 MB 反推                         | ✅ 不冲突 |
| 6   | 整请求 ≤ 32 MB                                                 | 官方 Note 明文 32 MB                        | ✅ 一致  |
| 7   | 单条 ≤ 4 张                                                    | 官方上限 100 / 600（远松于方案）                   | ✅ 不冲突 |
| 8   | Long edge ≤ 8000 px                                         | 官方明文                                    | ✅ 一致  |
| 9   | Multi-turn 推荐 Files API                                     | 官方 Note 明文「For many images, consider Files API」 | ✅ 一致  |
| 10  | GIF 仅首帧                                                     | 官方 "Animations are unsupported, only the first frame will be used" | ✅ 一致  |
| 11  | Files API beta header `anthropic-beta: files-api-2025-04-14` | 官方 Files API example                    | ✅ 一致（本次不启用） |
| 12  | image-before-text 顺序                                        | 官方 Tip「Claude works best when images come before text」 | ✅ 已纳入 D11 |

**结论：方案与 Anthropic Vision 官方文档**（`docs.claude.com` / `platform.claude.com` / `docs.anthropic.com` 三镜像）**逐条无冲突**。「单图 5 MB」是方案侧由 32 MB 整请求上限反推的保守阈值，已在 D3 / §3.1.1 / §A.2 三处明确标注为「方案侧阈值」而非官方明文。

