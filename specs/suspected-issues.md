# 可疑问题

以下是根据当前实现静态阅读得到的疑点，尚未通过浏览器/真实 Pi 场景复现；这里只记录“实现看起来与界面承诺或合理预期不一致”的位置，不当作已确认缺陷。

### ISSUE-01 侧栏提示的 ⌘N 可能没有对应快捷键
- **关联行为：** LAY-04 新建、改名、复制和删除会话
- **文件位置：** `src/components/Sidebar.tsx`（新建按钮显示 `⌘ N`）；`src/App.tsx`（全局快捷键处理）
- **现象推测：** 侧栏明确展示 ⌘N，但 App 的全局按键处理只响应 Cmd/Ctrl+Enter；目前看不到 Cmd/Ctrl+N 的新建会话处理。可能只有点击按钮能新建，与可见提示不一致。

### ISSUE-02 历史消息可能没有整条复制入口
- **关联行为：** MSG-07 复制完整消息文本
- **文件位置：** `README.md`「使用」第 2 条；`src/components/MessageStream.tsx` 的 `MessageCard` 工具栏
- **现象推测：** README 承诺历史消息可复制，但消息工具栏目前可见编辑、分支、排除、插入、排序和删除，没有整条消息复制按钮。代码块有单独复制功能，不能替代复制完整消息。

### ISSUE-03 推理强度界面只暴露三个档位
- **关联行为：** MOD-02 设置推理强度与 Temperature
- **文件位置：** `src/components/RightPanel.tsx`（`efforts` 和推理按钮）；`shared/schema.ts`（`reasoningEfforts`）；`README.md`「推理强度」说明
- **现象推测：** 配置结构与说明支持 off、minimal、low、medium、high、xhigh、max，但右侧界面只列 low、medium、high，且点击后总会把 `reasoning` 设为 true。用户可能无法在界面关闭推理或选择其它受支持档位。

### ISSUE-04 Pi CLI 正在生成的预览可能被丢弃
- **关联行为：** SYNC-03 显示生成中的只读预览
- **文件位置：** `server/pi-sync.ts`（`syncDetail` 返回 `partial`）；`src/App.tsx`（`receivePiSession`）；`src/components/MessageStream.tsx`
- **现象推测：** 同步快照包含 `partial`，但 `receivePiSession` 只把 `source.messages` 放入会话状态；`MessageStream` 接收的是已完成消息及网页运行的 `streamingId`，没有 Pi CLI `partial` 的显示入口。可能在 Pi 生成期间网页看不到 README 所说的只读预览。

### ISSUE-05 多轮请求的复制按钮可能只复制最后一轮
- **关联行为：** HIS-03 检查草稿和每轮实际请求
- **文件位置：** `src/components/RequestInspector.tsx`（`requests.map` 与「复制 JSON」按钮）
- **现象推测：** 面板会逐轮展示 `activeRun.requests`，但复制按钮只序列化 `activeRun.request`（运行期间最后更新为最近一次请求）或当前草稿。多轮 Agent 运行时可能复制不到其它轮次，和“复制界面展示的实际请求”预期不一致。
