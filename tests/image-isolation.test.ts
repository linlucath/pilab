import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalImageStore } from "../extensions/pi-gpt-subagent/images";
import { defaults } from "../shared/schema";

const dataDir = await mkdtemp(path.join(tmpdir(), "pi-lab-image-isolation-"));
process.env.PI_LAB_DATA_DIR = dataDir;
const { agentTools } = await import("../server/tools");

after(async () => {
  delete process.env.PI_LAB_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");

async function listImages(cwd: string, ownerSessionId: string, collection?: string) {
  const { tools } = await agentTools({ ...defaults, workingDirectory: cwd }, undefined, ownerSessionId);
  const tool = tools.find((item) => item.name === "list_images");
  assert.ok(tool, "list_images is registered");
  const result = await tool.execute(`list-${ownerSessionId}`, collection ? { collection } : {});
  const text = result.content[0];
  if (text.type !== "text") throw new Error("list_images must return text");
  return JSON.parse(text.text);
}

test("list_images only lists collection records owned by the current session", async () => {
  const root = dataDir;
  const imagePath = path.join(root, "fixture.png");
  await writeFile(imagePath, png);
  const sessionA = new LocalImageStore(root, "session-a");
  const sessionB = new LocalImageStore(root, "session-b");
  await sessionA.present("shared-name", [{ name: "A-only", path: imagePath }], root);
  await sessionB.present("shared-name", [{ name: "B-only", path: imagePath }], root);
  await sessionA.present("A-private", [{ name: "private-image", path: imagePath }], root);

  assert.deepEqual(await listImages(root, "session-a", "shared-name"), { collection: "shared-name", images: ["A-only"] });
  assert.deepEqual(await listImages(root, "session-b", "shared-name"), { collection: "shared-name", images: ["B-only"] });
  await assert.rejects(() => listImages(root, "session-b", "A-private"), /找不到素材组「A-private」/);
  assert.deepEqual(await listImages(root, "session-a"), [
    { collection: "A-private", count: 1 },
    { collection: "shared-name", count: 1 },
  ]);
  assert.deepEqual(await listImages(root, "session-b"), [{ collection: "shared-name", count: 1 }]);
});
