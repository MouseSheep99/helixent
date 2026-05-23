# Helixent 工具调用全链路梳理

这份文档总结 Helixent 中 tools / tool call 的完整工作流，目标是回答下面几个问题：

- 工具在代码里是怎么定义的
- 工具如何注册到 agent
- 请求发给模型时，tools 是怎么进入 API payload 的
- 模型决定调用工具时，返回的数据长什么样
- agent 如何执行工具、拿到结果并回填到上下文
- middleware、enabled tools、streaming 在这条链路里分别起什么作用

文档基于当前代码仓库状态撰写，主要涉及这些文件：

- `src/foundation/tools/function-tool.ts`
- `src/foundation/models/model.ts`
- `src/agent/agent.ts`
- `src/coding/agents/lead-agent.ts`
- `src/coding/tools/read-file.ts`
- `src/community/openai/model-provider.ts`
- `src/community/openai/utils.ts`
- `src/community/openai/stream-utils.ts`
- `web/tools.ts`

---

## 1. 总体流程图

```text
用户输入
  |
  v
Agent.stream(userMessage)
  |
  | 1) append user message 到 agent 上下文
  v
_think()
  |
  | 2) 组装 modelContext
  |    - prompt
  |    - messages
  |    - tools
  v
_beforeModel()
  |
  | 3) middleware 改写请求
  |    - skills middleware 拼接 <skill_system>
  |    - tools middleware 过滤 enabled tools
  v
Model.stream(context)
  |
  | 4) 组装 provider 请求参数
  |    - system message
  |    - history messages
  |    - tools
  v
OpenAI chat.completions.create(...)
  |
  | 5) 模型决定：
  |    - 直接回复文本
  |    - 或返回 tool_calls
  v
parseAssistantMessage / StreamAccumulator
  |
  | 6) OpenAI 响应转为内部 AssistantMessage
  |    - text
  |    - thinking
  |    - tool_use
  v
_extractToolUses()
  |
  |---- 没有 tool_use ----> 结束，返回最终答复
  |
  |---- 有 tool_use ----> _act(toolUses)
                           |
                           | 7) 按 name 找到对应 tool
                           | 8) 执行 tool.invoke(input)
                           | 9) 生成 tool_result message
                           v
                        append 到上下文
                           |
                           v
                        回到 _think() 继续下一轮
```

从架构上看，这就是一个典型的 ReAct loop：

1. Think：调用模型
2. Act：执行工具
3. Observe：把工具结果回填给模型
4. 再次 Think

---

## 2. 工具对象的定义方式

### 2.1 标准结构

工具的核心抽象定义在 `src/foundation/tools/function-tool.ts`。

```ts
export interface FunctionTool<P, R> {
  name: string;
  description: string;
  parameters: P;
  invoke: (input, signal?) => Promise<R>;
}
```

可以把它理解成一个标准化的函数工具协议：

- `name`
  - 工具名
  - 模型发起 tool call 时会使用这个名字
- `description`
  - 给模型看的工具用途说明
  - 帮助模型决定什么时候该调用这个工具
- `parameters`
  - 参数 schema
  - 当前用 `zod` 定义，再转为 JSON Schema 发给模型
- `invoke`
  - 工具真正执行的函数
  - agent 在本地执行的就是它

### 2.2 defineTool 的作用

同文件中的 `defineTool(...)` 只是一个构造辅助函数：

```ts
export function defineTool<P extends z.ZodSchema<Record<string, unknown>>, R>({
  name,
  description,
  parameters,
  invoke,
}: {
  name: string;
  description: string;
  parameters: P;
  invoke: (input: z.infer<P>, signal?: AbortSignal) => Promise<R>;
}): FunctionTool<P, R> {
  return { name, description, parameters, invoke } as FunctionTool<P, R>;
}
```

它本质上做的事很简单：

- 接收一组定义字段
- 返回一个符合 `FunctionTool` 接口的对象
- 顺便让 TypeScript 把参数类型和返回类型推导出来

---

## 3. 一个具体工具是怎么写的

以 `read_file` 为例，定义在 `src/coding/tools/read-file.ts`：

```ts
export const readFileTool = defineTool({
  name: "read_file",
  description: "Read a file from an absolute path. Supports optional line-range reads for large files.",
  parameters: z.object({
    description: z
      .string()
      .describe("Explain why you want to read the file. Always place `description` as the first parameter."),
    path: z.string().describe("The absolute path to the file to read."),
    startLine: z.number().int().positive().describe("1-based starting line to read.").optional(),
    endLine: z.number().int().positive().describe("1-based ending line to read, inclusive.").optional(),
    maxChars: z.number().int().positive().describe("Maximum characters to return from the selected range.").optional(),
  }),
  invoke: async ({ path, startLine, endLine, maxChars }) => {
    ...
  },
});
```

这里有两个层面：

### 3.1 给模型看的“接口元信息”

- `name = "read_file"`
- `description = "Read a file from an absolute path..."`
- `parameters = z.object(...)`

这些内容会在请求模型时进入 `tools` 字段。

### 3.2 给本地运行时看的“执行逻辑”

`invoke` 里是真正的实现逻辑：

- 校验绝对路径
- 校验行号范围
- 读文件
- 截断内容
- 返回文本或错误结果

例如：

```ts
const file = Bun.file(path);
if (!(await file.exists())) {
  return errorToolResult(`File ${path} does not exist.`, "FILE_NOT_FOUND", { path });
}
```

也就是说：

- 模型只负责决定“要不要调用 `read_file`”
- 真正读文件是在本地 `invoke(...)` 里完成的

---

## 4. 工具如何注册到 Helixent agent

工具列表由 `src/coding/agents/lead-agent.ts` 注册：

```ts
tools: [
  bashTool,
  fileInfoTool,
  listFilesTool,
  globSearchTool,
  grepSearchTool,
  mkdirTool,
  movePathTool,
  readFileTool,
  writeFileTool,
  strReplaceTool,
  applyPatchTool,
  todoTool,
  ...(askUserQuestionTool ? [askUserQuestionTool] : []),
],
```

这一步的意义是：

- 声明“这个 agent 当前有哪些工具可以用”
- 后续 `_think()` 阶段会把这些工具传给模型
- `_act()` 阶段会从这组工具里按名字查找并执行

你可以把它理解成：

- 类似 Web 框架里注册一组路由 handler
- 只是这里注册的是“可供模型调用的函数”

---

## 5. enabled tools 与 inventory

在 web 端还存在一层“工具库存”和“启用状态”的概念，代码在 `web/tools.ts`。

### 5.1 工具 inventory

```ts
export function toToolInventory(tools?: Tool[], enabledTools?: Set<string>): ToolInventoryItem[] {
  return (tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters.toJSONSchema(),
    requiresApproval: CODING_TOOLS_REQUIRING_APPROVAL.includes(tool.name),
    ...(enabledTools ? { enabled: enabledTools.has(tool.name) } : {}),
  }));
}
```

这是给 UI / 状态管理用的，包含：

- name
- description
- parameters schema
- 是否需要审批
- 当前是否 enabled

### 5.2 真实传给模型的是 enabled 子集

```ts
export function filterTools(tools: Tool[] | undefined, enabledTools: Set<string>): Tool[] | undefined {
  if (!tools) return tools;
  return tools.filter((tool) => enabledTools.has(tool.name));
}
```

也就是说：

- agent 初始注册的是全量工具
- 真正每轮发给模型的是“enabled tools 子集”
- 因此模型看到的工具集合可能小于 agent 注册总量

---

## 6. Agent 主循环：从用户输入开始

Helixent 的核心执行循环在 `src/agent/agent.ts` 的 `stream(...)` 中：

```ts
async *stream(message: UserMessage): AsyncGenerator<AgentEvent> {
  if (this._streaming) {
    throw new Error("Agent is already streaming");
  }

  this._abortController = new AbortController();
  this._appendMessage(message);
  await this._beforeAgentRun();
  this._streaming = true;
  try {
    for (let step = 1; step <= this.options.maxSteps; step++) {
      this._abortController.signal.throwIfAborted();
      await this._beforeAgentStep(step);
      const assistantMessage = yield* this._think();
      await this._afterModel(assistantMessage);
      yield { type: "message", message: assistantMessage };

      const toolUses = this._extractToolUses(assistantMessage);
      if (toolUses.length === 0) {
        await this._afterAgentRun();
        return;
      }

      yield* this._act(toolUses);
      await this._afterAgentStep(step);
    }
    throw new Error("Maximum number of steps reached");
  } finally {
    this._streaming = false;
    this._abortController = null;
  }
}
```

这里的流程可以拆成几步：

1. 把用户消息 append 到上下文
2. 进入 step 循环
3. `_think()` 调模型
4. 拿到模型回复后，提取 `tool_use`
5. 如果没有 tool_use，直接结束
6. 如果有 tool_use，进入 `_act(...)`
7. 工具执行完，把 `tool_result` append 回上下文
8. 回到下一轮 `_think()`

---

## 7. _think()：如何组装本轮模型请求

`_think()` 在 `src/agent/agent.ts` 中：

```ts
private async *_think(): AsyncGenerator<AgentEvent, AssistantMessage> {
  const modelContext: ModelContext = {
    prompt: this.prompt,
    messages: this.messages,
    tools: this.tools,
    signal: this._abortController?.signal,
  };
  await this._beforeModel(modelContext);

  let latest: AssistantMessage | null = null;
  for await (const snapshot of this.model.stream(modelContext)) {
    latest = snapshot;
    if (snapshot.streaming) {
      yield this._deriveProgress(snapshot);
    }
  }
  ...
  this._appendMessage(latest);
  return latest;
}
```

这一段很关键，说明每次调用模型时上下文包含：

- `prompt`
  - agent 的 system prompt
- `messages`
  - 当前完整对话历史
- `tools`
  - 当前可用工具列表
- `signal`
  - 中断控制

### 7.1 middleware 会在这里改写请求

`await this._beforeModel(modelContext);`

表示每个 middleware 都可以在真正发请求前修改：

- `prompt`
- `messages`
- `tools`

`_beforeModel(...)` 的实现是：

```ts
private async _beforeModel(modelContext: ModelContext) {
  for (const middleware of this.middlewares) {
    if (!middleware.beforeModel) continue;
    const result = await middleware.beforeModel({ modelContext, agentContext: this._context });
    if (result) {
      Object.assign(modelContext, result);
    }
  }
}
```

常见作用：

- skills middleware 往 prompt 里拼 `<skill_system>...</skill_system>`
- tools middleware 用 enabled set 过滤工具

---

## 8. Model 层如何把 prompt / messages / tools 发给 provider

`src/foundation/models/model.ts` 负责把内部统一格式转成 provider 需要的参数：

```ts
private _buildModelProviderParams(context: ModelContext): ModelProviderInvokeParams {
  const messages: Message[] = [];
  if (context.prompt) {
    messages.push({ role: "system", content: [{ type: "text", text: context.prompt }] });
  }
  messages.push(...context.messages);
  return {
    model: this.name,
    options: this.options,
    messages,
    tools: context.tools,
    signal: context.signal,
  };
}
```

这一步非常重要：

- `prompt` 会变成一条 `role: "system"` message
- 历史消息 `context.messages` 会接在后面
- tools 不会拼进 prompt，而是单独保存在 `tools` 字段

所以“模型知道有哪些工具”这件事，不依赖 system prompt 文字里有没有把工具列出来。

---

## 9. OpenAI provider 如何发送 tools

真正发请求的 provider 在 `src/community/openai/model-provider.ts`：

```ts
private _baseChatCompletionParams({
  model,
  messages,
  tools,
  options,
}: {
  model: string;
  messages: Message[];
  tools?: Tool[];
  options?: Record<string, unknown>;
}) {
  return {
    model,
    messages: convertToOpenAIMessages(messages),
    tools: tools ? convertToOpenAITools(tools) : undefined,
    temperature: 0,
    ...options,
  };
}
```

关键点：

- `messages` 会先做一层 OpenAI 协议转换
- `tools` 会通过 `convertToOpenAITools(...)` 转成 OpenAI 的 function tool 结构

真正的调用点：

```ts
const response = await this._client.chat.completions.create(params, { signal });
```

---

## 10. convertToOpenAITools：模型实际看到的 tool 长什么样

定义在 `src/community/openai/utils.ts`：

```ts
export function convertToOpenAITools(tools: Tool[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters.toJSONSchema() },
  }));
}
```

也就是说，模型实际看到的某个 tool 大致是：

```json
{
  "type": "function",
  "function": {
    "name": "read_file",
    "description": "Read a file from an absolute path. Supports optional line-range reads for large files.",
    "parameters": {
      "type": "object",
      "properties": {
        "description": {
          "type": "string",
          "description": "Explain why you want to read the file. Always place `description` as the first parameter."
        },
        "path": {
          "type": "string",
          "description": "The absolute path to the file to read."
        },
        "startLine": {
          "type": "number",
          "description": "1-based starting line to read."
        },
        "endLine": {
          "type": "number",
          "description": "1-based ending line to read, inclusive."
        },
        "maxChars": {
          "type": "number",
          "description": "Maximum characters to return from the selected range."
        }
      },
      "required": ["description", "path"]
    }
  }
}
```

所以：

- tool 有名字
- tool 有用途描述
- 参数也有 schema 和 description

模型就是基于这些信息决定要不要调用这个工具。

---

## 11. OpenAI 消息转换：assistant / tool 如何互转

OpenAI 协议和 Helixent 内部 message 结构不完全一样，所以 `src/community/openai/utils.ts` 里做了双向转换。

### 11.1 内部 assistant message -> OpenAI assistant message

```ts
} else if (message.role === "assistant") {
  const assistantMessage: OpenAIAssistantMessageParam = {
    role: "assistant",
    content: [],
  };
  assistantMessage.reasoning_content = "";
  for (const content of message.content) {
    if (content.type === "thinking") {
      assistantMessage.reasoning_content = content.thinking;
    } else if (content.type === "tool_use") {
      if (!assistantMessage.tool_calls) {
        assistantMessage.tool_calls = [];
      }
      assistantMessage.tool_calls.push({
        type: "function",
        id: content.id,
        function: {
          name: content.name,
          arguments: JSON.stringify(content.input),
        },
      });
    } else {
      (assistantMessage.content as ChatCompletionContentPart[]).push(content);
    }
  }
}
```

这里说明：

- 内部 `thinking` -> OpenAI `reasoning_content`
- 内部 `tool_use` -> OpenAI `assistant.tool_calls`
- 普通 text -> OpenAI `assistant.content`

### 11.2 内部 tool_result -> OpenAI tool message

```ts
} else if (message.role === "tool") {
  for (const content of message.content) {
    if (content.type === "tool_result") {
      openaiMessages.push({
        role: "tool",
        tool_call_id: content.tool_use_id,
        content: content.content,
      });
    }
  }
}
```

这一步决定了下一轮模型能看见工具执行结果。

---

## 12. 模型返回 tool call 后，如何转回内部格式

`parseAssistantMessage(...)` 负责把 OpenAI 的回复转回 Helixent 内部结构：

```ts
export function parseAssistantMessage(message: OpenAIChatCompletionMessage, usage?: TokenUsage): AssistantMessage {
  const result: AssistantMessage = {
    role: "assistant",
    content: [],
    usage,
  };
  if (typeof message.reasoning_content === "string") {
    result.content.push({ type: "thinking", thinking: message.reasoning_content });
  }
  if (typeof message.content === "string") {
    result.content.push({ type: "text", text: message.content });
  }
  if (message.tool_calls) {
    for (const tool_call of message.tool_calls) {
      if (tool_call.type === "function") {
        result.content.push({
          type: "tool_use",
          id: tool_call.id,
          name: tool_call.function.name,
          input: JSON.parse(tool_call.function.arguments),
        });
      }
    }
  }
  return result;
}
```

如果模型返回：

```json
{
  "role": "assistant",
  "content": "",
  "tool_calls": [
    {
      "id": "call_read_001",
      "type": "function",
      "function": {
        "name": "read_file",
        "arguments": "{\"description\":\"Inspect the tool definition\",\"path\":\"/Users/bytedance/Documents/Codex/helixent/src/foundation/tools/function-tool.ts\"}"
      }
    }
  ]
}
```

那么在 Helixent 内部会变成：

```ts
{
  role: "assistant",
  content: [
    {
      type: "tool_use",
      id: "call_read_001",
      name: "read_file",
      input: {
        description: "Inspect the tool definition",
        path: "/Users/bytedance/Documents/Codex/helixent/src/foundation/tools/function-tool.ts"
      }
    }
  ]
}
```

---

## 13. streaming 下 tool call 是怎么累计的

在 streaming 模式下，tool call 通常不是一次完整返回，而是逐块到达。处理逻辑在 `src/community/openai/stream-utils.ts`。

### 13.1 逐块累计

```ts
if (delta.tool_calls) {
  for (const tc of delta.tool_calls) {
    let entry = this.toolCalls.get(tc.index);
    if (!entry) {
      entry = { id: tc.id ?? "", name: tc.function?.name ?? "", arguments: "" };
      this.toolCalls.set(tc.index, entry);
    }
    if (tc.id) entry.id = tc.id;
    if (tc.function?.name) entry.name = tc.function.name;
    if (tc.function?.arguments) entry.arguments += tc.function.arguments;
  }
}
```

这里做了三件事：

- 累积 `id`
- 累积 `name`
- 持续拼接 `arguments` 字符串

### 13.2 只有参数能解析时，才产出 tool_use

```ts
try {
  input = JSON.parse(tc.arguments);
  parsed = true;
} catch {
  // arguments JSON is still streaming
}

if (!parsed && !isFinal) continue;
content.push({ type: "tool_use", id: tc.id, name: tc.name, input });
```

这样做的目的是：

- 中间 streaming 状态不要暴露半截 JSON
- 只有当参数已经是合法 JSON 时，才向下游产出 `tool_use`

这能避免 UI 和 agent 看到一个不完整的工具参数对象。

---

## 14. _extractToolUses：从模型回复里筛出工具调用

`src/agent/agent.ts`：

```ts
private _extractToolUses(message: AssistantMessage): ToolUseContent[] {
  return message.content.filter((content): content is ToolUseContent => content.type === "tool_use");
}
```

功能很简单：

- 遍历 `message.content`
- 只保留 `type === "tool_use"` 的 block

如果用更直白的伪代码表示：

```text
result = []
for content in message.content:
  if content.type == "tool_use":
    result.append(content)
return result
```

这里的 TypeScript 类型谓词：

```ts
(content): content is ToolUseContent => ...
```

意思是：

- 如果过滤条件成立
- TypeScript 就知道这个 `content` 不是泛型内容块，而是确定的 `ToolUseContent`

---

## 15. _act()：工具真正在哪里执行

工具执行逻辑在 `src/agent/agent.ts` 的 `_act(...)` 中：

```ts
private async *_act(toolUses: ToolUseContent[]): AsyncGenerator<AgentEvent> {
  const signal = this._abortController?.signal;
  const pending = toolUses.map(async (toolUse, index) => {
    try {
      const tool = this.tools?.find((t) => t.name === toolUse.name);
      if (!tool) throw new Error(`Tool ${toolUse.name} not found`);
      const beforeResult = await this._beforeToolUse(toolUse);
      if (beforeResult.skip) {
        return { index, toolUseId: toolUse.id, toolName: toolUse.name, result: beforeResult.result };
      }
      const result = await tool.invoke(toolUse.input, signal);
      await this._afterToolUse(toolUse, result);
      return { index, toolUseId: toolUse.id, toolName: toolUse.name, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { index, toolUseId: toolUse.id, toolName: toolUse.name, result: `Error: ${message}` };
    }
  });
  ...
}
```

这一步的关键逻辑是：

1. `find((t) => t.name === toolUse.name)`
   - 按名字找到对应 tool
2. `await this._beforeToolUse(toolUse)`
   - 让 middleware 有机会拦截或 short-circuit
3. `await tool.invoke(toolUse.input, signal)`
   - 真正执行工具
4. `await this._afterToolUse(toolUse, result)`
   - 让 middleware 在执行后做附加处理
5. 如果异常，包装成 `"Error: ..."` 返回

### 15.1 为什么多个工具可以并发

因为这里用的是：

```ts
const pending = toolUses.map(async (toolUse, index) => { ... });
```

这会立刻得到一组 promise，然后后面用 `Promise.race(...)` 逐个消费已经完成的工具。

也就是说：

- 一轮模型可以返回多个 tool call
- Helixent 会并行执行它们

---

## 16. 工具结果如何回填到上下文

在 `_act(...)` 中，工具执行结束后，会生成一条 `role: "tool"` 的 message：

```ts
const toolMessage: ToolMessage = {
  role: "tool",
  content: [
    {
      type: "tool_result",
      tool_use_id: resolved.toolUseId,
      content: formatToolResultForMessage({ toolName: resolved.toolName, result: resolved.result }),
    },
  ],
};
this._appendMessage(toolMessage);
yield { type: "message", message: toolMessage };
```

随后 `_appendMessage(...)` 会把它加入 agent 上下文：

```ts
private _appendMessage(message: NonSystemMessage) {
  this.messages.push(message);
}
```

这意味着：

- 下一轮 `_think()` 时
- 模型不仅能看到自己的上一条 assistant 消息
- 还能看到这条新加入的 `tool_result`

这就是 ReAct 中的 Observe 阶段。

---

## 17. 一个完整 example：read_file 的端到端调用

假设用户输入：

```text
帮我看看 src/foundation/tools/function-tool.ts 里 tool 是怎么定义的
```

### 17.1 Agent 初始状态

- prompt：`lead-agent.ts` 里的 system prompt
- messages：已有历史 + 当前 user message
- tools：例如包含 `read_file`

### 17.2 发给模型的请求可抽象为

```json
{
  "model": "xxx",
  "messages": [
    {
      "role": "system",
      "content": "<agent ...>...</agent>"
    },
    {
      "role": "user",
      "content": "帮我看看 src/foundation/tools/function-tool.ts 里 tool 是怎么定义的"
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "read_file",
        "description": "Read a file from an absolute path. Supports optional line-range reads for large files.",
        "parameters": {
          "type": "object",
          "properties": {
            "description": { "type": "string" },
            "path": { "type": "string" }
          }
        }
      }
    }
  ]
}
```

### 17.3 模型返回 tool call

```json
{
  "role": "assistant",
  "tool_calls": [
    {
      "id": "call_read_001",
      "type": "function",
      "function": {
        "name": "read_file",
        "arguments": "{\"description\":\"Inspect the tool definition\",\"path\":\"/Users/bytedance/Documents/Codex/helixent/src/foundation/tools/function-tool.ts\"}"
      }
    }
  ]
}
```

### 17.4 Helixent 解析后变成内部 `tool_use`

```ts
{
  type: "tool_use",
  id: "call_read_001",
  name: "read_file",
  input: {
    description: "Inspect the tool definition",
    path: "/Users/bytedance/Documents/Codex/helixent/src/foundation/tools/function-tool.ts"
  }
}
```

### 17.5 `_act()` 执行真实工具

```ts
const tool = this.tools?.find((t) => t.name === "read_file");
const result = await tool.invoke({
  description: "Inspect the tool definition",
  path: "/Users/bytedance/Documents/Codex/helixent/src/foundation/tools/function-tool.ts"
}, signal);
```

### 17.6 `readFileTool.invoke(...)` 返回文件内容

例如：

```text
import type { z } from "zod";

export interface FunctionTool<...> {
  name: string;
  description: string;
  parameters: P;
  invoke: ...
}
```

### 17.7 Agent 生成 `tool_result`

```ts
{
  role: "tool",
  content: [
    {
      type: "tool_result",
      tool_use_id: "call_read_001",
      content: "import type { z } from \"zod\"; ..."
    }
  ]
}
```

### 17.8 下一轮模型再次推理

模型现在能看到：

- 原始 user 问题
- 自己刚才发起的 `tool_call`
- 这个 `tool_result`

于是它可以回答：

```text
FunctionTool 是一个统一的工具接口，包含 name、description、parameters、invoke 四部分...
```

---

## 18. 工具调用链路中的关键扩展点

### 18.1 beforeModel

位置：`src/agent/agent.ts`

作用：

- 改 prompt
- 改 messages
- 改 tools

常见用途：

- skills 注入
- enabled tools 过滤
- trace / telemetry 采样

### 18.2 beforeToolUse

位置：`src/agent/agent.ts`

作用：

- 工具执行前拦截
- 允许 middleware 返回 `__skip`

适合做：

- 审批
- 风险拦截
- mock 返回

### 18.3 afterToolUse

位置：`src/agent/agent.ts`

作用：

- 工具执行后追加 side effects
- 记录日志 / trace
- 改写结果

### 18.4 afterModel

作用：

- 模型回复出来后做附加处理
- 例如 UI trace、埋点、消息修正

---

## 19. 常见误解澄清

### 19.1 tools 不在 system prompt 里

对。

在 Helixent 里：

- system prompt 走 `messages[0]`
- tools 走 OpenAI 协议层的 `tools` 字段

所以你在 SP 文本里没看到 tools 描述，不代表模型看不到工具。

### 19.2 模型不会自己执行工具

对。

模型只会输出“我要调用哪个工具”和“参数是什么”。

真正执行发生在本地：

- `tool.invoke(input, signal)`

### 19.3 tool result 不是模型自动知道的

也对。

tool result 是 agent 主动 append 回上下文，再在下一轮请求时发给模型的。

### 19.4 enabled tools 会影响模型行为

对。

如果某个工具没出现在当轮 `tools` 字段里，模型就无法发起对它的 tool call。

---

## 20. 最终总结

Helixent 的 tools 机制本质上是一个三段式闭环：

1. **声明工具**
   - 用 `defineTool(...)` 定义 `name / description / parameters / invoke`
   - 在 `lead-agent.ts` 注册到 agent

2. **让模型选择工具**
   - `Model` 把 `prompt + messages + tools` 交给 provider
   - OpenAI provider 把 tools 转成标准 `function tools` 协议
   - 模型基于 description 和 schema 生成 `tool_calls`

3. **本地执行并回填结果**
   - agent 从 assistant message 中提取 `tool_use`
   - `_act()` 里按名字找到 tool 并执行 `invoke(...)`
   - 把执行结果包装成 `tool_result`
   - append 回上下文，继续下一轮推理

如果把这套机制浓缩成一句话：

> Helixent 并不是把工具“写死在 prompt 里”，而是把工具作为结构化协议字段发给模型；模型只负责决定“调用哪个工具、传什么参数”，本地 agent 负责真正执行，再把结果作为 `tool_result` 消息回填给模型，形成 ReAct 闭环。

