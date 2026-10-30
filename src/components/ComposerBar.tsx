import { useEffect, useRef, useState } from "react";
import type { ClipboardEvent as ClipboardEventType, DragEvent as DragEventType } from "react";
import { AlertTriangle, ArrowUp, ChevronDown, Cpu, ImagePlus, LoaderCircle, Plus, RotateCw, RotateCcw, Sparkles, Square, UserRound, Wrench, X } from "lucide-react";
import { imageReferenceSchema, MAX_IMAGE_BYTES, MAX_MESSAGE_IMAGES, MAX_MESSAGE_IMAGE_BYTES, type Message, type Settings } from "../../shared/schema";
import { ComposerModelControls, type ModelOption } from "./ComposerModelControls";
import type { GptSessionSummary } from "../../shared/gpt-sessions";

type WakeNotice = { names: string[] };
type ImageReference = NonNullable<Message["images"]>[number];
type StagedImage = {
  key: string; file: File; previewUrl: string; status: "uploading" | "ready" | "error";
  reference?: ImageReference; error?: string;
};
type Props = {
  busy: boolean; blocked?: boolean; workerMode?: boolean; placeholder?: string; toolName?: string; messageCount: number; contextTokens: number; savedPercent: number;
  settings: Pick<Settings, "protocol" | "model" | "reasoning" | "reasoningEffort">; models: ModelOption[]; defaultModel?: string; piConnected?: boolean;
  onSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void; onNotice: (message: string) => void; onRefreshModels: () => void;
  backgroundWorkers?: GptSessionSummary[];
  wakeNotice?: WakeNotice | null; onDismissWake?: () => void; onReviewWorkers?: () => void;
  onSend: (content: string, role: Message["role"], run: boolean, images?: Message["images"]) => boolean | void | Promise<boolean | void>;
  onRun: () => void; onStop: () => void;
};
const composerRoles: Message["role"][] = ["user", "assistant", "system"];
const supportedImageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"]);
const imageExtension = /\.(png|jpe?g|webp|gif|bmp)$/i;
const roleIcon = (role: Message["role"]) => role === "assistant" ? <Sparkles size={14} /> : role === "system" ? <Cpu size={14} /> : <UserRound size={14} />;
const looksLikeImage = (file: File) => file.type.startsWith("image/") || (!file.type && imageExtension.test(file.name));

export function ComposerBar({ busy, blocked, workerMode = false, placeholder, toolName, messageCount, contextTokens, savedPercent, settings, models, defaultModel, piConnected, onSetting, onNotice, onRefreshModels, backgroundWorkers = [], wakeNotice, onDismissWake, onReviewWorkers, onSend, onRun, onStop }: Props) {
  const tokenLabel = contextTokens >= 10_000 ? `${(contextTokens / 1000).toFixed(1)}k` : contextTokens.toLocaleString();
  const usageLabel = `~${tokenLabel} tokens`;
  const usageTitle = `${messageCount} 条消息 · 按消息、思考过程及工具参数估算`;
  const [role, setRole] = useState<Message["role"]>("user");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [stagedImages, setStagedImages] = useState<StagedImage[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);
  const dragDepth = useRef(0);
  const stagedRef = useRef<StagedImage[]>([]);
  const uploads = useRef(new Map<string, AbortController>());
  const replaceStaged = (next: StagedImage[]) => { stagedRef.current = next; setStagedImages(next); };
  const updateStaged = (key: string, patch: Partial<StagedImage>) => {
    const current = stagedRef.current;
    if (!current.some((image) => image.key === key)) return;
    replaceStaged(current.map((image) => image.key === key ? { ...image, ...patch } : image));
  };
  useEffect(() => { const node = input.current; if (!node) return; node.style.height = "auto"; node.style.height = `${Math.min(node.scrollHeight, 180)}px`; }, [draft]);
  useEffect(() => () => {
    for (const image of stagedRef.current) URL.revokeObjectURL(image.previewUrl);
    for (const controller of uploads.current.values()) controller.abort();
  }, []);

  const uploadImage = async (image: StagedImage) => {
    const controller = new AbortController();
    uploads.current.set(image.key, controller);
    updateStaged(image.key, { status: "uploading", error: undefined });
    try {
      const query = new URLSearchParams({ name: image.file.name.slice(0, 100) || "粘贴图片" });
      const response = await fetch(`/api/images/upload?${query}`, {
        method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: image.file, signal: controller.signal,
      });
      const result = await response.json().catch(() => ({})) as { image?: unknown; error?: string };
      if (!response.ok) throw new Error(result.error || `图片上传失败（HTTP ${response.status}）`);
      const reference = imageReferenceSchema.parse(result.image);
      if (reference.size !== image.file.size) throw new Error("图片上传大小校验失败，请重试。");
      updateStaged(image.key, { status: "ready", reference, error: undefined });
    } catch (error) {
      if (controller.signal.aborted) return;
      updateStaged(image.key, { status: "error", error: error instanceof Error ? error.message : "图片上传失败。" });
    } finally {
      if (uploads.current.get(image.key) === controller) uploads.current.delete(image.key);
    }
  };

  const addFiles = (files: File[]) => {
    if (workerMode) { setAttachmentError("工兵指导目前只支持文本消息。"); return; }
    const accepted: StagedImage[] = [];
    const errors: string[] = [];
    let totalBytes = stagedRef.current.reduce((total, image) => total + image.file.size, 0);
    let count = stagedRef.current.length;
    for (const file of files) {
      if (!looksLikeImage(file) || (file.type && !supportedImageTypes.has(file.type))) {
        errors.push(`「${file.name || "文件"}」不是支持的 PNG、JPEG、WebP、GIF 或 BMP 图片。`);
        continue;
      }
      if (!file.size || file.size > MAX_IMAGE_BYTES) {
        errors.push(`「${file.name || "图片"}」大小必须在 1–20 MiB 以内。`);
        continue;
      }
      if (role !== "user") {
        errors.push("图片只能附加到 User 消息；请先切换角色或清空图片托盘。");
        continue;
      }
      if (count >= MAX_MESSAGE_IMAGES) {
        errors.push(`单条消息最多附加 ${MAX_MESSAGE_IMAGES} 张图片。`);
        continue;
      }
      if (totalBytes + file.size > MAX_MESSAGE_IMAGE_BYTES) {
        errors.push(`单条消息图片总大小不能超过 ${MAX_MESSAGE_IMAGE_BYTES / (1024 * 1024)} MiB。`);
        continue;
      }
      const item: StagedImage = { key: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file), status: "uploading" };
      accepted.push(item);
      count++;
      totalBytes += file.size;
    }
    if (accepted.length) {
      replaceStaged([...stagedRef.current, ...accepted]);
      setAttachmentError("");
      for (const image of accepted) void uploadImage(image);
    }
    if (errors.length) setAttachmentError(errors.join(" "));
  };
  const removeImage = (key: string) => {
    uploads.current.get(key)?.abort();
    uploads.current.delete(key);
    const item = stagedRef.current.find((image) => image.key === key);
    if (item) URL.revokeObjectURL(item.previewUrl);
    replaceStaged(stagedRef.current.filter((image) => image.key !== key));
    setAttachmentError("");
  };
  const clearImages = () => {
    for (const image of stagedRef.current) {
      uploads.current.get(image.key)?.abort();
      URL.revokeObjectURL(image.previewUrl);
    }
    uploads.current.clear();
    replaceStaged([]);
    setAttachmentError("");
  };
  const submit = async (run: boolean) => {
    const current = stagedRef.current;
    if ((!draft.trim() && !current.length) || busy || blocked || sending) return;
    if (role !== "user" && current.length) { setAttachmentError("图片只能作为 User 消息发送，请先切换角色或删除图片。"); return; }
    if (current.some((image) => image.status === "uploading")) { setAttachmentError("图片仍在上传，请稍候完成后再发送。"); return; }
    if (current.some((image) => image.status !== "ready" || !image.reference)) { setAttachmentError("图片上传失败，请重试或删除失败图片后再发送。"); return; }
    const references = current.map((image) => image.reference!);
    setSending(true);
    try {
      if (await onSend(draft.trim(), workerMode ? "user" : role, workerMode || run, references) === false) return;
      setDraft("");
      clearImages();
    } finally { setSending(false); }
  };
  const hasFileDrag = (transfer: DataTransfer) => Array.from(transfer.types).includes("Files");
  const onPaste = (event: ClipboardEventType<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (!files.some(looksLikeImage)) return;
    event.preventDefault();
    addFiles(files);
  };
  const onDrop = (event: DragEventType<HTMLDivElement>) => {
    if (!hasFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    addFiles(Array.from(event.dataTransfer.files));
  };
  const canSend = !!draft.trim() || stagedImages.length > 0;

  return <footer className="composer-bar">
    {!workerMode && !busy && backgroundWorkers.length > 0 && <div className="background-task-bar" aria-label="后台 GPT 工兵状态"><strong><Cpu size={14} />后台工兵并行中</strong><div>{backgroundWorkers.map((worker) => { const activeTool = worker.recentTools.find((tool) => tool.status === "running"); return <span className="background-task-item" key={worker.id}><b>{worker.role || worker.name}</b><small>{worker.status === "waiting_input" ? "等待输入" : activeTool ? `正在执行 ${activeTool.name}…` : worker.status === "starting" ? "正在启动…" : "正在工作…"}</small></span>; })}</div></div>}
    {!workerMode && wakeNotice && <div className="worker-wake-banner" role="status"><span><Sparkles size={14} />{wakeNotice.names.length > 1 ? `${wakeNotice.names.length} 个 GPT 工兵` : `工兵「${wakeNotice.names[0]}」`}已交卷！{busy ? " · 主模型运行中，结束后可手动审阅" : draft.trim() ? " · 审阅不会清除输入草稿" : " · 需要时手动审阅"}</span><div><button className="wake-review-button" disabled={busy || blocked} onClick={() => onReviewWorkers?.()}>✨ 让 Gemini 审阅汇报</button><button className="wake-dismiss-button" aria-label="忽略工兵交卷提醒" title="忽略提醒，不会停止工兵" onClick={() => onDismissWake?.()}>忽略</button></div></div>}
    {busy ? <div className="composer-running"><LoaderCircle size={15} className="spin" /><span>{toolName ? <><Wrench size={13} />正在执行 {toolName}…</> : "✨ Gemini 正在思考…"}</span><small className="running-context-count" title={usageTitle}>{usageLabel}{savedPercent > 0 ? ` · 已省 ${savedPercent}%` : ""}</small><button className="stop-button" onClick={onStop}><Square size={13} fill="currentColor" />停止</button></div> : <div className={`composer-card ${dragOver ? "is-drag-over" : ""}`}
      onDragEnter={(event) => { if (!hasFileDrag(event.dataTransfer)) return; event.preventDefault(); dragDepth.current++; setDragOver(true); }}
      onDragOver={(event) => { if (hasFileDrag(event.dataTransfer)) event.preventDefault(); }}
      onDragLeave={(event) => { if (!hasFileDrag(event.dataTransfer)) return; event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragOver(false); }}
      onDrop={onDrop}>
      {dragOver && <div className="composer-drop-overlay" aria-hidden="true"><ImagePlus size={22} /><strong>松开即可添加图片</strong><small>支持 PNG · JPEG · WebP · GIF · BMP</small></div>}
      {!!stagedImages.length && <section className="composer-image-tray" aria-label="已附加图片缩略图">
        <div className="composer-image-list">{stagedImages.map((image, index) => <div className="staged-image" role="group" aria-label={`已附加图片 ${index + 1}`} data-status={image.status} key={image.key}>
          <img src={image.previewUrl} alt={`已附加图片 ${index + 1}`} />
          {image.status === "uploading" && <span className="staged-image-state uploading" role="status" aria-label={`图片 ${index + 1} 上传中`}><LoaderCircle size={14} className="spin" /></span>}
          {image.status === "error" && <span className="staged-image-state failed" role="alert" title={image.error}><AlertTriangle size={15} /><button onClick={() => void uploadImage(image)} aria-label={`重试上传图片 ${index + 1}`}><RotateCcw size={12} /></button></span>}
          <button className="staged-image-remove" onClick={() => removeImage(image.key)} aria-label={`移除图片 ${index + 1}`} title="移除图片"><X size={12} strokeWidth={2.2} /></button>
        </div>)}</div>
      </section>}
      <textarea ref={input} value={draft} onChange={(event) => setDraft(event.target.value)} onPaste={onPaste} onCompositionStart={() => { isComposingRef.current = true; }} onCompositionEnd={() => { isComposingRef.current = false; }} onKeyDown={(event) => {
        if (event.key === "Backspace" && !draft && stagedRef.current.length && !isComposingRef.current) { event.preventDefault(); removeImage(stagedRef.current.at(-1)!.key); return; }
        if (event.key !== "Enter" || event.shiftKey) return;
        if (isComposingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        event.preventDefault(); event.stopPropagation();
        if (event.repeat) return;
        void submit(true);
      }} placeholder={placeholder || "给 Gemini 发消息，让我指挥 GPT 干活…"} aria-label={workerMode ? "给工兵发送指导" : "撰写新消息"} disabled={busy || blocked || sending} />
      {attachmentError && <small className="composer-image-error" role="alert"><AlertTriangle size={13} />{attachmentError}</small>}
      <div className="composer-card-footer">
        <div className="composer-footer-left">
          {!workerMode && <label className="role-picker" title="选择消息角色">{roleIcon(role)}<select aria-label="新消息角色" value={role} onChange={(event) => {
            const nextRole = event.target.value as Message["role"];
            if (nextRole !== "user" && stagedRef.current.length) { setAttachmentError("请先发送或移除图片，再切换到非 User 角色。"); return; }
            setRole(nextRole);
          }}>{composerRoles.map((value) => <option key={value} value={value}>{value === "user" ? "User" : value === "assistant" ? "Assistant" : "System"}</option>)}</select><ChevronDown size={13} /></label>}
          <span className="context-count" title={usageTitle} style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><span>{usageLabel}</span>{savedPercent > 0 && <span style={{ color: "var(--success)", fontSize: 8 }}>🧹 已省 {savedPercent}%</span>}</span>
        </div>
        <div className="composer-footer-right">{!workerMode && <ComposerModelControls settings={settings} models={models} defaultModel={defaultModel} piConnected={piConnected} busy={busy} blocked={blocked} onSetting={onSetting} onNotice={onNotice} onRefreshModels={onRefreshModels} />}<div className="composer-actions">{workerMode
          ? <button className="send-button" disabled={!canSend || busy || blocked || sending} onClick={() => void submit(true)}><ArrowUp size={15} />发送指导</button>
          : canSend ? <><button className="add-only-button" disabled={busy || sending} onClick={() => void submit(false)}><Plus size={14} />仅添加</button><button className="send-button" disabled={busy || blocked || sending} onClick={() => void submit(true)}><ArrowUp size={15} />发送</button></> : <button className="send-button run-current" disabled={busy || blocked} onClick={onRun} title="重新运行当前上下文" style={{ minWidth: "unset", width: "auto", padding: "0 10px", fontSize: 9, fontWeight: 500, color: "var(--text-muted)", borderColor: "var(--border)", background: "var(--surface-soft)" }}><RotateCw size={13} />重新运行</button>}</div></div>
      </div>
    </div>}
    {blocked && <small className="composer-hint">Pi 同步会话请先在顶部应用或放弃本地修改。</small>}
  </footer>;
}
