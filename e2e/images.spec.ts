import { test, expect } from "@playwright/test";
import { prepareE2eWorkspace, setMockScript } from "./fixtures/index";

const imageFile = `files/${"a".repeat(64)}.png`;
const missingImageFile = `files/${"b".repeat(64)}.png`;
const validPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
const images = [
  { file: imageFile, name: "IMG-REFRESH-IMAGE", collection: "IMG-FIXTURE", kind: "image" as const, mimeType: "image/png" as const, width: 1, height: 1 },
  { file: missingImageFile, name: "IMG-MISSING-IMAGE", collection: "IMG-FIXTURE", kind: "image" as const, mimeType: "image/png" as const, width: 1, height: 1 },
];

async function mockImageFiles(page: import("@playwright/test").Page) {
  await page.route("**/api/images/file**", async (route) => {
    const url = new URL(route.request().url());
    const file = url.searchParams.get("file");
    if (file === imageFile) {
      await route.fulfill({ status: 200, contentType: "image/png", body: validPng });
    } else {
      await route.fulfill({ status: 404, body: "" });
    }
  });
}

async function seedImageSession(page: import("@playwright/test").Page) {
  await prepareE2eWorkspace(page, [{
    id: "image-session",
    title: "image-session",
    messages: [{ id: "image-message", role: "user", content: "IMG-02-TEXT-REMAINS", enabled: true, images }],
  }]);
}

test("IMG-02 消息缩略图可放大并关闭，图片加载失败不阻塞文本", async ({ page }) => {
  await mockImageFiles(page);
  await seedImageSession(page);

  await expect(page.locator(".message-row--user-bubble p").filter({ hasText: "IMG-02-TEXT-REMAINS" })).toBeVisible();
  const thumbnail = page.getByRole("button", { name: "IMG-REFRESH-IMAGE" });
  await expect(thumbnail).toBeVisible();
  await expect(thumbnail.getByRole("img", { name: "IMG-REFRESH-IMAGE" })).toBeVisible();
  await expect(page.getByRole("img", { name: "IMG-MISSING-IMAGE" })).toHaveCount(1);
  await expect(page.locator(".message-row--user-bubble p").filter({ hasText: "IMG-02-TEXT-REMAINS" })).toBeVisible();

  const stream = page.locator(".message-stream");
  const scrollBefore = await stream.evaluate((element) => element.scrollTop);
  await thumbnail.click();
  const lightbox = page.getByRole("dialog");
  await expect(lightbox.getByRole("img", { name: "IMG-REFRESH-IMAGE" })).toBeVisible();
  await lightbox.getByRole("button", { name: "关闭图片" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await stream.evaluate((element) => element.scrollTop)).toBe(scrollBefore);

  await thumbnail.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.locator(".image-lightbox").click({ position: { x: 3, y: 3 } });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".message-row--user-bubble p").filter({ hasText: "IMG-02-TEXT-REMAINS" })).toBeVisible();
});

test("IMG-05 粘贴、拖放、退格移除并发送图片引用", async ({ page }) => {
  await prepareE2eWorkspace(page, [{
    id: "image-input-session",
    title: "image-input-session",
    messages: [{ id: "existing-user", role: "user", content: "IMG-05-START", enabled: true }],
  }]);
  await setMockScript(page, [{ type: "text", text: "固定图片回复" }]);
  const controls = page.getByRole("textbox", { name: "撰写新消息" });
  const base64 = validPng.toString("base64");
  const textPastePrevented = await controls.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", "ordinary pasted text");
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(textPastePrevented).toBe(false);
  const uploadUrl = new URL(`/api/images/upload?name=${encodeURIComponent("direct.png")}`, page.url()).href;
  const uploadResponse = await page.request.post(uploadUrl, { headers: { "Content-Type": "application/octet-stream" }, data: validPng });
  expect(uploadResponse.status()).toBe(201);
  const uploaded = (await uploadResponse.json()).image as { id: string; mimeType: string; size: number; file: string };
  expect(uploaded).toMatchObject({ id: expect.any(String), mimeType: "image/png", size: validPng.length });
  expect(uploaded.file).toContain(uploaded.id);
  const rejectedUpload = await page.request.post(new URL("/api/images/upload?name=invalid.txt", page.url()).href, {
    headers: { "Content-Type": "application/octet-stream" }, data: Buffer.from("not an image"),
  });
  expect(rejectedUpload.status()).toBe(400);
  expect((await rejectedUpload.json()).error).toContain("PNG、JPEG、WebP、GIF 或 BMP");
  const largeBinary = await page.request.post(new URL("/api/images/upload?name=large-invalid.bin", page.url()).href, {
    headers: { "Content-Type": "application/octet-stream" }, data: Buffer.alloc(6 * 1024 * 1024),
  });
  expect(largeBinary.status()).toBe(400);
  expect((await largeBinary.json()).error).toContain("PNG、JPEG、WebP、GIF 或 BMP");
  const runBodies: Record<string, any>[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/runs" && request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, any>;
      runBodies.push(body);
    }
  });

  await controls.evaluate((element, value) => {
    const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "clipboard.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, base64);
  const tray = page.locator(".composer-image-tray");
  await expect(tray.locator(".staged-image[data-status=ready]")).toHaveCount(1);
  await expect(tray.getByRole("img", { name: "已附加图片 1" })).toBeVisible();
  await expect(tray.locator("header, figcaption")).toHaveCount(0);
  await expect(tray.getByText("clipboard.png", { exact: true })).toHaveCount(0);
  const thumbnailStyle = await tray.locator(".staged-image").evaluate((element) => {
    const image = element.querySelector("img")!;
    const remove = element.querySelector(".staged-image-remove")!;
    return {
      height: image.getBoundingClientRect().height,
      radius: getComputedStyle(image).borderRadius,
      trayBorderWidth: getComputedStyle(element.parentElement!.parentElement!).borderWidth,
      deletePosition: getComputedStyle(remove).position,
      deleteTop: getComputedStyle(remove).top,
      deleteRight: getComputedStyle(remove).right,
      deleteBackground: getComputedStyle(remove).backgroundColor,
    };
  });
  expect(thumbnailStyle.height).toBeGreaterThanOrEqual(56);
  expect(thumbnailStyle.height).toBeLessThanOrEqual(60);
  expect(thumbnailStyle).toMatchObject({ radius: "8px", trayBorderWidth: "0px", deletePosition: "absolute", deleteTop: "4px", deleteRight: "4px" });
  expect(thumbnailStyle.deleteBackground).toContain("24, 24, 27");
  await controls.focus();
  await controls.press("Backspace");
  await expect(page.locator(".staged-image")).toHaveCount(0);

  const composer = page.locator(".composer-card");
  await composer.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["not an image"], "not-image.txt", { type: "text/plain" }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect(page.getByRole("alert").filter({ hasText: "不是支持的" })).toBeVisible();
  await composer.evaluate((element, value) => {
    const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "drop-a.png", { type: "image/png" }));
    transfer.items.add(new File([bytes], "drop-b.png", { type: "image/png" }));
    element.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, base64);
  await expect(composer).toHaveClass(/is-drag-over/);
  await composer.evaluate((element, value) => {
    const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "drop-a.png", { type: "image/png" }));
    transfer.items.add(new File([bytes], "drop-b.png", { type: "image/png" }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, base64);
  await expect(tray.locator(".staged-image[data-status=ready]")).toHaveCount(2);

  await tray.getByRole("button", { name: "移除图片 1" }).click();
  await expect(tray.locator(".staged-image[data-status=ready]")).toHaveCount(1);
  await controls.focus();
  await controls.press("Backspace");
  await expect(page.locator(".staged-image")).toHaveCount(0);

  await page.route("**/api/images/upload**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("name") === "send.png") await new Promise((resolve) => setTimeout(resolve, 350));
    await route.continue();
  });
  await controls.evaluate((element, value) => {
    const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "send.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, base64);
  await expect(tray.locator(".staged-image[data-status=uploading]")).toHaveCount(1);
  await expect(tray.locator(".staged-image-state.uploading .spin")).toBeVisible();
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.locator(".composer-image-error")).toContainText("仍在上传");
  await expect(tray.locator(".staged-image[data-status=ready]")).toHaveCount(1);
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.locator(".message-row").filter({ hasText: "IMG-05-START" })).toBeVisible();
  await expect(page.getByText("固定图片回复")).toBeVisible();
  await expect(page.locator(".staged-image")).toHaveCount(0);

  const body = runBodies.at(-1);
  expect(body).toBeTruthy();
  const sent = body!.messages.find((message: any) => message.content === "" && message.images?.length);
  expect(sent.images).toHaveLength(1);
  expect(sent.images[0]).toMatchObject({ id: expect.any(String), size: validPng.length, mimeType: "image/png" });
  expect(JSON.stringify(body)).not.toContain("data:image/");
  expect(JSON.stringify(body)).not.toContain(base64);
});

test("IMG-03 刷新及导入后恢复项目图片引用，导出不内嵌原图", async ({ page }) => {
  await mockImageFiles(page);
  await seedImageSession(page);
  await expect(page.getByRole("button", { name: "IMG-REFRESH-IMAGE" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("button", { name: "IMG-REFRESH-IMAGE" })).toBeVisible();
  await expect(page.locator(".message-row--user-bubble p").filter({ hasText: "IMG-02-TEXT-REMAINS" })).toBeVisible();
  await expect(page.getByRole("img", { name: "IMG-MISSING-IMAGE" })).toHaveCount(1);

  await page.locator(".session-data-menu > summary").click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出当前会话" }).click();
  const download = await downloadPromise;
  const imageJsonStream = await download.createReadStream();
  if (!imageJsonStream) throw new Error("会话导出没有生成可读文件");
  const chunks: Buffer[] = [];
  for await (const chunk of imageJsonStream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const exportedText = Buffer.concat(chunks).toString("utf8");
  const exported = JSON.parse(exportedText) as { messages: { images?: { file: string; name: string }[] }[] };
  expect(exported.messages[0].images?.map(({ file, name }) => ({ file, name }))).toEqual(images.map(({ file, name }) => ({ file, name })));
  expect(exportedText).not.toContain("data:image/");
  expect(exportedText).not.toContain(validPng.toString("base64"));

  await page.locator(".session-data-menu > summary").click();
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入会话 JSON" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: "image-session.json", mimeType: "application/json", buffer: Buffer.from(exportedText) });
  await expect(page.getByRole("status")).toContainText("会话已导入");
  await expect(page.getByLabel("会话标题")).toHaveValue("image-session");
  await expect(page.locator(".session-row")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "IMG-REFRESH-IMAGE" })).toBeVisible();
  await expect(page.locator(".message-row--user-bubble p").filter({ hasText: "IMG-02-TEXT-REMAINS" })).toBeVisible();
  await expect(page.getByRole("img", { name: "IMG-MISSING-IMAGE" })).toHaveCount(1);
});
