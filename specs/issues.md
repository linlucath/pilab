# 待修清单

- [x] ISSUE-11 Antigravity Claude 回放失败 thinking 时被拒绝 · RUN-05 · 除未签名思考外，还需排除 error/aborted 运行遗留的已签名思考；后者会与成功重试的思考合并。真实订阅对照：旧回放复现 `messages.21.content.1.thinking.signature: Field required`，修复后的同一份 25 条历史直接续跑成功（约 13 秒，关闭工具执行）。保留网页原始记录与成功回复的签名；63 项测试、10 项隔离 E2E 与构建通过。

- [x] ISSUE-10 Antigravity 连续 120 秒无数据后中止且提示不易理解 · RUN-05 · 默认空闲等待改为 10 分钟，保留显式环境变量覆盖，增加中文说明及原始错误；59 项测试、8 项隔离 E2E 与构建通过。此项缓解过早超时，不代表已修复上游推理/排队或网络停滞。

- [ ] ISSUE-01 侧栏显示 ⌘N 但可能未实现快捷键 · LAY-04 · 静态代码审查（suspected-issues.md） · 核对 Cmd/Ctrl+N 是否新建会话；如未实现，补行为测试与快捷键。
- [ ] ISSUE-02 历史消息可能缺少整条复制入口 · MSG-07 · 静态代码审查（suspected-issues.md） · 对照 README 的复制承诺，验证工具栏是否能复制完整纯文本。
- [x] ISSUE-03 推理强度档位与关闭入口可能不完整 · MOD-02 · `e2e/models.spec.ts` · 已验证 Off 入口、自定义 Temperature 与模型支持档位。
- [ ] ISSUE-04 Pi CLI 生成中的只读预览可能未显示 · SYNC-03 · 静态代码审查（suspected-issues.md） · 用真实 Pi CLI 生成复现，并确认 partial 快照进入页面展示。
- [x] ISSUE-05 多轮请求的复制操作可能只复制最后一轮 · HIS-03 · 静态代码审查（suspected-issues.md） · 验证运行记录中复制按钮是否包含每一轮实际请求。
- [x] ISSUE-06 窄屏布局缺少可用的工作台抽屉 · LAY-06 · UI 评审（约 390px） · 右侧配置面板遮住对话且无关闭入口；侧栏收起后留下空白块；顶栏按钮换成两行。窄屏应默认收起工作台，打开时提供遮罩和关闭入口，顶栏保持单行自适应。
- [x] ISSUE-07 流式运行状态文案重复 · RUN-03 · UI 评审 · 「Gemini 正在思考 / 调度 GPT…」同时显示在消息下方和底部状态栏；只保留一处。
- [x] ISSUE-08 流式助手正文缺少生成指示 · RUN-03 · UI 评审 · 生成中的助手消息末尾没有光标或动态指示，难以辨认仍在输出；增加清晰但克制的进行中提示。
- [x] ISSUE-09 运行中分段控件对比度过低 · MOD-02、MOD-06 · UI 评审 · 思考强度和工具模式控件禁用时几乎不可辨认；保持禁用语义，同时确保文字与背景对比度可读。
- [x] ISSUE-200 模型工作台缺少 reasoning=off 入口，模型切换后不调整不支持的档位 · MOD-02 · Playwright mock（e2e/models.spec.ts）与 `tests/engine.test.ts` · 已提供 Off，切换到不支持档位时按最近支持档位校正并提示；关闭推理后 Temperature 可用并进入请求。
- [x] ISSUE-201 运行失败同时出现横幅和 toast 重复提示 · RUN-05 · Playwright mock（e2e/runs.spec.ts） · 错误信息保留在运行横幅，移除重复 toast；连接失败、模型失败和流中断均验证无 toast。
- [x] ISSUE-202 Markdown 段落刷新误推进行游标导致后续内容不显示 · MSG-09 · `flush()` 改用独立 `blockKey`；空行、列表、标题、分隔线、闭合/未闭合代码块经单测与 Playwright 回归验证。
- [x] ISSUE-203 旧 GPT 工兵缺少 owner 时被过滤/拒绝访问，工具异常可能逸出运行边界 · GPT-01 · ownerless 会话首次访问自动认领、工具错误作为 `isError` 结果返回、RunManager 最终异常边界输出 error/run_status；`tests/gpt-sessions.test.ts`、`tests/gpt-session-wait.test.ts`、`tests/detached-runtime.test.ts` 与 `e2e/thread-tabs-routing.spec.ts` 验证。
- [x] ISSUE-204 工兵 transcript 重复铺开工具事件、看不到人设上下文且运行时滚动强制跟随 · GPT-01/RUN-03/LAY-06 · 按 toolCallId 聚合可折叠操作流，展示实际 System prompt 与最近派遣内容；主消息流和工兵记录采用 80px 粘性滚动与返回底部按钮，`e2e/thread-tabs-routing.spec.ts`、`e2e/runs.spec.ts` 覆盖。
