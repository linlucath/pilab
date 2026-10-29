import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaults, messageSchema, type Message } from "../shared/schema";

const dataDir = await mkdtemp(path.join(tmpdir(), "pi-lab-image-input-"));
process.env.PI_LAB_DATA_DIR = dataDir;
const { generate } = await import("../server/engine");
const { projectImages } = await import("../server/images");

after(async () => {
  delete process.env.PI_LAB_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

test("message schema accepts a normal multi-image set and rejects count/aggregate abuse", () => {
  const reference = {
    file: `files/${"a".repeat(64)}.png`, name: "same-image", kind: "image" as const,
    mimeType: "image/png" as const, width: 1, height: 1, size: 1,
  };
  const message = (images: typeof reference[]) => ({ id: "multi", role: "user", content: "", enabled: true, images });
  assert.equal(messageSchema.safeParse(message(Array.from({ length: 8 }, () => reference))).success, true);
  assert.equal(messageSchema.safeParse(message(Array.from({ length: 9 }, () => reference))).success, false);
  assert.equal(messageSchema.safeParse(message(Array.from({ length: 3 }, () => ({ ...reference, size: 20 * 1024 * 1024 })))).success, false);
});

test("Gemini-compatible completion serializes image references as image_url without echoing base64", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
  const image = await projectImages.saveImage(png, "tiny.png");
  let received: Record<string, any> | undefined;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received = JSON.parse(body);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end([
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "seen" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as import("node:net").AddressInfo;
  const events: Record<string, any>[] = [];
  const message: Message = { id: "image-only", role: "user", content: "", enabled: true, images: [image, image, image] };
  try {
    await generate({
      settings: { ...defaults, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "gemini-test", reasoningEffort: "off", workingDirectory: process.cwd() },
      messages: [message],
    }, (event) => events.push(event));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.ok(received, "mock Gemini-compatible endpoint received the request");
  const user = received!.messages.find((item: any) => item.role === "user");
  assert.ok(Array.isArray(user.content), "multimodal user content is serialized as parts");
  const imageParts = user.content.filter((part: any) => part.type === "image_url");
  assert.equal(imageParts.length, 3, "all images in the accepted message survive the transport conversion");
  assert.ok(imageParts.every((part: any) => part.image_url.url === `data:image/png;base64,${png.toString("base64")}`));
  assert.ok(image.id && image.size === png.length, "upload reference includes a stable id and byte size");

  const inspected = events.find((event) => event.type === "request");
  assert.ok(inspected, "request inspector event was emitted");
  assert.doesNotMatch(JSON.stringify(inspected), new RegExp(png.toString("base64")));
  assert.match(JSON.stringify(inspected), /base64 image omitted/);
});
