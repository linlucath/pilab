import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaults, type Message } from "../shared/schema";
import { createViewImageTool, latestImageContext, LocalImageStore } from "../extensions/pi-gpt-subagent/images";

const dataDirectory = await mkdtemp(path.join(tmpdir(), "pi-lab-view-image-data-"));
process.env.PI_LAB_DATA_DIR = dataDirectory;
const { generate } = await import("../server/engine");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");

after(async () => {
  delete process.env.PI_LAB_DATA_DIR;
  await rm(dataDirectory, { recursive: true, force: true });
});

function imageTool(root: string, cwd: string) {
  return createViewImageTool(() => new LocalImageStore(root), () => cwd);
}

test("view_image loads an image from a workspace-relative path as a model image block", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-lab-view-relative-"));
  const cwd = path.join(root, "workspace");
  await mkdir(path.join(cwd, "assets"), { recursive: true });
  await writeFile(path.join(cwd, "assets", "sample.png"), png);
  const tool = imageTool(root, cwd);
  try {
    assert.equal(tool.name, "view_image");
    assert.deepEqual((tool.parameters as any).required, ["path"]);
    assert.equal((tool.parameters as any).additionalProperties, false);
    const result = await tool.execute("call-relative", { path: "assets/sample.png" });
    const image = result.content.find((block) => block.type === "image");
    assert.deepEqual(image, { type: "image", data: png.toString("base64"), mimeType: "image/png" });
    assert.equal(result.content[0].type, "text");
    assert.match((result.content[0] as { text: string }).text, /已成功读取图片.*图片已加载至上下文/);
    assert.equal((result.details as any).piLabImages[0].mimeType, "image/png");
    await assert.rejects(
      tool.execute("call-no-vision", { path: "assets/sample.png" }, undefined, undefined, { model: { input: ["text"] } } as any),
      /当前模型不支持图片/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("view_image accepts an absolute path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-lab-view-absolute-"));
  const cwd = path.join(root, "workspace");
  const absoluteFile = path.join(root, "outside-workspace", "absolute.jpeg");
  await mkdir(cwd, { recursive: true });
  await mkdir(path.dirname(absoluteFile), { recursive: true });
  // The PNG bytes are deliberately stored under .jpeg to verify extension/content validation.
  await writeFile(absoluteFile, png);
  try {
    await assert.rejects(imageTool(root, cwd).execute("call-absolute-mismatch", { path: absoluteFile }), /扩展名与文件内容不匹配/);
    const pngFile = path.join(path.dirname(absoluteFile), "absolute.png");
    await writeFile(pngFile, await readFile(absoluteFile));
    const result = await imageTool(root, cwd).execute("call-absolute", { path: pngFile });
    assert.ok(result.content.some((block) => block.type === "image" && block.mimeType === "image/png"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("only the newest tool image remains attached to future context", () => {
  const imageReference = (hash: string) => {
    const digest = hash.repeat(64);
    return { file: `files/${digest}.png`, id: digest, name: "sample.png", kind: "image", mimeType: "image/png", width: 1, height: 1 };
  };
  const messages = ["a", "b"].map((hash) => ({
    role: "toolResult",
    content: [{ type: "text", text: hash }, { type: "image", data: hash, mimeType: "image/png" }],
    details: { piLabImages: [imageReference(hash)] },
  }));
  const context = latestImageContext(messages);
  assert.equal(context[0].content?.length, 1);
  assert.equal(context[1].content?.length, 2);
});

test("view_image reports missing paths and rejects non-image or malformed image files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-lab-view-invalid-"));
  const cwd = path.join(root, "workspace");
  await mkdir(cwd, { recursive: true });
  await writeFile(path.join(cwd, "notes.txt"), "not an image");
  await writeFile(path.join(cwd, "fake.png"), "not a PNG");
  const tool = imageTool(root, cwd);
  try {
    await assert.rejects(tool.execute("call-missing", { path: "missing.png" }), /找不到图片文件/);
    await assert.rejects(tool.execute("call-text", { path: "notes.txt" }), /仅支持 PNG、JPG、JPEG、WebP 和 GIF/);
    await assert.rejects(tool.execute("call-fake", { path: "fake.png" }), /请提交 PNG、JPEG、WebP、GIF 或 BMP/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function modelReply(res: ServerResponse, call?: { name: string; arguments: object }) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunks = call
    ? [
        { delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_view_image", type: "function", function: { name: call.name, arguments: "" } }] }, finish_reason: null },
        { delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(call.arguments) } }] }, finish_reason: null },
        { delta: {}, finish_reason: "tool_calls" },
      ]
    : [{ delta: { role: "assistant", content: "IMAGE_CONTEXT_RECEIVED" }, finish_reason: null }, { delta: {}, finish_reason: "stop" }];
  for (const chunk of chunks)
    res.write(`data: ${JSON.stringify({ id: "view-image-test", object: "chat.completion.chunk", model: "test-model", choices: [{ index: 0, ...chunk }], ...(chunk.finish_reason ? { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } } : {}) })}\n\n`);
  res.end("data: [DONE]\n\n");
}

test("engine feeds view_image output into the next request and preserves a lightweight tool result", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-lab-view-image-engine-"));
  await writeFile(path.join(cwd, "visual.png"), png);
  const requests: Record<string, any>[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    modelReply(res, requests.length === 1 ? { name: "view_image", arguments: { path: "visual.png" } } : undefined);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as import("node:net").AddressInfo;
  const events: Record<string, any>[] = [];
  const messages: Message[] = [{ id: "user", role: "user", content: "Inspect visual.png", enabled: true }];
  try {
    await generate({
      settings: { ...defaults, baseUrl: `http://127.0.0.1:${address.port}/v1`, workingDirectory: cwd },
      messages,
    }, (event) => events.push(event));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(cwd, { recursive: true, force: true });
  }

  assert.equal(requests.length, 2);
  const toolResult = requests[1].messages.find((message: any) => message.role === "tool" && message.tool_call_id === "call_view_image");
  assert.ok(toolResult, "second model turn receives the view_image tool result");
  assert.match(JSON.stringify(toolResult.content), /已成功读取图片/);
  const attachedImageMessage = requests[1].messages.find((message: any) => message.role === "user" &&
    Array.isArray(message.content) && message.content.some((block: any) => block.type === "image_url"));
  assert.ok(attachedImageMessage, "image is appended to the model context as a multimodal user block");
  assert.match(JSON.stringify(attachedImageMessage.content), /data:image\/png;base64,/);
  assert.ok(!JSON.stringify(events).includes(png.toString("base64")), "UI stream does not leak image Base64");
  const saved = events.find((event) => event.type === "message" && event.message.role === "tool");
  assert.equal(saved?.message.images?.length, 1, "tool history stores a local image reference for the UI");
  assert.match(saved?.message.content || "", /已成功读取图片/);
  assert.equal(events.at(-1)?.type, "done");
});
