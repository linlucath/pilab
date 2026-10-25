import { test, expect, type Page, type Locator } from "@playwright/test";
import type { Message } from "../shared/schema";
import { e2eSession, openWorkspace, seedWorkspace, setMockScript, ui } from "./fixtures/index";

const msg = (id: string, role: Message["role"], content: string, extra: Partial<Message> = {}): Message => ({ id, role, content, enabled: true, ...extra });
const row = (page: Page, id: string) => page.locator(`.message-row[data-message-id="${id}"]`);
const openSeed = async (page: Page, messages: Message[], title = "Message test") => {
  await seedWorkspace(page, [e2eSession("msg-session", title, messages)]);
  await openWorkspace(page);
};
const editMessage = async (target: Locator, label: string) => {
  await target.hover();
  await target.getByRole("button", { name: "编辑消息" }).click();
  return target.getByRole("textbox", { name: label });
};
const savedWorkspace = async (page: Page) => {
  const response = await page.context().request.get(new URL("/api/workspace", page.url()).href);
  expect(response.ok()).toBeTruthy();
  return (await response.json()).workspace;
};

test("MSG-01 仅添加各角色消息、从消息入口插入并在系统区添加 Developer", async ({ page }) => {
  const call = { id: "msg-01-call", name: "e2e_mock_tool", arguments: "{}" };
  await openSeed(page, [
    msg("msg-01-system", "system", "system prompt"),
    msg("msg-01-developer", "developer", "developer prompt"),
    msg("msg-01-existing", "user", "existing user"),
    msg("msg-01-assistant", "assistant", "existing assistant"),
    msg("msg-01-tool-owner", "assistant", "tool owner", { toolCalls: [call] }),
    msg("msg-01-tool-result", "tool", "existing tool result", { toolCallId: call.id, toolName: call.name }),
  ]);
  let modelRequests = 0;
  page.on("request", (request) => { if (request.url().endsWith("/api/run") && request.method() === "POST") modelRequests++; });
  const composer = ui(page).composer;
  const rolePicker = page.getByRole("combobox", { name: "新消息角色" });
  for (const [role, content] of [["user", "added user only"], ["assistant", "added assistant only"], ["system", "added system only"]] as const) {
    await rolePicker.selectOption(role);
    await composer.fill(content);
    await page.getByRole("button", { name: "仅添加" }).click();
    await expect(page.locator(`.chat-message.${role}`).filter({ hasText: content })).toBeVisible();
  }
  expect(modelRequests).toBe(0);
  await expect(page.locator(".chat-message.user").filter({ hasText: "added user only" })).toBeVisible();
  await expect(page.locator(".chat-message.assistant").filter({ hasText: "added assistant only" })).toBeVisible();
  await expect(page.locator(".chat-message.system").filter({ hasText: "added system only" })).toBeVisible();

  await row(page, "msg-01-existing").hover();
  await row(page, "msg-01-existing").getByRole("button", { name: "在下方插入消息" }).click();
  const inserted = page.locator(".message-row").nth(1);
  const insertedEditor = await editMessage(inserted, "编辑 You 消息");
  await insertedEditor.fill("inserted in history");
  await inserted.getByRole("button", { name: "保存消息" }).click();
  await expect(inserted).toContainText("inserted in history");
  const userOrder = await page.locator(".message-row--user-bubble").evaluateAll((items) => items.map((item) => item.textContent));
  expect(userOrder.findIndex((text) => text?.includes("inserted in history"))).toBe(userOrder.findIndex((text) => text?.includes("existing user")) + 1);

  await page.locator(".system-banner").getByRole("button", { name: "展开 / 编辑" }).click();
  await page.locator(".system-banner").getByRole("button", { name: "添加 Developer" }).click();
  const developerEditors = page.getByRole("textbox", { name: "developer 人设内容" });
  await expect(developerEditors).toHaveCount(2);
  await page.locator(".system-banner").getByRole("button", { name: "编辑指令" }).click();
  await expect(developerEditors.last()).toBeEditable();
  await developerEditors.last().fill("developer added from system prompt area");
  await page.locator(".system-banner").getByRole("button", { name: /保存/ }).click();
  await expect(developerEditors.last()).toHaveValue("developer added from system prompt area");
  await page.locator('.tool-step[data-result-id="msg-01-tool-result"] summary').click();
  await expect(page.locator('.tool-step[data-result-id="msg-01-tool-result"]')).toContainText("existing tool result");
});

test("MSG-02 编辑消息可保存、Esc 取消并用 Ctrl/Command+Enter 保存上下文", async ({ page }) => {
  const longText = `原始文本\n中文第二行\n${"长文本内容".repeat(60)}`;
  await openSeed(page, [msg("msg-02-system", "system", "system"), msg("msg-02-user", "user", longText)]);
  const target = row(page, "msg-02-user");
  const firstEdit = await editMessage(target, "编辑 You 消息");
  const savedText = `已保存第一行\n中文内容\n${"完整长文本".repeat(60)}`;
  await firstEdit.fill(savedText);
  await target.getByRole("button", { name: "保存消息" }).click();
  await expect(target.locator(".message-content")).toContainText("已保存第一行");
  await expect.poll(async () => (await savedWorkspace(page)).sessions[0].messages.find((message: Message) => message.id === "msg-02-user")?.content).toBe(savedText);

  const cancelledEdit = await editMessage(target, "编辑 You 消息");
  await cancelledEdit.fill("这次应当取消");
  await cancelledEdit.press("Escape");
  await expect(target.locator(".message-content")).toContainText("已保存第一行");
  await expect(target.locator(".message-content")).not.toContainText("这次应当取消");
  expect((await savedWorkspace(page)).sessions[0].messages.find((message: Message) => message.id === "msg-02-user")?.content).toBe(savedText);

  const shortcutEdit = await editMessage(target, "编辑 You 消息");
  const finalText = "快捷键保存\n中文和多行仍完整";
  await shortcutEdit.fill(finalText);
  await shortcutEdit.press("Control+Enter");
  await expect(target.locator(".message-content")).toContainText("快捷键保存");
  await setMockScript(page, [{ type: "text", text: "MSG-02-CONTEXT-OK" }]);
  let submitted: { messages: Message[] } | undefined;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/run") && request.method() === "POST") submitted = JSON.parse(request.postData() || "{}") as { messages: Message[] };
  });
  await page.getByRole("button", { name: "重新运行" }).click();
  await expect(page.getByText("MSG-02-CONTEXT-OK")).toBeVisible();
  expect(submitted?.messages.find((message) => message.id === "msg-02-user")?.content).toBe(finalText);
});

test("MSG-03 普通消息可改角色且工具调用和结果的角色修改有原因提示", async ({ page }) => {
  const call = { id: "msg-03-call", name: "e2e_mock_tool", arguments: "{}" };
  await openSeed(page, [
    msg("msg-03-system", "system", "system"),
    msg("msg-03-assistant", "user", "preserve assistant content"),
    msg("msg-03-system-role", "user", "preserve system content"),
    msg("msg-03-developer", "user", "preserve developer content"),
    msg("msg-03-tool-owner", "assistant", "tool call must remain paired", { toolCalls: [call] }),
    msg("msg-03-tool-result", "tool", "paired output", { toolCallId: call.id, toolName: call.name }),
  ]);
  for (const [id, role, expectedClass] of [
    ["msg-03-assistant", "assistant", "assistant"],
    ["msg-03-system-role", "system", "system"],
    ["msg-03-developer", "developer", "developer"],
  ]) {
    const target = row(page, id);
    await target.hover();
    await target.getByRole("combobox").selectOption(role);
    await expect(target.locator(`article.chat-message.${expectedClass}`)).toContainText(`preserve ${expectedClass === "assistant" ? "assistant" : expectedClass} content`);
  }
  const owner = row(page, "msg-03-tool-owner");
  await owner.hover();
  const lockedRole = owner.getByRole("combobox");
  await expect(lockedRole).toBeDisabled();
  await expect(lockedRole).toHaveAttribute("title", /工具调用及其结果不能直接更改角色/);
  const toolStep = page.locator('.tool-step[data-result-id="msg-03-tool-result"]');
  await expect(toolStep.locator("select")).toHaveCount(0);
  await expect(toolStep).toHaveAttribute("title", /工具调用及其结果不能直接更改角色/);
  await toolStep.locator("summary").click();
  await expect(toolStep).toContainText("paired output");
});

test("MSG-04 排除和恢复消息影响请求，工具调用与结果成组切换", async ({ page }) => {
  const call = { id: "msg-04-call", name: "e2e_mock_tool", arguments: "{}" };
  await openSeed(page, [
    msg("msg-04-system", "system", "system"),
    msg("msg-04-user-excluded", "user", "temporarily hidden context"),
    msg("msg-04-owner", "assistant", "tool pair owner", { toolCalls: [call] }),
    msg("msg-04-result", "tool", "pair result", { toolCallId: call.id, toolName: call.name }),
    msg("msg-04-last", "user", "remaining context"),
  ]);
  const user = row(page, "msg-04-user-excluded");
  await user.hover();
  await user.getByRole("button", { name: "排除上下文" }).click();
  await expect(user.locator("article")).toHaveClass(/excluded/);
  await expect(user).toContainText("temporarily hidden context");
  await user.hover();
  await user.getByRole("button", { name: "包含上下文" }).click();
  await expect(user.locator("article")).not.toHaveClass(/excluded/);
  await user.hover();
  await user.getByRole("button", { name: "排除上下文" }).click();
  await expect(user.locator("article")).toHaveClass(/excluded/);

  const owner = row(page, "msg-04-owner");
  await owner.hover();
  await owner.getByRole("button", { name: "排除上下文" }).click();
  await expect(owner.locator("article")).toHaveClass(/excluded/);
  await expect(page.locator('.tool-step[data-result-id="msg-04-result"]')).toBeAttached();
  await expect.poll(async () => {
    const messages = (await savedWorkspace(page)).sessions[0].messages as Message[];
    return [messages.find((message) => message.id === "msg-04-owner")?.enabled, messages.find((message) => message.id === "msg-04-result")?.enabled];
  }).toEqual([false, false]);

  await setMockScript(page, [{ type: "text", text: "MSG-04-CONTEXT-OK" }]);
  let submitted: { messages: Message[] } | undefined;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/run") && request.method() === "POST") submitted = JSON.parse(request.postData() || "{}") as { messages: Message[] };
  });
  const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/run") && response.request().method() === "POST");
  await page.getByRole("button", { name: "重新运行" }).click();
  const runResponse = await responsePromise;
  await expect(page.getByText("MSG-04-CONTEXT-OK")).toBeVisible();
  expect(submitted?.messages.map((message) => message.id)).toEqual(["msg-04-system", "msg-04-user-excluded", "msg-04-owner", "msg-04-result", "msg-04-last"]);
  expect(submitted?.messages.find((message) => message.id === "msg-04-owner")?.enabled).toBe(false);
  const events = (await runResponse.text()).trim().split("\n").map((line) => JSON.parse(line) as { type: string; payload?: unknown });
  const modelRequest = events.find((event) => event.type === "request");
  expect(modelRequest).toBeDefined();
  const modelPayload = JSON.stringify(modelRequest?.payload);
  expect(modelPayload).toContain("remaining context");
  expect(modelPayload).not.toContain("temporarily hidden context");
  expect(modelPayload).not.toContain("tool pair owner");
  expect(modelPayload).not.toContain("pair result");
});

test("MSG-05 合法消息可重排、首末边界禁用且破坏工具配对的移动被拒绝", async ({ page }) => {
  await openSeed(page, [
    msg("msg-05-first", "user", "first user"),
    msg("msg-05-second", "user", "second user"),
  ]);
  const first = row(page, "msg-05-first");
  const second = row(page, "msg-05-second");
  await first.hover();
  await expect(first.getByRole("button", { name: "上移消息" })).toBeDisabled();
  await second.hover();
  await expect(second.getByRole("button", { name: "下移消息" })).toBeDisabled();
  await first.hover();
  await first.getByRole("button", { name: "下移消息" }).click();
  expect(await page.locator(".message-row").evaluateAll((items) => items.map((item) => item.getAttribute("data-message-id")))).toEqual(["msg-05-second", "msg-05-first"]);
  await setMockScript(page, [{ type: "text", text: "MSG-05-ORDER-OK" }]);
  let submitted: { messages: Message[] } | undefined;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/run") && request.method() === "POST") submitted = JSON.parse(request.postData() || "{}") as { messages: Message[] };
  });
  await page.getByRole("button", { name: "重新运行" }).click();
  await expect(page.getByText("MSG-05-ORDER-OK")).toBeVisible();
  expect(submitted?.messages.map((message) => message.id)).toEqual(["msg-05-second", "msg-05-first"]);

  const call = { id: "msg-05-call", name: "e2e_mock_tool", arguments: "{}" };
  await openSeed(page, [
    msg("msg-05-tool-system", "system", "system"),
    msg("msg-05-tool-user", "user", "before pair"),
    msg("msg-05-tool-owner", "assistant", "paired call", { toolCalls: [call] }),
    msg("msg-05-tool-result", "tool", "paired result", { toolCallId: call.id, toolName: call.name }),
  ]);
  const owner = row(page, "msg-05-tool-owner");
  await owner.hover();
  await owner.getByRole("button", { name: "下移消息" }).click();
  await expect(page.getByRole("status")).toContainText("无法移动这条消息");
  expect(await page.locator(".message-row").evaluateAll((items) => items.map((item) => item.getAttribute("data-message-id")))).toEqual(["msg-05-tool-user", "msg-05-tool-owner"]);
  expect((await savedWorkspace(page)).sessions[0].messages.map((message: Message) => message.id)).toEqual(["msg-05-tool-system", "msg-05-tool-user", "msg-05-tool-owner", "msg-05-tool-result"]);
});

test("MSG-06 删除普通消息或工具步骤会同步处理配对而保留其它内容", async ({ page }) => {
  const calls = [
    { id: "msg-06-call-one", name: "e2e_mock_tool", arguments: "{\"input\":\"one\"}" },
    { id: "msg-06-call-two", name: "e2e_mock_tool", arguments: "{\"input\":\"two\"}" },
  ];
  await openSeed(page, [
    msg("msg-06-system", "system", "system"),
    msg("msg-06-ordinary", "user", "ordinary message to remove"),
    msg("msg-06-owner", "assistant", "assistant prose survives deleting one step", { toolCalls: calls }),
    msg("msg-06-result-one", "tool", "first paired result", { toolCallId: calls[0].id, toolName: calls[0].name }),
    msg("msg-06-result-two", "tool", "second paired result", { toolCallId: calls[1].id, toolName: calls[1].name }),
  ]);
  const ordinary = row(page, "msg-06-ordinary");
  await ordinary.hover();
  await ordinary.getByRole("button", { name: "删除消息" }).click();
  await expect(ordinary).toHaveCount(0);

  const owner = row(page, "msg-06-owner");
  const firstStep = owner.locator('.tool-step[data-result-id="msg-06-result-one"]');
  await firstStep.locator("summary").click();
  await firstStep.getByRole("button", { name: "删除此步骤及配对结果" }).click();
  await expect(owner).toContainText("assistant prose survives deleting one step");
  await expect(page.locator('.tool-step[data-result-id="msg-06-result-one"]')).toHaveCount(0);
  await expect(page.locator('.tool-step[data-result-id="msg-06-result-two"]')).toBeVisible();
  let messages: Message[] = [];
  await expect.poll(async () => {
    messages = (await savedWorkspace(page)).sessions[0].messages as Message[];
    return messages.map((message) => message.id).includes("msg-06-result-one");
  }).toBe(false);
  expect(messages.map((message) => message.id)).toContain("msg-06-result-two");
  expect(messages.find((message) => message.id === "msg-06-owner")?.toolCalls).toHaveLength(1);

  await owner.hover();
  await owner.getByRole("button", { name: "删除消息" }).click();
  await expect(owner).toHaveCount(0);
  await expect.poll(async () => {
    messages = (await savedWorkspace(page)).sessions[0].messages as Message[];
    return [messages.some((message) => message.id === "msg-06-owner"), messages.some((message) => message.id === "msg-06-result-two")];
  }).toEqual([false, false]);
  expect(messages.map((message) => message.id)).not.toContain("msg-06-owner");
  expect(messages.map((message) => message.id)).not.toContain("msg-06-result-two");
  expect(messages.some((message) => message.role === "tool" && message.toolCallId === calls[1].id)).toBe(false);
});

test("MSG-07 复制消息完整文本并在剪贴板失败时反馈", async ({ page }) => {
  const content = "第一段纯文本\n第二段中文内容";
  await openSeed(page, [msg("msg-07-system", "system", "system"), msg("msg-07-user", "user", content)]);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const target = row(page, "msg-07-user");
  await target.hover();
  await target.getByRole("button", { name: "复制消息" }).click();
  await expect(page.getByRole("status")).toContainText("已复制到剪贴板");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(content);

  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new Error("clipboard denied")) } }));
  await target.hover();
  await target.getByRole("button", { name: "复制消息" }).click();
  await expect(page.getByRole("status")).toContainText("无法访问剪贴板");
});

test("MSG-08 搜索旧消息和工具结果、展开目标并可退出且不改历史", async ({ page }) => {
  const call = { id: "msg-08-call", name: "e2e_mock_tool", arguments: "{}" };
  await openSeed(page, [
    msg("msg-08-system", "system", "collapsible system needle"),
    msg("msg-08-old", "user", "older user text"),
    msg("msg-08-owner", "assistant", "", { toolCalls: [call] }),
    msg("msg-08-result", "tool", "TOOL-SEARCH-ONLY-UNIQUE", { toolCallId: call.id, toolName: call.name }),
  ]);
  await page.getByRole("button", { name: "目录与搜索" }).click();
  const search = page.getByRole("textbox", { name: "搜索会话消息" });
  await search.fill("TOOL-SEARCH-ONLY-UNIQUE");
  const results = page.getByRole("list", { name: "搜索结果" });
  const result = results.getByRole("listitem");
  await expect(result).toHaveCount(1);
  await expect(result).toContainText("Tool result");
  await expect(result).toContainText("04");
  await expect(result).toContainText("TOOL-SEARCH-ONLY-UNIQUE");
  await result.click();
  const tool = page.locator('.tool-step[data-result-id="msg-08-result"]');
  await expect(tool).toHaveAttribute("open", "");
  await expect(tool).toHaveClass(/jump-highlight/);

  await search.fill("collapsible system needle");
  await expect(results.getByRole("listitem")).toHaveCount(1);
  await results.getByRole("listitem").click();
  await expect(page.locator(".system-banner")).toHaveClass(/expanded/);
  await expect(page.locator('.system-message-edit[data-message-id="msg-08-system"]')).toBeVisible();
  await search.fill("definitely no matching message");
  await expect(page.getByText("没有匹配的消息。")).toBeVisible();
  await search.press("Escape");
  await expect(page.getByRole("button", { name: "目录与搜索" })).toHaveAttribute("aria-expanded", "false");
  expect((await savedWorkspace(page)).sessions[0].messages.map((message: Message) => message.content)).toEqual([
    "collapsible system needle", "older user text", "", "TOOL-SEARCH-ONLY-UNIQUE",
  ]);
});

test("MSG-09 安全渲染 Markdown、表格和代码并只复制代码内容", async ({ page }) => {
  const longCode = Array.from({ length: 40 }, (_, index) => `console.log(${index});`).join("\n");
  const codeText = `const answer = 42;\n${longCode}`;
  const content = [
    "## Markdown heading",
    "- first item",
    "- second item",
    "| A | B | C | D | E | F |",
    "| --- | --- | --- | --- | --- | --- |",
    "| one | two | three | four | five | six |",
    "```js",
    codeText,
    "```",
    "<img src=x onerror=alert(1)>",
    "[safe](https://example.com) [mail](mailto:test@example.com) [bad](javascript:alert(1))",
  ].join("\n");
  await openSeed(page, [msg("msg-09-system", "system", "system"), msg("msg-09-user", "user", content)]);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const target = row(page, "msg-09-user");
  await expect(target.getByRole("heading", { name: "Markdown heading" })).toBeVisible();
  await expect(target.locator("ul > li")).toHaveCount(2);
  await expect(target.locator("table tbody tr")).toHaveCount(1);
  await expect(target.locator(".table-scroll")).toHaveCSS("overflow-x", "auto");
  await expect(target.locator("img")).toHaveCount(0);
  await expect(target.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(target.locator('a[href="https://example.com"]')).toBeVisible();
  await expect(target.locator('a[href="mailto:test@example.com"]')).toBeVisible();
  await expect(target.locator(".message-content")).toContainText("<img src=x onerror=alert(1)>");
  const codeBlock = target.locator(".markdown-code pre");
  expect(await codeBlock.evaluate((element) => element.scrollHeight > element.clientHeight)).toBeTruthy();
  await target.getByRole("button", { name: "复制代码" }).click();
  await expect(target.locator(".markdown-code .code-head button")).toContainText("已复制");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(codeText);
});
