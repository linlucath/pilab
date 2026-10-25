# Pi Lab 工程约定

## 项目与目录

Pi Lab 是一个本机运行的 LLM 调试工作台：React 19 前端、Express 5 API、Vite 开发服务；模型流经 Pi Agent Core。

- `src/`：React 页面、交互组件与 CSS。
- `server/`：Express API、模型运行、持久化与同步。
- `shared/`：前后端共用 schema 和业务逻辑。
- `tests/`：Node 单元/集成测试。
- `e2e/`：Playwright 浏览器行为测试与 fixtures。
- `specs/behaviors.md`：行为与验收期望；产品真相来源。
- `specs/suspected-issues.md`：待复现疑点；`specs/issues.md`：经确认或待处理的问题清单。

## 常用命令

```sh
npm test
npx tsc --noEmit
npm run e2e
npm run patrol                 # 报告写入 artifacts/patrol/report.md
npm run patrol -- RUN-03       # 只跑匹配的行为编号
npm run shots                  # UI 场景图写入 artifacts/shots/
scripts/worker.sh list
scripts/worker.sh new <名字>
scripts/worker.sh merge <名字>
scripts/worker.sh rm <名字>
```

首次需要浏览器时运行 `npx playwright install chromium`。E2E 通过 `PI_LAB_E2E_PORT` 指定端口；默认按 worktree 路径选可用端口。`PI_LAB_E2E=1` 才启用脚本化 mock 与隔离数据目录。

## 工作流

1. 先读 `specs/behaviors.md`，行为清单及其中「期望」是产品真相来源。修复行为缺陷时，先写以行为编号开头、可复现失败的 E2E 测试，再修实现。
2. 跑相关测试及 `npm test`、`npx tsc --noEmit`、`npm run e2e`；改动需完整时再跑 `npm run patrol`、`npm run shots`。只提交小而聚焦的 commit。
3. 验收后在 `specs/issues.md` 勾选对应问题，并将 `specs/behaviors.md` 对应行为状态改为「已验证」。不得顺手改动无关行为。
4. 并行工作必须使用 `scripts/worker.sh new <名字>` 创建独立 worktree；通过 `scripts/worker.sh merge <名字>` 合并，勿在共享主 worktree 并行改文件。
5. 报告直接说明改动、结果和证据。若实现与期望不一致，明确指出冲突并给主管可执行的建议，不把推测写成事实。

## 铁律

- 未经主管同意，不得删除或弱化测试；不得修改行为清单中的「期望」文字。认为期望不合理时只在报告中提出理由和建议。
- 不得读写用户真实的项目 `.pi-lab/` 或 `~/.pi/`（包含凭证、会话与配置）。浏览器 E2E 只能使用临时目录与 mock，不得触达真实模型或 Pi 凭证。
- 不得把并行工人的改动直接放进共享主 worktree；不得 `git push`。
- 测试失败先判断是产品缺陷还是测试定位/隔离问题；不得为让测试变绿而隐藏真实失败。

## UI 视觉约束

沿用现有 CSS token 与克制的浅色/深色中性色风格，优先复用 `src/styles/tokens.css`、组件类和 CSS 变量；不要为单个组件另造一套主题。

- 颜色：浅色底以 `--app-bg: #f7f7f5`、白色 surface、`--text: #18181b` 和柔和灰边框为主；靛蓝 `--accent: #4f46e5` 用于重点操作。深色主题必须使用对应 dark tokens。状态颜色遵循 success / warning / danger tokens。
- 形状：使用既有小/中/大圆角 token（7/11/16px）及胶囊形状态；避免厚重边框和高强度阴影。
- 间距：保持 4–8px 紧凑控件间距、约 12–18px 内容间距；面板与对话区域有清楚层级，不挤压主内容。
- 字体：Inter / DM Sans 与系统中文字体为正文；标签和辅助文字克制分级，路径、代码、参数使用 IBM Plex Mono。确保禁用、窄屏和深色状态仍清晰可读。
