import { test, expect } from "@playwright/test";
import { prepareE2eWorkspace } from "./fixtures/index";

const imageFile = `files/${"a".repeat(64)}.png`;
const missingImageFile = `files/${"b".repeat(64)}.png`;
const validPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/XioAAAAASUVORK5CYII=", "base64");
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

test("IMG-03 刷新及导入后恢复项目图片引用，导出不内嵌原图", async ({ page }) => {
  await mockImageFiles(page);
  await seedImageSession(page);
  await expect(page.getByRole("button", { name: "IMG-REFRESH-IMAGE" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("button", { name: "IMG-REFRESH-IMAGE" })).toBeVisible();
  await expect(page.locator(".message-row--user-bubble p").filter({ hasText: "IMG-02-TEXT-REMAINS" })).toBeVisible();
  await expect(page.getByRole("img", { name: "IMG-MISSING-IMAGE" })).toHaveCount(1);

  await page.getByRole("button", { name: "高级设置与调试" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出会话 JSON" }).click();
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

  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入 JSON" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: "image-session.json", mimeType: "application/json", buffer: Buffer.from(exportedText) });
  await expect(page.getByRole("status")).toContainText("会话已导入");
  await expect(page.getByLabel("会话标题")).toHaveValue("image-session");
  await expect(page.locator(".session-row")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "IMG-REFRESH-IMAGE" })).toBeVisible();
  await expect(page.locator(".message-row--user-bubble p").filter({ hasText: "IMG-02-TEXT-REMAINS" })).toBeVisible();
  await expect(page.getByRole("img", { name: "IMG-MISSING-IMAGE" })).toHaveCount(1);
});
