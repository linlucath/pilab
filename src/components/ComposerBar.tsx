import { useEffect, useRef, useState } from "react";
import type { ClipboardEvent as ClipboardEventType, DragEvent as DragEventType } from "react";
import { AlertTriangle, ArrowUp, Check, ChevronDown, Cpu, FileText, ImagePlus, LoaderCircle, Paperclip, Plus, RotateCw, RotateCcw, Sparkles, Square, UserRound, Wrench, X } from "lucide-react";
import { imageReferenceSchema, MAX_IMAGE_BYTES, MAX_MESSAGE_IMAGES, MAX_MESSAGE_IMAGE_BYTES, MAX_WORKSPACE_FILE_BYTES, type Message, type Settings } from "../../shared/schema";
import { ComposerModelControls, type ModelOption } from "./ComposerModelControls";
import { ComposerSubagentModelPicker } from "./ComposerSubagentModelPicker";
import type { SubagentModelOption } from "../../shared/subagent-models";
import type { GptSessionSummary } from "../../shared/gpt-sessions";

type WakeNotice = { names: string[] };
type ImageReference = NonNullable<Message["images"]>[number];
type StagedImage = {
  key: string; file: File; previewUrl: string; status: "uploading" | "ready" | "error";
  reference?: ImageReference; error?: string;
};
type StagedWorkspaceFile = {
  key: string; file: File; status: "uploading" | "ready" | "error";
  fileName?: string; relativePath?: string; error?: string;
};
type WorkspaceFileResult = { success: true; fileName: string; relativePath: string; size: number };
type Props = {
  busy: boolean; blocked?: boolean; workerMode?: boolean; placeholder?: string; toolName?: string; sessionId: string; workingDirectory: string; messageCount: number; contextTokens: number; savedPercent: number;
  settings: Pick<Settings, "protocol" | "model" | "reasoning" | "reasoningEffort" | "defaultSubagentModel" | "defaultSubagentThinkingLevel">; models: ModelOption[]; subagentModels: readonly SubagentModelOption[]; subagentConnected?: boolean; defaultModel?: string; piConnected?: boolean;
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
const formatFileSize = (bytes: number) => bytes < 1024 ? `${bytes} B`
  : bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB`
  : `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;

export function ComposerBar({ busy, blocked, workerMode = false, placeholder, toolName, sessionId, workingDirectory, messageCount, contextTokens, savedPercent, settings, models, subagentModels, subagentConnected, defaultModel, piConnected, onSetting, onNotice, onRefreshModels, backgroundWorkers = [], wakeNotice, onDismissWake, onReviewWorkers, onSend, onRun, onStop }: Props) {
  const tokenLabel = contextTokens >= 10_000 ? `${(contextTokens / 1000).toFixed(1)}k` : contextTokens.toLocaleString();
  const usageLabel = `~${tokenLabel} tokens`;
  const usageTitle = `${messageCount} 条消息 · 按消息、思考过程及工具参数估算`;
  const [role, setRole] = useState<Message["role"]>("user");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [stagedImages, setStagedImages] = useState<StagedImage[]>([]);
  const [stagedFiles, setStagedFiles] = useState<StagedWorkspaceFile[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);
  const dragDepth = useRef(0);
  const stagedRef = useRef<StagedImage[]>([]);
  const stagedFilesRef = useRef<StagedWorkspaceFile[]>([]);
  const uploads = useRef(new Map<string, AbortController>());
  const replaceStaged = (next: StagedImage[]) => { stagedRef.current = next; setStagedImages(next); };
  const replaceStagedFiles = (next: StagedWorkspaceFile[]) => { stagedFilesRef.current = next; setStagedFiles(next); };
  const updateStaged = (key: string, patch: Partial<StagedImage>) => {
    const current = stagedRef.current;
    if (!current.some((image) => image.key === key)) return;
    replaceStaged(current.map((image) => image.key === key ? { ...image, ...patch } : image));
  };
  const updateStagedFile = (key: string, patch: Partial<StagedWorkspaceFile>) => {
    const current = stagedFilesRef.current;
    if (!current.some((file) => file.key === key)) return;
    replaceStagedFiles(current.map((file) => file.key === key ? { ...file, ...patch } : file));
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

  const uploadWorkspaceFile = async (file: StagedWorkspaceFile) => {
    const controller = new AbortController();
    uploads.current.set(file.key, controller);
    updateStagedFile(file.key, { status: "uploading", error: undefined });
    try {
      const query = new URLSearchParams({ sessionId, name: file.file.name || "uploaded-file" });
      if (workingDirectory.trim()) query.set("workingDirectory", workingDirectory);
      const response = await fetch(`/api/workspaces/upload-file?${query}`, {
        method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file.file, signal: controller.signal,
      });
      const result = await response.json().catch(() => ({})) as Partial<WorkspaceFileResult> & { error?: string };
      if (!response.ok) throw new Error(result.error || `文件上传失败（HTTP ${response.status}）`);
      if (result.success !== true || typeof result.fileName !== "string" || typeof result.relativePath !== "string" || result.size !== file.file.size)
        throw new Error("文件上传校验失败，请重试。");
      updateStagedFile(file.key, { status: "ready", fileName: result.fileName, relativePath: result.relativePath, error: undefined });
    } catch (error) {
      if (controller.signal.aborted) return;
      updateStagedFile(file.key, { status: "error", error: error instanceof Error ? error.message : "文件上传失败。" });
    } finally {
      if (uploads.current.get(file.key) === controller) uploads.current.delete(file.key);
    }
  };

  const addFiles = (files: File[]) => {
    if (workerMode) { setAttachmentError("工兵指导目前只支持文本消息。"); return; }
    const acceptedImages: StagedImage[] = [];
    const acceptedFiles: StagedWorkspaceFile[] = [];
    const errors: string[] = [];
    let totalImageBytes = stagedRef.current.reduce((total, image) => total + image.file.size, 0);
    let imageCount = stagedRef.current.length;
    for (const file of files) {
      if (looksLikeImage(file)) {
        if (file.type && !supportedImageTypes.has(file.type)) {
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
        if (imageCount >= MAX_MESSAGE_IMAGES) {
          errors.push(`单条消息最多附加 ${MAX_MESSAGE_IMAGES} 张图片。`);
          continue;
        }
        if (totalImageBytes + file.size > MAX_MESSAGE_IMAGE_BYTES) {
          errors.push(`单条消息图片总大小不能超过 ${MAX_MESSAGE_IMAGE_BYTES / (1024 * 1024)} MiB。`);
          continue;
        }
        acceptedImages.push({ key: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file), status: "uploading" });
        imageCount++;
        totalImageBytes += file.size;
      } else if (file.size > MAX_WORKSPACE_FILE_BYTES) {
        errors.push(`「${file.name || "文件"}」超过单文件 50 MiB 上限。`);
      } else {
        acceptedFiles.push({ key: crypto.randomUUID(), file, status: "uploading" });
      }
    }
    if (acceptedImages.length) {
      replaceStaged([...stagedRef.current, ...acceptedImages]);
      for (const image of acceptedImages) void uploadImage(image);
    }
    if (acceptedFiles.length) {
      replaceStagedFiles([...stagedFilesRef.current, ...acceptedFiles]);
      for (const file of acceptedFiles) void uploadWorkspaceFile(file);
    }
    if (acceptedImages.length || acceptedFiles.length) setAttachmentError("");
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
  const removeFile = (key: string) => {
    uploads.current.get(key)?.abort();
    uploads.current.delete(key);
    replaceStagedFiles(stagedFilesRef.current.filter((file) => file.key !== key));
    setAttachmentError("");
  };
  const clearImages = () => {
    for (const image of stagedRef.current) {
      uploads.current.get(image.key)?.abort();
      uploads.current.delete(image.key);
      URL.revokeObjectURL(image.previewUrl);
    }
    replaceStaged([]);
    setAttachmentError("");
  };
  const clearFiles = () => {
    for (const file of stagedFilesRef.current) {
      uploads.current.get(file.key)?.abort();
      uploads.current.delete(file.key);
    }
    replaceStagedFiles([]);
    setAttachmentError("");
  };
  const submit = async (run: boolean) => {
    const currentImages = stagedRef.current;
    const currentFiles = stagedFilesRef.current;
    if ((!draft.trim() && !currentImages.length && !currentFiles.length) || busy || blocked || sending) return;
    if (workerMode && (currentImages.length || currentFiles.length)) { setAttachmentError("工兵指导目前只支持文本消息，请切回主会话处理附件。"); return; }
    if (role !== "user" && currentImages.length) { setAttachmentError("图片只能作为 User 消息发送，请先切换角色或删除图片后再发送。"); return; }
    if ([...currentImages, ...currentFiles].some((item) => item.status === "uploading")) { setAttachmentError("附件仍在上传，请稍候完成后再发送。"); return; }
    if (currentImages.some((image) => image.status !== "ready" || !image.reference)) { setAttachmentError("图片上传失败，请重试或删除失败图片后再发送。"); return; }
    if (currentFiles.some((file) => file.status !== "ready" || !file.relativePath)) { setAttachmentError("文件上传失败，请重试或删除失败文件后再发送。"); return; }
    const references = currentImages.map((image) => image.reference!);
    const attachmentNotes = currentFiles.map((file) => `[附件已保存至工作目录: ./${file.relativePath}]`).join("\n");
    const content = [draft.trim(), attachmentNotes].filter(Boolean).join("\n\n");
    setSending(true);
    try {
      if (await onSend(content, workerMode ? "user" : role, workerMode || run, references) === false) return;
      setDraft("");
      clearImages();
      clearFiles();
    } finally { setSending(false); }
  };
  const hasFileDrag = (transfer: DataTransfer) => Array.from(transfer.types).includes("Files");
  const onPaste = (event: ClipboardEventType<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (!files.length) return;
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
  const canSend = !!draft.trim() || stagedImages.length > 0 || stagedFiles.length > 0;
  const attachmentsUploading = stagedImages.some((image) => image.status === "uploading") || stagedFiles.some((file) => file.status === "uploading");

  return <footer className="composer-bar">
    {!workerMode && !busy && backgroundWorkers.length > 0 && <div className="background-task-bar" aria-label="后台 GPT 工兵状态"><strong><Cpu size={14} />后台工兵并行中</strong><div>{backgroundWorkers.map((worker) => { const activeTool = worker.recentTools.find((tool) => tool.status === "running"); return <span className="background-task-item" key={worker.id}><b>{worker.role || worker.name}</b><small>{worker.status === "waiting_input" ? "等待输入" : activeTool ? `正在执行 ${activeTool.name}…` : worker.status === "starting" ? "正在启动…" : "正在工作…"}</small></span>; })}</div></div>}
    {!workerMode && wakeNotice && <div className="worker-wake-banner" role="status"><span><Sparkles size={14} />{wakeNotice.names.length > 1 ? `${wakeNotice.names.length} 个 GPT 工兵` : `工兵「${wakeNotice.names[0]}」`}已交卷！{busy ? " · 主模型运行中，结束后可手动审阅" : draft.trim() ? " · 审阅不会清除输入草稿" : " · 需要时手动审阅"}</span><div><button className="wake-review-button" disabled={busy || blocked} onClick={() => onReviewWorkers?.()}>✨ 让 Gemini 审阅汇报</button><button className="wake-dismiss-button" aria-label="忽略工兵交卷提醒" title="忽略提醒，不会停止工兵" onClick={() => onDismissWake?.()}>忽略</button></div></div>}
    {busy ? <div className="composer-running"><LoaderCircle size={15} className="spin" /><span>{toolName ? <><Wrench size={13} />正在执行 {toolName}…</> : "✨ Gemini 正在思考…"}</span><small className="running-context-count" title={usageTitle}>{usageLabel}{savedPercent > 0 ? ` · 已省 ${savedPercent}%` : ""}</small><button className="stop-button" onClick={onStop}><Square size={13} fill="currentColor" />停止</button></div> : <div className={`composer-card ${dragOver ? "is-drag-over" : ""}`}
      onDragEnter={(event) => { if (!hasFileDrag(event.dataTransfer)) return; event.preventDefault(); dragDepth.current++; setDragOver(true); }}
      onDragOver={(event) => { if (hasFileDrag(event.dataTransfer)) event.preventDefault(); }}
      onDragLeave={(event) => { if (!hasFileDrag(event.dataTransfer)) return; event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragOver(false); }}
      onDrop={onDrop}>
      {dragOver && <div className="composer-drop-overlay" aria-hidden="true"><ImagePlus size={22} /><strong>松开即可添加文件</strong><small>图片可直接附加 · 单个文件最大 50 MiB</small></div>}
      {!!stagedImages.length && <section className="composer-image-tray" aria-label="已附加图片缩略图">
        <div className="composer-image-list">{stagedImages.map((image, index) => <div className="staged-image" role="group" aria-label={`已附加图片 ${index + 1}`} data-status={image.status} key={image.key}>
          <img src={image.previewUrl} alt={`已附加图片 ${index + 1}`} />
          {image.status === "uploading" && <span className="staged-image-state uploading" role="status" aria-label={`图片 ${index + 1} 上传中`}><LoaderCircle size={14} className="spin" /></span>}
          {image.status === "error" && <span className="staged-image-state failed" role="alert" title={image.error}><AlertTriangle size={15} /><button onClick={() => void uploadImage(image)} aria-label={`重试上传图片 ${index + 1}`}><RotateCcw size={12} /></button></span>}
          <button className="staged-image-remove" onClick={() => removeImage(image.key)} aria-label={`移除图片 ${index + 1}`} title="移除图片"><X size={12} strokeWidth={2.2} /></button>
        </div>)}</div>
      </section>}
      {!!stagedFiles.length && <section className="composer-file-tray" aria-label="待上传文件">
        <div className="composer-file-list">{stagedFiles.map((file) => {
          const displayName = file.fileName || file.file.name || "未命名文件";
          return <div className="composer-file-capsule" role="group" aria-label={`附件 ${displayName}`} data-status={file.status} key={file.key}>
            <FileText className="composer-file-icon" size={16} />
            <span className="composer-file-copy"><strong title={displayName}>{displayName}</strong><small>{formatFileSize(file.file.size)}</small></span>
            {file.status === "uploading" && <span className="composer-file-status uploading" role="status"><LoaderCircle size={13} className="spin" />上传中</span>}
            {file.status === "ready" && <span className="composer-file-status ready"><Check size={13} />已就绪</span>}
            {file.status === "error" && <span className="composer-file-status failed" title={file.error}><AlertTriangle size={13} /><button onClick={() => void uploadWorkspaceFile(file)} aria-label={`重试上传 ${displayName}`}>重试</button></span>}
            <button className="composer-file-remove" onClick={() => removeFile(file.key)} aria-label={`移除文件 ${displayName}`} title="移除文件"><X size={13} /></button>
          </div>;
        })}</div>
      </section>}
      <input ref={fileInput} className="composer-file-input" type="file" multiple aria-label="选择要上传的文件" onChange={(event) => {
        addFiles(Array.from(event.currentTarget.files || []));
        event.currentTarget.value = "";
      }} />
      <textarea ref={input} value={draft} onChange={(event) => setDraft(event.target.value)} onPaste={onPaste} onCompositionStart={() => { isComposingRef.current = true; }} onCompositionEnd={() => { isComposingRef.current = false; }} onKeyDown={(event) => {
        if (event.key === "Backspace" && !draft && !isComposingRef.current) {
          const lastImage = stagedRef.current.at(-1);
          const lastFile = stagedFilesRef.current.at(-1);
          if (lastImage || lastFile) { event.preventDefault(); lastImage ? removeImage(lastImage.key) : removeFile(lastFile!.key); return; }
        }
        if (event.key !== "Enter" || event.shiftKey) return;
        if (isComposingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        event.preventDefault(); event.stopPropagation();
        if (event.repeat) return;
        submit(true);
      }} placeholder={placeholder || "输入消息或任务要求..."} aria-label={workerMode ? "给工兵发送指导" : "撰写新消息"} disabled={busy || blocked || sending} />
      {attachmentError && <small className="composer-image-error" role="alert"><AlertTriangle size={13} />{attachmentError}</small>}
      <div className="composer-card-footer">
        <div className="composer-footer-left">
          {!workerMode && <button className="composer-attach-button" type="button" aria-label="添加附件" title="添加文件" disabled={blocked} onClick={() => fileInput.current?.click()}><Paperclip size={15} /></button>}
          {!workerMode && <label className="role-picker" title="选择消息角色">{roleIcon(role)}<select aria-label="新消息角色" value={role} onChange={(event) => {
            const nextRole = event.target.value as Message["role"];
            if (nextRole !== "user" && stagedRef.current.length) { setAttachmentError("请先发送或移除图片，再切换到非 User 角色。"); return; }
            setRole(nextRole);
          }}>{composerRoles.map((value) => <option key={value} value={value}>{value === "user" ? "User" : value === "assistant" ? "Assistant" : "System"}</option>)}</select><ChevronDown size={13} /></label>}
          <span className="context-count" title={usageTitle} style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><span>{usageLabel}</span>{savedPercent > 0 && <span style={{ color: "var(--success)", fontSize: 8 }}>🧹 已省 {savedPercent}%</span>}</span>
        </div>
        <div className="composer-footer-right">{!workerMode && <><ComposerSubagentModelPicker model={settings.defaultSubagentModel} thinkingLevel={settings.defaultSubagentThinkingLevel} models={subagentModels} subagentConnected={subagentConnected} disabled={busy || blocked} onSetting={onSetting} onNotice={onNotice} /><ComposerModelControls settings={settings} models={models} defaultModel={defaultModel} piConnected={piConnected} busy={busy} blocked={blocked} onSetting={onSetting} onNotice={onNotice} onRefreshModels={onRefreshModels} /></>}<div className="composer-actions">{workerMode
          ? <button className="send-button" disabled={!canSend || busy || blocked || sending || attachmentsUploading} onClick={() => void submit(true)}><ArrowUp size={15} />发送指导</button>
          : canSend ? <><button className="add-only-button" disabled={busy || blocked || sending || attachmentsUploading} onClick={() => void submit(false)}><Plus size={14} />仅添加</button><button className="send-button" disabled={busy || blocked || sending || attachmentsUploading} onClick={() => void submit(true)}><ArrowUp size={15} />发送</button></> : <button className="send-button run-current" disabled={busy || blocked} onClick={onRun} title="重新运行当前上下文" style={{ minWidth: "unset", width: "auto", padding: "0 10px", fontSize: 9, fontWeight: 500, color: "var(--text-muted)", borderColor: "var(--border)", background: "var(--surface-soft)" }}><RotateCw size={13} />重新运行</button>}</div></div>
      </div>
    </div>}
    {blocked && <small className="composer-hint">Pi 同步会话请先在顶部应用或放弃本地修改。</small>}
  </footer>;
}
