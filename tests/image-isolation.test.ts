import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalImageStore } from "../extensions/pi-gpt-subagent/images";

const dataDir = await mkdtemp(path.join(tmpdir(), "pi-lab-image-isolation-"));

after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");

test("image collection records remain isolated by session scope", async () => {
  const root = dataDir;
  const imagePath = path.join(root, "fixture.png");
  await writeFile(imagePath, png);
  const sessionA = new LocalImageStore(root, "session-a");
  const sessionB = new LocalImageStore(root, "session-b");
  await sessionA.present("shared-name", [{ name: "A-only", path: imagePath }], root);
  await sessionB.present("shared-name", [{ name: "B-only", path: imagePath }], root);
  await sessionA.present("A-private", [{ name: "private-image", path: imagePath }], root);

  assert.deepEqual(await sessionA.list("shared-name"), { collection: "shared-name", images: ["A-only"] });
  assert.deepEqual(await sessionB.list("shared-name"), { collection: "shared-name", images: ["B-only"] });
  await assert.rejects(() => sessionB.list("A-private"), /找不到素材组「A-private」/);
  assert.deepEqual(await sessionA.list(), [
    { collection: "A-private", count: 1 },
    { collection: "shared-name", count: 1 },
  ]);
  assert.deepEqual(await sessionB.list(), [{ collection: "shared-name", count: 1 }]);
});
