import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { getPackageDir, resizeImage } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";

export interface ImageReference {
  file: string; id?: string; size?: number; name: string; collection?: string; kind: "image" | "overview";
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "image/bmp"; width: number; height: number;
}
interface Asset {
  collection: string; name: string; file: string; mimeType: ImageReference["mimeType"];
  width: number; height: number; source?: string; note?: string; created: number;
}
interface PresentedImage { name: string; path: string; source?: string; note?: string }
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const imageFilePattern = /^(files|previews)\/[a-f0-9]{64}\.(png|jpg|webp|gif|bmp)$/;
const maxFileBytes = 20 * 1024 * 1024;
function title(value: string) {
  const name = value.trim();
  if (!name || name.length > 100 || /[\r\n]/.test(name)) throw new Error("图片和素材组需要 1–100 字的名字。");
  return name;
}
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
async function atomic(file: string, data: string | Uint8Array) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

/** Content-addressed local originals and previews; per-name records avoid cross-process index races. */
export class LocalImageStore {
  readonly directory: string;
  constructor(readonly projectRoot: string) { this.directory = path.join(path.resolve(projectRoot), ".pi-lab", "images"); }
  private collectionDirectory(collection: string) { return path.join(this.directory, "collections", hash(title(collection))); }
  filePath(file: string) {
    if (!imageFilePattern.test(file)) throw new Error("图片引用无效。");
    return path.join(this.directory, file);
  }
  async saveImage(bytes: Uint8Array, name: string, kind: ImageReference["kind"] = "image", collection?: string): Promise<ImageReference> {
    if (!bytes.length || bytes.length > maxFileBytes) throw new Error("单张图片大小必须在 20 MB 以内。");
    const { mimeType, extension } = mime(bytes);
    const image = photon().PhotonImage.new_from_byteslice(bytes);
    let width: number, height: number;
    try { width = image.get_width(); height = image.get_height(); }
    finally { image.free(); }
    if (!width || !height || width * height > 40_000_000) throw new Error("图片像素过大，请先缩小至 4,000 万像素以内。");
    const id = hash(bytes);
    const file = `${kind === "overview" ? "previews" : "files"}/${id}.${extension}`;
    await atomic(this.filePath(file), bytes);
    return { file, id, size: bytes.byteLength, name, kind, mimeType, width, height, ...(collection ? { collection } : {}) };
  }
  async present(collection: string, images: PresentedImage[], cwd: string) {
    collection = title(collection);
    if (!images.length || images.length > 12) throw new Error("一次提交 1–12 张图片。");
    const names = images.map((image) => title(image.name));
    if (new Set(names).size !== names.length) throw new Error("同一素材组内的图片名字不能重复。");
    const staged: Asset[] = [];
    for (const [index, item] of images.entries()) {
      const file = path.resolve(cwd, item.path);
      const info = await stat(file);
      if (!info.isFile() || info.size > maxFileBytes) throw new Error(`图片「${names[index]}」不是 20 MB 以内的文件。`);
      const ref = await this.saveImage(await readFile(file), names[index], "image", collection);
      staged.push({ ...ref, collection, source: item.source?.slice(0, 2_000), note: item.note?.slice(0, 160), created: Date.now() + index });
    }
    for (const asset of staged) {
      const record = path.join(this.collectionDirectory(collection), `${hash(asset.name)}.json`);
      try { asset.created = JSON.parse(await readFile(record, "utf8")).created; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await atomic(record, JSON.stringify(asset));
    }
    return { collection, images: names };
  }
  async assets(collection: string): Promise<Asset[]> {
    let files: string[];
    try { files = await readdir(this.collectionDirectory(collection)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`找不到素材组「${collection}」。`);
      throw error;
    }
    const assets = await Promise.all(files.filter((file) => /^[a-f0-9]{64}\.json$/.test(file)).map(async (file) => {
      const asset = JSON.parse(await readFile(path.join(this.collectionDirectory(collection), file), "utf8")) as Asset;
      this.filePath(asset.file);
      return asset;
    }));
    return assets.sort((a, b) => a.created - b.created || a.name.localeCompare(b.name));
  }
  async list(collection?: string) {
    if (collection) return { collection, images: (await this.assets(collection)).map(({ name }) => name).slice(0, 40) };
    const directory = path.join(this.directory, "collections");
    const directories = await readdir(directory).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    const groups = [];
    for (const group of directories.filter((file) => /^[a-f0-9]{64}$/.test(file))) {
      const files = (await readdir(path.join(directory, group))).filter((file) => /^[a-f0-9]{64}\.json$/.test(file));
      if (files.length) {
        const first = JSON.parse(await readFile(path.join(directory, group, files[0]), "utf8")) as Asset;
        groups.push({ collection: first.collection, count: files.length });
      }
      if (groups.length >= 30) break;
    }
    return groups;
  }
  async attachment(ref: ImageReference): Promise<ImageContent> {
    return { type: "image", data: (await readFile(this.filePath(ref.file))).toString("base64"), mimeType: ref.mimeType };
  }
  async view(collection: string, names?: string[], original = false) {
    collection = title(collection);
    const assets = await this.assets(collection);
    if (original && (!names?.length || names.length > 2)) throw new Error("看细节时请按名字选择 1–2 张图片。");
    if (names && (!names.length || names.length > 6 || new Set(names).size !== names.length)) throw new Error("一次选择 1–6 张不同的图片。");
    const selected = names ? names.map((name) => {
      const asset = assets.find((asset) => asset.name === name);
      if (!asset) throw new Error(`素材组「${collection}」中找不到「${name}」。`);
      return asset;
    }) : assets.slice(0, 6);
    if (!selected.length) throw new Error("素材组中还没有图片。");
    const references: ImageReference[] = [];
    if (original) {
      for (const asset of selected) {
        const resized = await resizeImage(await readFile(this.filePath(asset.file)), asset.mimeType, { maxWidth: 2048, maxHeight: 2048, maxBytes: 1_200_000 });
        if (!resized) throw new Error(`无法生成「${asset.name}」的细节图。`);
        references.push(await this.saveImage(Buffer.from(resized.data, "base64"), asset.name, "image", collection));
      }
    } else {
      const p = photon();
      const columns = Math.min(3, selected.length), rows = Math.ceil(selected.length / columns);
      const cellWidth = 384, cellHeight = 292, gap = 12;
      const width = columns * (cellWidth + gap) + gap, height = rows * (cellHeight + gap) + gap;
      const pixels = new Uint8Array(width * height * 4).fill(246);
      for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
      const sheet = new p.PhotonImage(pixels, width, height);
      try {
        for (const [index, asset] of selected.entries()) {
          const small = await resizeImage(await readFile(this.filePath(asset.file)), asset.mimeType, { maxWidth: cellWidth, maxHeight: 256, maxBytes: 350_000 });
          if (!small) throw new Error(`无法生成「${asset.name}」的缩略图。`);
          const tile = p.PhotonImage.new_from_byteslice(Buffer.from(small.data, "base64"));
          const left = gap + (index % columns) * (cellWidth + gap);
          const top = gap + Math.floor(index / columns) * (cellHeight + gap);
          try { p.watermark(sheet, tile, BigInt(left + Math.floor((cellWidth - small.width) / 2)), BigInt(top + Math.floor((256 - small.height) / 2))); }
          finally { tile.free(); }
          p.draw_text_with_border(sheet, String(index + 1), left + 8, top + 262, 22);
        }
        references.push(await this.saveImage(sheet.get_bytes_jpeg(82), collection, "overview", collection));
      } finally { sheet.free(); }
    }
    const text = original
      ? `${collection} · 细节图：${selected.map((asset) => asset.name).join("、")}`
      : `${collection} · ${selected.map((asset, index) => `${index + 1}=${asset.name}`).join("；")}${!names && assets.length > 6 ? `（共 ${assets.length} 张，本次显示前 6 张）` : ""}`;
    return { content: [{ type: "text" as const, text }, ...await Promise.all(references.map((ref) => this.attachment(ref)))], details: { piLabImages: references } };
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

export async function retainToolImages(store: LocalImageStore, result: { content: ({ type: string } & Record<string, any>)[]; details?: unknown }, name: string) {
  if (imageReferences(result.details).length || !result.content.some((block) => block.type === "image")) return undefined;
  const references: ImageReference[] = [];
  const content = [];
  for (const block of result.content) {
    if (block.type !== "image") { content.push(block); continue; }
    if (references.length >= 2) continue;
    const ref = await store.saveImage(Buffer.from(block.data, "base64"), name);
    references.push(ref);
    content.push(block);
  }
  return { content: content as ({ type: "text"; text: string } | ImageContent)[], details: { ...(result.details as object ?? {}), piLabImages: references } };
}

/** Keep pixels for just the latest explicitly viewed tool result; history and disk references stay intact. */
export function latestImageContext<T extends { role: string; content?: unknown; details?: unknown }>(messages: T[]): T[] {
  let latest = -1;
  messages.forEach((message, index) => { if (message.role === "toolResult" && imageReferences(message.details).length) latest = index; });
  return messages.map((message, index) => index !== latest && message.role === "toolResult" && imageReferences(message.details).length && Array.isArray(message.content)
    ? { ...message, content: message.content.filter((block) => block.type !== "image") } : message);
}

interface ImageTool<TParameters extends TSchema> {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  parameters: TParameters;
  execute(id: string, args: Static<TParameters>, signal?: AbortSignal, update?: AgentToolUpdateCallback<unknown>, ctx?: ExtensionToolContext): Promise<AgentToolResult<unknown>>;
}

export function createImageTools(getStore: (ctx?: ExtensionToolContext) => LocalImageStore, role: "viewer" | "publisher") {
  const group = Type.String({ minLength: 1, maxLength: 100, description: "A memorable local image collection name." });
  if (role === "publisher") {
    const parameters = Type.Object({ collection: group, images: Type.Array(Type.Object({
      name: group, path: Type.String({ minLength: 1, maxLength: 4000 }),
      source: Type.Optional(Type.String({ maxLength: 2000 })), note: Type.Optional(Type.String({ maxLength: 160 })),
    }, { additionalProperties: false }), { minItems: 1, maxItems: 12 }) }, { additionalProperties: false });
    const tool: ImageTool<typeof parameters> = {
    name: "present_images", label: "提交图片素材",
    description: "Copy existing local images into the project's durable image library. Give the collection and each image short, unique names. Include source URLs when known. Returns names only; no images or logs are sent to the coordinator. After publishing, report only the collection name and count, then wait for visual feedback.",
    promptSnippet: "Submit named local images for the coordinator to review on demand",
    parameters,
    execute: async (_id, args, signal, _update, ctx): Promise<AgentToolResult<unknown>> => {
      if (signal?.aborted) throw new Error("图片提交已取消。");
      const result = await getStore(ctx).present(args.collection, args.images, ctx?.cwd || process.cwd());
      return { content: [{ type: "text" as const, text: `${result.collection} · 已保存 ${result.images.length} 张：${result.images.join("、")}` }], details: result };
    },
    };
    return [tool];
  }
  const viewParameters = Type.Object({ collection: group, names: Type.Optional(Type.Array(group, { minItems: 1, maxItems: 6 })), original: Type.Optional(Type.Boolean()) }, { additionalProperties: false });
  const viewTool: ImageTool<typeof viewParameters> = {
    name: "view_images", label: "看图片",
    description: "View a named local collection for visual judgment. Default: ONE numbered overview, up to 6 thumbnails. For detail, select 1–2 names and set original=true. Only the latest view stays attached to model requests; earlier views remain on disk. Request images only when visual judgment is needed. Delegate sourcing/rendering to GPT and ask it to use present_images. Do not repeatedly view unchanged images.",
    promptSnippet: "View a small image overview or selected details only when needed for visual judgment",
    parameters: viewParameters,
    execute: async (_id, args, signal, _update, ctx): Promise<AgentToolResult<unknown>> => {
      if (signal?.aborted) throw new Error("看图已取消。");
      if (ctx?.model && !ctx.model.input.includes("image")) throw new Error("当前模型不支持图片，请切换到支持图片的模型。");
      return getStore(ctx).view(args.collection, args.names, args.original ?? false);
    },
  };
  const listParameters = Type.Object({ collection: Type.Optional(group) }, { additionalProperties: false });
  const listTool: ImageTool<typeof listParameters> = {
    name: "list_images", label: "图片素材",
    description: "List local image collection names and counts, or image names in one collection. Does not attach any images. Use only when you need to find saved material; do not enumerate the library each turn.",
    parameters: listParameters,
    execute: async (_id, args, _signal, _update, ctx): Promise<AgentToolResult<unknown>> => {
      const result = await getStore(ctx).list(args.collection);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
    },
  };
  return [viewTool, listTool];
}
