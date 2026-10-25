import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import { LocalImageStore } from "../extensions/pi-gpt-subagent/images";
import type { Message } from "../shared/schema";
import { toPiMessage } from "./transcript";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const projectImages = new LocalImageStore(process.env.PI_LAB_DATA_DIR || projectRoot);

export async function restoreImageHistory(messages: Message[], model: Model<Api>) {
  let latest = -1;
  messages.forEach((message, index) => { if (message.images?.length && ["tool", "user"].includes(message.role)) latest = index; });
  return Promise.all(messages.map(async (message, index) => {
    const native = toPiMessage(message, model);
    if (index !== latest || !message.images?.length || (native.role !== "toolResult" && native.role !== "user")) return native;
    if (!model.input.includes("image")) return native;
    const attachments = await Promise.all(message.images.slice(0, 2).map((ref) => projectImages.attachment(ref)));
    const content = typeof native.content === "string" ? [{ type: "text" as const, text: native.content }] : native.content;
    return { ...native, content: [...content, ...attachments] };
  }));
}
