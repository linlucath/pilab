import path from "node:path";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import { LocalImageStore } from "../extensions/pi-gpt-subagent/images";
import { MAX_IMAGE_BYTES, MAX_MESSAGE_IMAGE_BYTES, type Message } from "../shared/schema";
import { normalizeConsecutiveToolCallMessages, toPiMessage } from "./transcript";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imageRoot = process.env.PI_LAB_DATA_DIR || projectRoot;
// Inline message blobs are content-addressed and shared on disk; collection catalogs are session-scoped.
export const projectImages = new LocalImageStore(imageRoot, "pi-lab-inline-images");
export function imageStoreForSession(ownerSessionId: string) {
  return new LocalImageStore(imageRoot, ownerSessionId);
}

export async function restoreImageHistory(messages: Message[], model: Model<Api>, store = projectImages) {
  let latest = -1;
  messages.forEach((message, index) => { if (message.images?.length && ["tool", "user"].includes(message.role)) latest = index; });
  return normalizeConsecutiveToolCallMessages(await Promise.all(messages.map(async (message, index) => {
    const native = toPiMessage(message, model);
    if (index !== latest || !message.images?.length || (native.role !== "toolResult" && native.role !== "user")) return native;
    if (!model.input.includes("image")) return native;
    const sizes = await Promise.all(message.images.map(async (ref) => (await stat(store.filePath(ref.file))).size));
    if (sizes.some((size) => size > MAX_IMAGE_BYTES) || sizes.reduce((total, size) => total + size, 0) > MAX_MESSAGE_IMAGE_BYTES)
      throw new Error(`单条消息图片总大小不能超过 ${MAX_MESSAGE_IMAGE_BYTES / (1024 * 1024)} MiB。`);
    const attachments = await Promise.all(message.images.map((ref) => store.attachment(ref)));
    const content = typeof native.content === "string" ? [{ type: "text" as const, text: native.content }] : native.content;
    return { ...native, content: [...content, ...attachments] };
  })));
}
