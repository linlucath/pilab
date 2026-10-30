import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";

export interface ImageReference {
  file: string;
  id?: string;
  size?: number;
  name: string;
  kind: "image" | "overview";
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "image/bmp";
  width: number;
  height: number;
}

const maxFileBytes = 20 * 1024 * 1024;
export const imageFilePattern = /^(files|previews)\/[a-f0-9]{64}\.(png|jpg|webp|gif|bmp)$/;
const readerExtensions: Record<string, ImageReference["mimeType"]> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function photon() {
  return createRequire(path.join(getPackageDir(), "package.json"))("@silvia-odwyer/photon-node") as typeof import("@silvia-odwyer/photon-node");
}

function mime(bytes: Uint8Array): { mimeType: ImageReference["mimeType"]; extension: string } {
  const data = Buffer.from(bytes);
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mimeType: "image/png", extension: "png" };
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return { mimeType: "image/jpeg", extension: "jpg" };
  if (data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") return { mimeType: "image/webp", extension: "webp" };
  if (/^GIF8[79]a$/.test(data.toString("ascii", 0, 6))) return { mimeType: "image/gif", extension: "gif" };
  if (data.toString("ascii", 0, 2) === "BM") return { mimeType: "image/bmp", extension: "bmp" };
  throw new Error("请提交 PNG、JPEG、WebP、GIF 或 BMP 图片。");
}

async function atomic(file: string, data: Uint8Array) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Stores image bytes by content hash for existing message/upload references. */
export class LocalImageStore {
  readonly directory: string;

  constructor(readonly projectRoot: string) {
    this.directory = path.join(path.resolve(projectRoot), ".pi-lab", "images");
  }

  filePath(file: string) {
    if (!imageFilePattern.test(file)) throw new Error("图片引用无效。");
    return path.join(this.directory, file);
  }

  async saveImage(bytes: Uint8Array, name: string): Promise<ImageReference> {
    if (!bytes.length || bytes.length > maxFileBytes) throw new Error("单张图片大小必须在 20 MB 以内。");
    const { mimeType, extension } = mime(bytes);
    let width = 0, height = 0;
    try {
      const image = photon().PhotonImage.new_from_byteslice(bytes);
      try {
        width = image.get_width();
        height = image.get_height();
      } finally {
        image.free();
      }
    } catch {
      throw new Error("图片文件无法解码，请提供有效的 PNG、JPEG、WebP、GIF 或 BMP 文件。");
    }
    if (!width || !height || width * height > 40_000_000) throw new Error("图片像素过大，请先缩小至 4,000 万像素以内。");

    const id = createHash("sha256").update(bytes).digest("hex");
    const file = `files/${id}.${extension}`;
    await atomic(this.filePath(file), bytes);
    return { file, id, size: bytes.byteLength, name: name.slice(0, 100), kind: "image", mimeType, width, height };
  }

  async readImage(file: string, workingDirectory: string) {
    const extension = path.extname(file).toLowerCase();
    const expectedMime = readerExtensions[extension];
    if (!expectedMime) throw new Error("仅支持 PNG、JPG、JPEG、WebP 和 GIF 图片。");
    const absolutePath = path.resolve(workingDirectory, file);
    let info;
    try {
      info = await stat(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR")
        throw new Error(`找不到图片文件：${file}`);
      throw error;
    }
    if (!info.isFile()) throw new Error(`图片路径不是文件：${file}`);
    if (info.size > maxFileBytes) throw new Error("图片文件不能超过 20 MB。");

    const bytes = await readFile(absolutePath);
    if (!bytes.length || bytes.length > maxFileBytes) throw new Error("图片文件为空或超过 20 MB。");
    const detectedMime = mime(bytes).mimeType;
    if (detectedMime !== expectedMime)
      throw new Error(`图片扩展名与文件内容不匹配：${file}`);

    const reference = await this.saveImage(bytes, path.basename(absolutePath));
    return {
      reference,
      content: { type: "image" as const, data: bytes.toString("base64"), mimeType: detectedMime },
    };
  }

  async attachment(reference: ImageReference): Promise<ImageContent> {
    return {
      type: "image",
      data: (await readFile(this.filePath(reference.file))).toString("base64"),
      mimeType: reference.mimeType,
    };
  }
}

export function imageReferences(details: unknown): ImageReference[] {
  const refs = (details as { piLabImages?: unknown })?.piLabImages;
  return Array.isArray(refs) ? refs.filter((ref): ref is ImageReference =>
    !!ref && typeof ref.file === "string" && imageFilePattern.test(ref.file) && typeof ref.name === "string" &&
    ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"].includes(ref.mimeType) &&
    (ref.id === undefined || (typeof ref.id === "string" && /^[a-f0-9]{64}$/.test(ref.id))) &&
    (ref.size === undefined || (Number.isInteger(ref.size) && ref.size > 0 && ref.size <= maxFileBytes)) &&
    (ref.kind === "image" || ref.kind === "overview") && Number.isInteger(ref.width) && ref.width > 0 && Number.isInteger(ref.height) && ref.height > 0) : [];
}

export async function retainToolImages(
  store: LocalImageStore,
  result: { content: ({ type: string } & Record<string, any>)[]; details?: unknown },
  name: string,
) {
  if (imageReferences(result.details).length || !result.content.some((block) => block.type === "image")) return undefined;
  const references: ImageReference[] = [];
  const content = [];
  for (const block of result.content) {
    if (block.type !== "image") {
      content.push(block);
      continue;
    }
    if (references.length >= 2) continue;
    const reference = await store.saveImage(Buffer.from(block.data, "base64"), name);
    references.push(reference);
    content.push(block);
  }
  return {
    content: content as ({ type: "text"; text: string } | ImageContent)[],
    details: { ...(result.details as object ?? {}), piLabImages: references },
  };
}

/** Only the newest tool-result image is sent again; older references stay available in history and on disk. */
export function latestImageContext<T extends { role: string; content?: unknown; details?: unknown }>(messages: T[]): T[] {
  let latest = -1;
  messages.forEach((message, index) => {
    if (message.role === "toolResult" && imageReferences(message.details).length) latest = index;
  });
  return messages.map((message, index) => index !== latest && message.role === "toolResult" &&
    imageReferences(message.details).length && Array.isArray(message.content)
    ? { ...message, content: message.content.filter((block) => block.type !== "image") }
    : message);
}

interface ImageTool<TParameters extends TSchema> {
  name: string;
  label: string;
  description: string;
  parameters: TParameters;
  execute(
    id: string,
    args: Static<TParameters>,
    signal?: AbortSignal,
    update?: AgentToolUpdateCallback<unknown>,
    ctx?: ExtensionToolContext,
  ): Promise<AgentToolResult<unknown>>;
}

export function createViewImageTool(
  getStore: (ctx?: ExtensionToolContext) => LocalImageStore,
  getWorkingDirectory: (ctx?: ExtensionToolContext) => string = (ctx) => ctx?.cwd || process.cwd(),
) {
  const parameters = Type.Object({
    path: Type.String({
      minLength: 1,
      maxLength: 4000,
      description: "本地图片文件的相对或绝对路径（支持 png, jpg, jpeg, webp, gif）",
    }),
  }, { additionalProperties: false });
  const tool: ImageTool<typeof parameters> = {
    name: "view_image",
    label: "查看图片",
    description: "Read one local PNG, JPG, JPEG, WebP, or GIF file from an absolute path or a path relative to the workspace. The image is loaded into the current visual context; only the latest viewed image is kept in future model context.",
    parameters,
    execute: async (_id, args, signal, _update, ctx): Promise<AgentToolResult<unknown>> => {
      if (signal?.aborted) throw new Error("看图已取消。");
      if (ctx?.model && !ctx.model.input.includes("image")) throw new Error("当前模型不支持图片，请切换到支持图片的模型。");
      const { reference, content } = await getStore(ctx).readImage(args.path, getWorkingDirectory(ctx));
      return {
        content: [
          { type: "text", text: `已成功读取图片「${args.path}」，图片已加载至上下文。` },
          content,
        ],
        details: { piLabImages: [reference] },
      };
    },
  };
  return tool;
}
