import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { MAX_WORKSPACE_FILE_BYTES } from "../shared/schema";
import { prepareE2eWorkspace, setMockScript } from "./fixtures/index";

const sessionId = "workspace-file-upload-session";

test("附件选择、拖放与粘贴上传到会话工作目录并随消息发送", async ({ page }) => {
  await page.setViewportSize({ width: 1720, height: 1120 });
  await prepareE2eWorkspace(page, [{
    id: sessionId,
    title: "File upload preview",
    messages: [{ id: "start", role: "user", content: "FILE-UPLOAD-START", enabled: true }],
  }]);
  await setMockScript(page, [{ type: "text", text: "文件上传测试回复" }]);

  const health = await page.request.get(new URL("/api/health", page.url()).href);
  const { workingDirectory } = await health.json() as { workingDirectory: string };
  const uniqueName = `direct-${randomUUID()}.txt`;
  const uploadUrl = () => {
    const query = new URLSearchParams({ sessionId, workingDirectory, name: `../../${uniqueName}` });
    return new URL(`/api/workspaces/upload-file?${query}`, page.url()).href;
  };
  const firstUpload = await page.request.post(uploadUrl(), {
    headers: { "Content-Type": "application/octet-stream" }, data: Buffer.from("direct upload"),
  });
  expect(firstUpload.status()).toBe(201);
  expect(await firstUpload.json()).toMatchObject({ success: true, fileName: uniqueName, relativePath: uniqueName, size: 13 });
  const secondUpload = await page.request.post(uploadUrl(), {
    headers: { "Content-Type": "application/octet-stream" }, data: Buffer.from("second upload"),
  });
  expect(secondUpload.status()).toBe(201);
  expect((await secondUpload.json()).fileName).toBe(`${path.parse(uniqueName).name} (1)${path.extname(uniqueName)}`);
  const oversized = await page.request.post(new URL(`/api/workspaces/upload-file?${new URLSearchParams({ sessionId, workingDirectory, name: "oversized.bin" })}`, page.url()).href, {
    headers: { "Content-Type": "application/octet-stream" }, data: Buffer.alloc(MAX_WORKSPACE_FILE_BYTES + 1),
  });
  expect(oversized.status()).toBe(413);
  expect((await oversized.json()).error).toContain("50 MiB");

  const composer = page.locator(".composer-card");
  const pickerPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "添加附件" }).click();
  const picker = await pickerPromise;
  await picker.setFiles({ name: "report.csv", mimeType: "text/csv", buffer: Buffer.alloc(24 * 1024, "a") });
  const report = page.getByRole("group", { name: "附件 report.csv" });
  await expect(report).toHaveAttribute("data-status", "ready");
  await expect(report.getByText("24 KB")).toBeVisible();
  await expect(report.getByText("已就绪")).toBeVisible();

  const screenshotPath = path.resolve("artifacts/visual-matrix/file-upload-preview.png");
  await mkdir(path.dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true });

  await page.route("**/api/workspaces/upload-file**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("name") === "dragged.txt") await new Promise((resolve) => setTimeout(resolve, 350));
    await route.continue();
  });
  await composer.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["dragged content"], "dragged.txt", { type: "text/plain" }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  const dragged = page.getByRole("group", { name: "附件 dragged.txt" });
  await expect(dragged).toHaveAttribute("data-status", "uploading");
  await expect(page.getByRole("button", { name: "发送" })).toBeDisabled();
  await expect(dragged).toHaveAttribute("data-status", "ready");
  await page.unroute("**/api/workspaces/upload-file**");

  const textarea = page.getByRole("textbox", { name: "撰写新消息" });
  await textarea.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["pasted content"], "pasted.md", { type: "text/markdown" }));
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
  });
  const pasted = page.getByRole("group", { name: "附件 pasted.md" });
  await expect(pasted).toHaveAttribute("data-status", "ready");

  await textarea.fill("Please inspect these files.");
  const runRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/runs" && request.method() === "POST");
  await page.getByRole("button", { name: "发送" }).click();
  const request = await runRequest;
  const body = request.postDataJSON() as { messages: { role: string; content: string }[] };
  const sent = body.messages.find((message) => message.role === "user" && message.content.includes("Please inspect these files."));
  expect(sent?.content).toContain("Please inspect these files.\n\n[附件已保存至工作目录: ./report.csv]");
  expect(sent?.content).toContain("[附件已保存至工作目录: ./dragged.txt]");
  expect(sent?.content).toContain("[附件已保存至工作目录: ./pasted.md]");
  await expect(page.getByText("文件上传测试回复")).toBeVisible();
  await expect(page.locator(".composer-file-capsule")).toHaveCount(0);
});
