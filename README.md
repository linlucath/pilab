# Pi Lab

基于 [Pi Agent Core](https://github.com/earendil-works/pi/tree/main/packages/agent) 的本地大语言模型输出调试工作台。

## 启动

需要 Node.js 22+。

```sh
npm install
npm run dev
```

打开 http://127.0.0.1:3000 。前端由 Vite 提供，Express 后端负责 Pi 调用和流式转发。服务仅监听本机回环地址。

## 使用

1. 已登录 Pi 时，模型下拉框列出本机已配置凭证的模型（含 Antigravity 的 Gemini 和 OpenAI Codex 的 GPT），新实验沿用 Pi 的默认模型，当前为 Gemini 3.8 Flash。选择「Pi 本地登录 · Gemini / GPT」即可复用登录，无需 API Key。也可选择「Chat Completions」，通过 `GEMINI_API_KEY` 或「自定义连接设置」使用 Gemini 的 OpenAI 兼容接口。
2. 添加 `system`、`developer`、`user`、`assistant`、`tool` 消息。所有历史消息和工具调用参数、工具结果均可直接编辑、复制、删除、排序；眼睛按钮可以临时排除消息。
3. 点击「运行」或按 Cmd/Ctrl + Enter。生成的 assistant 消息会加入历史并可继续编辑。点击「停止生成」可取消请求并保留收到的内容。
4. 在顶部或右侧「模型」下拉框切换 Pi 模型；自定义接口可手动填写模型 ID。切换保留现有消息，下一次运行生效，每个实验独立保存模型选择。
5. 「请求检查」显示当前草稿与运行时 Pi 实际发送的请求体；「运行记录」标记每次使用的模型，可以查看输出、思考内容、用量，或恢复当次输入及模型。
6. 「从此处分支」会把截至该条消息的上下文复制到新实验。JSON 导入、导出可备份和分享实验配置。

### 接口配置

| 协议                       | Base URL 示例               | 说明                                                                                                      |
| -------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------- |
| Gemini 3.8 Flash           | `https://generativelanguage.googleapis.com/v1beta/openai/` | 默认模型 `gemini-3.8-flash`，使用 `GEMINI_API_KEY`；通过 Google 的 OpenAI 兼容 Chat Completions 接口调用。 |
| Pi 本地登录 · Gemini / GPT | Pi 提供商配置              | 加载本机 Pi 提供商扩展及模型目录，复用对应登录，由 Pi 管理凭证刷新；兼容原有 GPT 模型选择。 |
| Chat Completions           | `https://api.openai.com/v1` | 保留四种角色、原始顺序和文本。也支持 OpenRouter、Ollama、vLLM 等兼容服务。                                |
| OpenAI Responses           | `https://api.openai.com/v1` | 在 input 消息中保留四种角色和顺序。                                                                       |
| Anthropic Messages         | `https://api.anthropic.com` | system 只能位于开头；不支持独立 developer 角色。遇到不支持的角色或位置会报错。                            |
| Ollama 的 Chat Completions | `http://127.0.0.1:11434/v1` | 模型填写本机已安装的模型 ID，无鉴权接口可不填 Key。                                                       |

这里保留的是请求体中的文本和角色。模型供应商可能拒绝不符合其协议的上下文，例如连续 assistant 消息或不支持 developer 的模型；这些错误直接展示，不会偷偷改写角色、重排消息或添加隐藏的 user 消息。以 assistant 结尾时再次运行表示发起下一次模型生成，是否支持 assistant prefill 由具体服务决定。

Pi 本地登录模式要求 system 消息位于开头。OpenAI Codex 会将其作为 instructions 发送；其他提供商使用各自的原生协议。订阅模式不发送 Temperature，最大输出 Tokens 可编辑，新实验默认 16384；Gemini 的思考也占用输出额度，开启高强度推理时过小的上限可能让正文中途停止。达到上限会显示状态并随消息保存。请求检查依赖提供商是否提供原始请求回调。

Antigravity 流式请求默认允许连续 10 分钟没有数据，避免长推理或排队被扩展原有的 120 秒空闲限制过早中止。这是无数据等待上限，不是整次 Agent 运行时长；收到数据后重新计时。可在启动前设置 `ANTIGRAVITY_STREAM_STALL_TIMEOUT_MS`（毫秒，兼容旧变量 `NOAGY_STREAM_STALL_TIMEOUT_MS`）；已有显式设置优先，修改后重启服务生效。达到上限仍会报错并保留已收到的内容；延长等待不能修复上游或代理断线。

Antigravity 的 Claude 续聊会在发送前排除缺少签名的 thinking 块，以及 error/aborted 运行遗留的思考（即使已带签名），避免失败思考和重试思考被合并后触发 `thinking.signature: Field required`。原始思考仍保存在网页历史中；完整成功回复的签名、正文与工具调用不变，不伪造签名。

「推理强度 / Reasoning effort」可选 off、minimal、low、medium、high、xhigh、max，Pi 订阅按当前模型能力列出档位；存在映射时直接显示实际发送值（如 minimal → low）。切换至不支持原档位的模型时，会调整到 medium 或首个支持的档位并提示。自定义接口由 Pi 转换为对应协议的参数，服务商决定实际支持范围。启用推理时省略 Temperature。推理强度随实验保存、导入导出，并记录在运行快照中；旧版开关设置兼容为 off / medium。最大输出数由 Pi 和供应商协议共同限制。编辑器支持文本和图片消息、图片预览；订阅模型按目录能力判断图片支持，自定义协议使用相应的多模态序列化。OAuth 登录复用 Pi CLI，网页不单独发起登录。

### Pi Lab Agent 工具

工具模式默认是 **Agent**，可在「模型配置 → 工具模式」中关闭：

- **Agent**：启用完整工具集，包括独立 GPT 会话管理、会话分叉、图片和上下文归档；文件读取、搜索、命令执行和文件修改均交由独立 GPT 会话完成。每个 GPT 都在自己的 Pi 进程中运行；创建时设置唯一名字，后续按名字操作，多项工作可同时进行。终端 Pi 主会话也采用这一工具集合，已存在的工具历史保留。
- **关闭**：不提供工具，仅生成模型回答；仍可回放已有的工具调用历史。

GPT 会话通过独立的 Pi RPC 进程复用本机 OpenAI Codex 登录，不复制 Token，不依赖 Codex CLI。默认 GPT 模型为 `gpt-6-luna`，推理强度为 `max`；模型可通过 `PI_LAB_GPT_SUBAGENT_MODEL` 指定。会话按 Pi 的正常机制运行、重试和压缩上下文，没有旧版单次子代理的 12 轮或 10 分钟限制。Pi Lab 后端按工作目录管理这些会话；网页运行结束后后台 GPT 继续工作，后续运行可读取结果。终端 Pi 扩展还支持结果到达时自动唤起主模型，见下文。

工具工作目录填本机已存在的绝对路径，留空使用启动服务的目录。GPT 工具以当前用户权限在本机运行，工作目录不是隔离沙箱；命令和绝对路径可以访问目录之外。停止主会话会取消模型请求与当前等待；独立 GPT 的工作需用 `/gpt stop` 或 `subagent_control(action=abort)` 停止，已完成的文件修改不会自动撤销。遇到中断而未收到完整结果时，界面会保留一条明确标记为中断、执行状态未知的错误工具结果，方便检查后继续。

每次运行默认最多 12 轮模型请求（可设置 1–50），达到上限会保留已完成的调用和工具结果，再次运行可继续。轮内多个工具按顺序执行。工具错误返回模型供其修正；用量统计汇总所有轮次。「请求检查」可展开每轮真实请求，「运行记录」包含工具轨迹。

assistant 消息中的工具名称、Call ID、参数 JSON 及 tool 消息的结果文本均可手工修改，也可以手动添加调用与结果。启用的历史中调用和结果必须完整配对；若排除或删除了其中一条，运行前会明确报错。工具历史、工具模式、工作目录、轮数和供应商要求的推理签名随实验保存与导出。修改历史只改变下一次发给模型的上下文，不会重新执行历史调用或回滚已有文件。

### 终端 Pi 中的并行 GPT 会话

在项目根目录安装或更新扩展，然后在已经打开的 Pi 中执行 `/reload`：

```sh
npm run install:gpt-subagent
```

日常主会话使用 `antigravity/gemini-3.8-flash`。Pi 用户配置 `~/.pi/agent/settings.json` 的默认模型设置为：

```json
{
  "defaultProvider": "antigravity",
  "defaultModel": "gemini-3.8-flash"
}
```

该入口复用本机 Antigravity 登录。新启动的 Pi 默认使用 Gemini；恢复旧会话时仍沿用该会话保存的模型，可通过 `/model` 切换。独立 GPT 会话会显式选择 `openai-codex` 及自己的 GPT 模型。

在 Gemini 主会话中，可以直接说：

> 开两个 GPT 会话，一个检查后端登录，一个整理测试。它们并行干活，我们继续讨论。先不要改 WebUI。

Gemini 通过三个原生工具管理这些会话。创建任务时设置唯一名字，例如「登录检查」；派发会返回可用于后续查询/控制的 tracking handle。返回状态不暴露工作目录或内部日志；失败诊断有界并按需提供。每个会话有独立的 Pi 进程、对话上下文、原生工具和会话文件，后续消息接着同一段历史继续。GPT 完成一轮回复、出现错误或需要输入时，会通过会话事件通知 Gemini。

| 原生工具 | 用途 |
| --- | --- |
| `subagent_dispatch` | 传 `task` 或 1–8 个 `tasks`；`mode: "async"`（默认）后台派发并返回 tracking handles；`mode: "sync"` 安静阻塞，等待工兵当前轮次结束、出错、需要输入或被取消，默认无超时。显式 `timeoutSeconds` 到期会报错，不返回“仍在运行”的部分结果。已存在的会话可用 `action: "send"` 接续。 |
| `subagent_query` | `action: "list"` 查询会话列表；`action: "status"` 加 `name` 或 handle 查询状态、未读简报、问题和近期活动。失败时自动附带有界 diagnostics；也可显式请求。 |
| `subagent_control` | 使用 `action: "abort"` 中止并清理排队任务、`"respond"` 回答工兵输入，或 `"close"` 关闭进程并保留原生历史。 |

旧名 `gpt_session_*` 仍保留为不可默认激活的兼容别名，供已保存 transcript 和直接集成继续调用；模型正常可见的 GPT 工具只有上述三个。

你也可以直接操作，无需等 Gemini 决定调用工具：

```text
/gpt list
/gpt new 登录检查 | 检查当前项目的登录问题
/gpt read 登录检查
/gpt send 登录检查 | 继续检查刷新 token 的逻辑
/gpt replace 登录检查 | 立刻停止当前方向，先定位这个错误
/gpt stop 登录检查
/gpt stop all
/gpt close 登录检查
/gpt reply 登录检查 | 回答
```

`/gpt after 登录检查 | 消息` 会把消息排在本轮工作后；`/gpt send` 默认使用 steering，`/gpt replace` 会立即中断再发新消息。名字可包含空格；多个待回答问题使用 `/gpt reply 登录检查 | 2 | 回答` 指定序号。重名创建会被拒绝；已有重名历史在加载时自动加 `(2)` 等后缀。停止主模型 Gemini 当前轮不会自动停止独立 GPT，请通过 `/gpt stop` 或让 Gemini 调用打断工具停止它们。

GPT 直接使用自己的 `read`、`grep`、`find`、`ls`、`bash`、`edit`、`write` 工具，也可加载正常 Pi 扩展、项目指令和技能。权限与当前用户运行 Pi 一致；默认工作目录与主会话相同，多个 GPT 对同一目录的改动会立即互相可见，可在创建时指定不同 `cwd`。原生 Pi 的扩展检查仍然生效；需要人为决定的输入会转回主会话，不会自动代答。

管理记录保存在 `~/.pi/agent/gpt-sessions/`（支持 `PI_CODING_AGENT_DIR`），按主 Pi 会话区分；GPT 的原生对话保存到 Pi 正常的 sessions 目录，也能通过 `/resume` 查找。主 Pi 退出、切换会话或 `/reload` 时会停止所属后台进程、清空尚未送达的排队消息并保留历史；再次发送消息可恢复。已经完成的文件修改不会自动撤销。关闭某个后台进程后，也可以用 `pi --session 原生会话文件路径` 在终端中直接继续它。不要同时让两个进程写入同一原生会话文件。

主模型不会把整段聊天历史自动交给 GPT，由 Gemini 在派发消息中提供相关背景和约束。`subagent_query` 默认只返回当前主会话尚未读过的已生成简报，不发送正在流式生成的草稿；重复读取显示「暂无新简报」，需要重看时可设 `repeat: true`。已读记录随聊天历史保存，不发送给模型；不同主会话和分支独立判断，新的 GPT 回复即使文字相同也会重新送达。终端 `/gpt read` 仍可主动查看最新回复和草稿。主模型与各 GPT 都通过 Pi 的正常凭证机制请求各自的模型，不复制登录 Token。可以通过 `PI_LAB_PI_BIN` 指定其他 Pi 可执行文件。

需要等结果时，Gemini 应使用 `subagent_dispatch({ task: {...}, mode: "sync" })`，而非执行 `bash sleep`。同步派发会安静等待当前轮次结束（或出错、需要回答、被用户取消），不设默认超时；省略 `timeoutSeconds` 即无限等待。同步派发期间无需也不得反复调用 `subagent_query` 或 wait 轮询。仅显式指定 1–1200 秒的 `timeoutSeconds` 才设置等待期限，到期会以错误结束此次工具调用；任务不会因此自动中止，需要停工时用 `subagent_control(action="abort")`。批量同步派发默认等待所有 worker，遇到错误、停止或需要回答时提前返回。等待通过进程状态事件唤醒，不轮询文件；主模型停止或网页关闭时取消当前等待。终端 Pi 在主动等待期间不会再为同一个完成事件额外排入自动通知轮次。

schema、模型声明、运行时校验和 UI 摘要来自统一 ToolRegistry 定义。详细用法写在三个工具的声明中，Gemini 无需额外读取 README，也不需要用户每次重复说明。

### Gemini 看图

在输入框粘贴截图、拖入图片或使用「添加图片」。暂存托盘会显示预览、上传状态和删除操作；上传失败可重试，文本为空时按 Backspace 移除最后一张。单条消息最多 8 张、总计 40 MiB，单张最多 20 MiB；支持 PNG、JPEG、WebP、GIF、BMP。图片二进制通过独立上传接口保存，工作区消息只保留图片引用，不会把 Base64 塞入 `/api/run` JSON。请求检查会隐藏图片 Base64，只显示其类型和大致大小。

默认 Gemini 地址使用 Google 的 OpenAI 兼容 Chat Completions API，因此图片按 OpenAI 多模态 `image_url` Data URL 格式发送；它不是原生 Gemini `generateContent` 的 `inlineData/parts` 请求。Pi 订阅使用模型目录对应的原生协议序列化。模型不支持图片时会明确报错，不会静默丢弃附件。

使用支持图片的 Pi 订阅模型，并将工具模式设为 Agent。可以直接告诉 Gemini：

> 让 GPT 找几张适合这个页面的排版参考，保存为「首页参考」，你看完总览后挑两张讨论。

GPT 自行搜索、下载或渲染图片，用自己的 `present_images` 工具按素材组名和图片名提交本地文件。原图复制到项目 `.pi-lab/images/files/`；来源、简短备注和名字保存在 `collections/` 中，预览保存在 `previews/` 中。更新同名图片不会覆盖旧图片内容，历史引用仍能打开。支持 PNG、JPEG、WebP、GIF 和 BMP，单张最多 20 MB；SVG 请先渲染成位图。

Gemini 使用 `view_images` 按素材组名看图，`list_images` 只列名字和数量。图片不会随 GPT 的提交或进度读取自动进入 Gemini：

- 默认只附一张编号总览，最多 6 张候选；编号和图片名对应。
- 需要看细节时指定 1–2 个图片名及 `original: true`，最长边限制为 2048 像素。
- 后续请求只附最近一次工具看图的图片；更早的图片留在本地，历史中保留简短文字和引用。
- 搜索过程、下载日志、来源说明和原图编码不作为文本塞进 Gemini。GPT 报告素材组名和数量，由 Gemini 决定是否打开。

网页工具结果直接显示预览，点击可打开大图。聊天历史只保存项目内图片引用，刷新网页或重启后端后仍能查看；导出的聊天 JSON 也只含引用，迁移项目时需一并保留 `.pi-lab/images/`。不增加说明面板或额外开关。

### Pi 订阅

本机先运行 `pi`，通过 `/login` 登录 OpenAI Codex。默认读取 `~/.pi/agent/auth.json`，可以通过 `PI_CODING_AGENT_DIR` 指定 Pi 配置目录。Pi Lab 的订阅请求和各个独立 GPT 进程都由 Pi 的原生运行时管理凭证及刷新锁，复用同一登录态。网页只获取已登录状态和模型列表，不获取 Token。订阅模式固定使用 Pi 内置供应商地址，不使用网页填写的 Base URL 或 API Key。

服务支持 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量；本机 loopback 模型接口自动绕过代理。

### API Key

在网页填写的 Key 仅保留在页面内存，通过同源请求交给本地后端，不写入 localStorage 或导出文件。也可以在启动服务前提供环境变量：

```sh
PI_LAB_API_KEY=your_key npm run dev
# 也可使用 GEMINI_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY
```

配置优先级：页面 Key → PI_LAB_API_KEY → 对应供应商变量。无 Key 时传入本地兼容接口的占位 Key。`.env` 不会自动加载；请通过 shell 或 Node 的环境变量机制配置。请求检查不包含鉴权请求头。

实验标题、消息、模型参数、删除记录和跟随设置由后端保存在项目的 `.pi-lab/workspace.json`，采用原子写入；多标签页按字段合并更新。首次使用会迁移当前浏览器中的旧实验，以后以项目文件为准，换浏览器或重启服务仍可读取。删除的 Pi 实验不会被自动同步重新导入；可从 Pi 会话下拉框主动恢复。该目录已加入 `.gitignore`。最近 30 次运行快照仅保存在当前页面内存，刷新后清除。API Key 不写入项目文件或导出文件。消息以纯文本显示，避免模型输出被当作 HTML 执行。

## 构建与验证

```sh
npm test
npm run build
npm start
```

可选真实订阅测试（会消耗少量订阅额度）：

```sh
npm run test:live
```

真实测试包含 system、developer、手动插入的 assistant 历史和编辑后的 user 内容。普通 `npm test` 不会读取或调用订阅。

测试通过本地 HTTP/SSE 模拟服务验证真实 Pi 传输，包括角色保真、排除消息、assistant 结尾的上下文、三种协议、用量统计、错误处理和取消请求；不会调用付费模型。

### 浏览器端到端测试与 AI 巡检

```sh
npx playwright install chromium
npm run e2e                 # 全量浏览器测试
npm run patrol              # 测试 + artifacts/patrol/report.md
npm run patrol -- RUN-03    # 只跑一个行为编号
npm run shots               # 关键 UI 场景截图到 artifacts/shots/
```

E2E 为每个 worktree 按路径选择独立的可用端口，也可通过 `PI_LAB_E2E_PORT` 显式指定；`e2e`、`patrol` 与 `shots` 共用此端口策略。每次启动都会为项目数据、Pi 配置和工作目录创建独立临时沙箱，退出时删除；可用 `PI_LAB_E2E_DATA_DIR` 指定沙箱父目录（拒绝指向项目 `.pi-lab/` 或 `~/.pi/`）。启动脚本清除 API 凭证，模型请求只进入 `PI_LAB_E2E=1` 显式开启的脚本化 mock。测试可从 `e2e/fixtures` 导入 `setMockScript(page, [{ type: "text", text: "固定回复" }])`；支持 `text`、`slow`、`long`、`tool`、`error`。测试标题以行为编号（如 `RUN-03`、`SMOKE-01`）开头；失败时 Playwright 保留截图和 trace。`patrol` 会按编号汇总结果，并在 `specs/behaviors.md` 存在时列出 mock 可测行为的测试覆盖缺口。

浏览器联调的可选模拟接口：`npx tsx tests/mock-provider.ts`，监听 `127.0.0.1:3001`。将 Base URL 设置为 `http://127.0.0.1:3001/v1`，输出会明确标为本地测试内容。它不随正常服务启动。

## 结构

- `src/`：React 编辑器、实验管理、模型配置和流式展示。
- `shared/schema.ts`：前后端共用的数据结构与校验。
- `server/engine.ts`：Pi Agent 生命周期、供应商流、请求体保真适配。
- `server/pi-subscription.ts`：复用 Pi 订阅、凭证管理和模型目录。
- `server/network.ts`：继承 HTTP 代理并绕过本机接口。
- `server/index.ts`：本地 HTTP API、同源限制、取消传播和静态资源服务。
- `tests/`：传输层集成测试和浏览器联调接口。

依赖使用当前上游 `@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai`，旧的 `@mariozechner/*` 包已被弃用。

### Pi CLI 双向实时同步

```sh
npm run install:sync
```

安装器把本项目的同步扩展复制到 `~/.pi/agent/extensions/pi-lab-sync/`（支持 `PI_CODING_AGENT_DIR`），不修改 Pi 的登录信息和模型配置。新的 Pi 进程自动加载扩展；**已经打开的 Pi 执行 `/reload`**。关闭扩展发现的 `pi --no-extensions` 不会自动同步。

打开网页的「Pi 实时同步」面板，默认跟随最近活动的 Pi 会话，也可选择其他目录或其他 Pi 进程的会话。启动、恢复、切换会话后自动更新，会话列表约 1.2 秒发现一次；选中的会话通过 SSE 持续推送，包括系统提示词、助手消息、原生工具调用和工具结果。扩展将生成快照按 100 ms 合并，后端每 150 ms 检查文件变化（不是每个 token 都写盘），生成中的文本与思考摘要以不可编辑预览展示。断线自动重连，并保留轮询回退。

1. 等 Pi 本轮执行完成，在网页编辑历史、插入/删除/排除消息或修改工具结果。
2. 点击 **应用到 Pi**，等待网页显示「修改已应用」和 Pi 终端确认。
3. 回到同一个 Pi 终端继续提问。后续模型请求使用修改后的上下文，工具仍由原 Pi 进程执行。网页里的模型、推理强度、工具配置用于独立分支实验，Pi 会话参数仍在终端配置。

同步通过 Pi 官方 `context_with_system` 扩展钩子改变模型实际接收的上下文；修改作为附加记录存入当前 Pi 会话分支，恢复该会话后仍有效。**终端原来的消息显示和原始日志保留**，文件、命令等已发生的副作用不会回滚。图片、工具声明、工具元数据以及未编辑的原生消息均保留；目前网页仅提供文本编辑，不提供图片编辑。Pi 原生消息不支持单独的 developer 角色，提交时会明确报错；可在网页独立实验使用该角色。

Pi 执行中不能提交。编辑期间收到新消息会保留网页草稿并阻止旧版本提交；可先「从此处分支」保留草稿，再点击「放弃修改并同步」获取新上下文。若 Pi 压缩上下文或更改了已有消息前缀，旧修改会暂停并显示提示，需要重新同步、核对、提交。切换到其他分支时按该分支的附加记录恢复修改。

快照和待确认命令只保存在本机 `~/.pi/agent/pi-lab-sync/`，文件权限为 600；扩展不需要网页服务在线即可正常聊天。网页关闭后，已应用的修改仍在 Pi 中生效。离线会话保留最后一次快照供查看，重新打开对应 Pi 会话后可继续编辑。卸载时把 `~/.pi/agent/extensions/pi-lab-sync/` 移到 extensions 目录之外，然后在 Pi 执行 `/reload`；不加载扩展时，Pi 使用原始上下文。


同步回归测试：`npm test` 包含冲突检测、原生消息/图片/工具声明保留和扩展恢复测试。服务运行时，`npm run test:live-sync` 会实际使用本机 Pi 订阅：执行原生 read 工具、修改历史暗号、确认 Pi 应用、再次调用工具并验证模型回答；测试会创建独立的临时目录和 Pi 会话，需要本机订阅可用。

### 流式输出

网页运行始终启用流式输出，不需要额外开关。Pi 订阅上游使用 SSE，`POST /api/run` 返回 `application/x-ndjson`，逐行推送 `text`、`thinking`、工具活动与最终 `done` 事件；界面边接收边显示，可停止并保留已收到的内容。推理阶段是否有摘要取决于模型/服务端，不会伪造进度或打字机效果。

请求失败或取消时，尚无正文、图片或工具调用的助手占位消息会自动移除；已有的部分正文仍保留。网页连接本地服务失败与后端连接模型失败使用不同错误提示。模型失败原因随有内容的消息保存；底层网络错误只记录目标主机名和错误码，不记录请求内容或鉴权信息。

选中的 Pi CLI 会话使用 `GET /api/pi-sync/:id/events`，返回 SSE `snapshot` 事件；这些是合并后的实时快照，而不是模型 token 原始事件。生成中的内容不进入可编辑历史；结束后自动同步为正式消息。

真实订阅 HTTP 流式验证：`npm run test:live-stream`。CLI → 扩展 → SSE 验证：`npm run test:live-pi-stream`。二者会消耗本机 Pi 订阅额度，服务须已启动。更新同步扩展后执行 `npm run install:sync`，已有 Pi 终端执行 `/reload`。

### 桌面启动（macOS）

双击桌面的 `启动 Pi Lab.command`：首次启动会构建当前源码、运行服务并在默认浏览器打开 `http://127.0.0.1:3000`；服务已在运行则直接打开网页。保持启动终端窗口打开，按 `Control+C` 停止。桌面入口调用本项目 `scripts/start.command`，移动项目目录后需更新桌面入口中的路径。端口被其他服务占用时会提示，不会强行结束其他进程。
