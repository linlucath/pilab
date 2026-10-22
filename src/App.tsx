import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Copy,
  Download,
  Eye,
  EyeOff,
  FlaskConical,
  GitBranch,
  History,
  Layers,
  Menu,
  MessageSquare,
  Play,
  Plus,
  RotateCcw,
  Settings2,
  Square,
  Terminal,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  defaults,
  getReasoningEffort,
  reasoningEfforts,
  fileSchema,
  initialMessages,
  roles,
  settingsSchema,
  type Message,
  type ReasoningEffort,
  type Settings,
  type ToolCall,
} from "../shared/schema";

import type { PiLiveSession, PiLiveDetail } from "../shared/pi-sync";

type PiConnection = {
  connected: boolean;
  provider: string;
  defaultModel?: string;
  models: {
    id: string;
    name: string;
    reasoningEfforts: ReasoningEffort[];
    reasoningEffortMap?: Partial<Record<ReasoningEffort, string | null>>;
  }[];
};

type Run = {
  id: string;
  at: number;
  status: string;
  output: string;
  thinking: string;
  request?: unknown;
  requests?: unknown[];
  trace?: Message[];
  turns?: number;
  cwd?: string;
  usage?: { input: number; output: number };
  elapsed: number;
  error?: string;
  snapshot: { settings: Settings; messages: Message[] };
};
type Session = {
  id: string;
  title: string;
  messages: Message[];
  settings: Settings;
  runs: Run[];
  piSync?: { id: string; revision: string; dirty: boolean; pending?: string };
};
const uid = () => crypto.randomUUID();
const newSession = (): Session => ({
  id: uid(),
  title: "未命名实验",
  messages: structuredClone(initialMessages),
  settings: { ...defaults },
  runs: [],
});
const storageKey = "pi-lab-workspace-v1";
function load(): { sessions: Session[]; active: string } {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
    if (saved?.sessions?.length) {
      const sessions = saved.sessions.flatMap((s: Session) => {
        const messages = fileSchema.shape.messages.safeParse(s.messages);
        if (!messages.success) return [];
        const settings = { ...defaults };
        for (const key of Object.keys(defaults) as (keyof Settings)[]) {
          if (key === "apiKey") continue;
          const field = settingsSchema.shape[key].safeParse(s.settings?.[key]);
          if (field.success) Object.assign(settings, { [key]: field.data });
        }
        return [
          {
            title:
              typeof s.title === "string"
                ? s.title.slice(0, 200)
                : "未命名实验",
            messages: messages.data,
            id: typeof s.id === "string" && s.id ? s.id : uid(),
            settings,
            runs: [],
            ...(s.piSync && typeof s.piSync.id === "string"
              ? { piSync: s.piSync }
              : {}),
          },
        ];
      });
      if (!sessions.length) throw new Error("No valid saved sessions");
      return {
        sessions,
        active: sessions.some((s: Session) => s.id === saved.active)
          ? saved.active
          : sessions[0].id,
      };
    }
  } catch {
    /* Recover to a fresh workspace on corrupt local data. */
  }
  const session = newSession();
  return { sessions: [session], active: session.id };
}
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
const protocolNames = {
  "pi-subscription": "Pi 订阅 · OpenAI Codex",
  "openai-completions": "Chat Completions",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages",
};

export default function App() {
  const [workspace, setWorkspace] = useState(load);
  const session = workspace.sessions.find((s) => s.id === workspace.active)!;
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const apiKey = apiKeys[workspace.active] || "";
  const setApiKey = (value: string) =>
    setApiKeys((keys) => ({ ...keys, [workspace.active]: value }));
  const [busy, setBusy] = useState(false);
  const [piSessions, setPiSessions] = useState<PiLiveSession[]>([]);
  const [piDetail, setPiDetail] = useState<PiLiveDetail | null>(null);
  const piStreamOnline = useRef(false);
  const [streamingThought, setStreamingThought] = useState({ id: "", text: "" });
  const [streamingMessageId, setStreamingMessageId] = useState("");
  const [syncInstalled, setSyncInstalled] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [followPi, setFollowPi] = useState(true);
  const [submittingSync, setSubmittingSync] = useState(false);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const piSource = piDetail?.id === session.piSync?.id
    ? piDetail
    : piSessions.find((s) => s.id === session.piSync?.id);

  const [runtimeCwd, setRuntimeCwd] = useState("");
  const [toolActivity, setToolActivity] = useState<{
    name: string;
    arguments: unknown;
    output: string;
  } | null>(null);
  const [piConnection, setPiConnection] = useState<PiConnection | null>(null);
  const isSubscription = session.settings.protocol === "pi-subscription";
  const subscriptionModels = piConnection?.models || [];
  const reasoningEffort = getReasoningEffort(session.settings);
  const subscriptionModel = subscriptionModels.find(
    (model) => model.id === session.settings.model,
  );
  const supportedEfforts = isSubscription
    ? subscriptionModel?.reasoningEfforts || reasoningEfforts
    : session.settings.protocol === "anthropic-messages"
      ? reasoningEfforts.filter(
          (effort) => effort !== "xhigh" && effort !== "max",
        )
      : reasoningEfforts;
  const modelOptions = subscriptionModels.some(
    (model) => model.id === session.settings.model,
  )
    ? subscriptionModels
    : [
        { id: session.settings.model, name: session.settings.model },
        ...subscriptionModels,
      ];
  const [tab, setTab] = useState<"editor" | "request" | "history">("editor");
  const [notice, setNotice] = useState("");
  const [connection, setConnection] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [selectedRun, setSelectedRun] = useState<string>();
  const controller = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const editorScroll = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const streamingTextarea = useRef<HTMLTextAreaElement>(null);
  const activeRun =
    session.runs.find((r) => r.id === selectedRun) || session.runs[0];
  const enabled = session.messages.filter((m) => m.enabled);
  const characters = enabled.reduce((total, m) => total + m.content.length, 0);
  useLayoutEffect(() => {
    if (busy && followOutput.current && streamingTextarea.current)
      streamingTextarea.current.scrollTop = streamingTextarea.current.scrollHeight;
    if ((busy || piSource?.busy) && followOutput.current && editorScroll.current)
      editorScroll.current.scrollTop = editorScroll.current.scrollHeight;
  }, [session.messages, busy, toolActivity, streamingThought, piSource?.partial]);
  const patch = (updates: Partial<Session>) =>
    setWorkspace((w) => ({
      ...w,
      sessions: w.sessions.map((s) =>
        s.id === w.active
          ? {
              ...s,
              ...updates,
              ...(updates.messages && s.piSync
                ? { piSync: { ...s.piSync, dirty: true } }
                : {}),
            }
          : s,
      ),
    }));
  const setting = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    patch({ settings: { ...session.settings, [key]: value } });
  useEffect(() => {
    if (supportedEfforts.includes(reasoningEffort)) return;
    const effort = supportedEfforts.includes("medium")
      ? "medium"
      : supportedEfforts[0];
    if (!effort) return;
    patch({
      settings: {
        ...session.settings,
        reasoningEffort: effort,
        reasoning: effort !== "off",
      },
    });
    setNotice(
      `当前模型不支持 ${reasoningEffort}，推理强度已调整为 ${effort}。`,
    );
  }, [
    session.id,
    session.settings.protocol,
    session.settings.model,
    reasoningEffort,
    subscriptionModel,
  ]);
  const changeMessage = (id: string, values: Partial<Message>) =>
    patch({
      messages: session.messages.map((m) =>
        m.id === id ? { ...m, ...values } : m,
      ),
    });
  const changeCall = (
    message: Message,
    index: number,
    values: Partial<ToolCall>,
  ) =>
    changeMessage(message.id, {
      toolCalls: message.toolCalls?.map((call, i) =>
        i === index ? { ...call, ...values } : call,
      ),
    });
  function addToolResult(message: Message, call: ToolCall) {
    if (
      session.messages.some(
        (m) => m.role === "tool" && m.toolCallId === call.id,
      )
    ) {
      setNotice("此调用已有工具结果，可直接编辑对应的 tool 消息。");
      return;
    }
    const messages = [...session.messages];
    let index = messages.findIndex((m) => m.id === message.id) + 1;
    while (messages[index]?.role === "tool") index++;
    messages.splice(index, 0, {
      id: uid(),
      role: "tool",
      enabled: true,
      content: "",
      toolCallId: call.id,
      toolName: call.name,
      isError: false,
    });
    patch({ messages });
  }
  useEffect(() => {
    const sanitized = {
      ...workspace,
      sessions: workspace.sessions.map(({ runs: _runs, ...s }) => ({
        ...s,
        settings: { ...s.settings, apiKey: "" },
      })),
    };
    try {
      localStorage.setItem(storageKey, pretty(sanitized));
    } catch {
      setNotice("浏览器存储空间不足，请导出实验以保存。");
    }
  }, [workspace]);
  useEffect(() => {
    if (notice) {
      const id = setTimeout(() => setNotice(""), 4500);
      return () => clearTimeout(id);
    }
  }, [notice]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((status) => setRuntimeCwd(status.workingDirectory || ""))
      .catch(() => {});
  }, []);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/pi-status")
      .then((r) => r.json())
      .then((status: PiConnection) => {
        if (cancelled) return;
        setPiConnection(status);
        if (status.connected && status.defaultModel)
          setWorkspace((w) => ({
            ...w,
            sessions: w.sessions.map((s) =>
              s.settings.protocol === defaults.protocol &&
              s.settings.baseUrl === defaults.baseUrl &&
              s.settings.model === defaults.model
                ? {
                    ...s,
                    settings: {
                      ...s.settings,
                      protocol: "pi-subscription",
                      model: status.defaultModel!,
                      reasoning: true,
                      reasoningEffort: "medium",
                    },
                  }
                : s,
            ),
          }));
      })
      .catch(() => {
        if (!cancelled) setPiConnection(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  async function readPiSession(id: string, activate = false, discard = false, isCurrent = () => true) {
    const response = await fetch(`/api/pi-sync/${encodeURIComponent(id)}`, {
      cache: "no-store",
    });
    const source: PiLiveDetail = await response.json();
    if (!response.ok)
      throw new Error((source as any).error || "读取 Pi 会话失败");
    if (isCurrent()) receivePiSession(source, activate, discard);
    return source;
  }
  function receivePiSession(source: PiLiveDetail, activate = false, discard = false) {
    const id = source.id;
    setPiDetail(source);
    setWorkspace((w) => {
      const local = w.sessions.find((s) => s.piSync?.id === id);
      const accepted =
        local?.piSync?.pending &&
        source.ack?.id === local.piSync.pending &&
        source.ack.status === "applied";
      const rejected =
        local?.piSync?.pending &&
        source.ack?.id === local.piSync.pending &&
        source.ack.status === "rejected";
      let next = local;
      if (!local) {
        const effort = reasoningEfforts.includes(
          source.thinking as ReasoningEffort,
        )
          ? (source.thinking as ReasoningEffort)
          : "medium";
        next = {
          id: uid(),
          title: source.name,
          messages: source.messages,
          runs: [],
          settings: {
            ...defaults,
            protocol:
              source.model?.provider === "openai-codex"
                ? "pi-subscription"
                : defaults.protocol,
            model: source.model?.id || defaults.model,
            workingDirectory: source.cwd,
            reasoningEffort: effort,
            reasoning: effort !== "off",
          },
          piSync: { id, revision: source.revision, dirty: false },
        };
      } else if (
        discard ||
        accepted ||
        (!local.piSync?.dirty && !local.piSync?.pending)
      ) {
        if (source.revision !== local.piSync?.revision || discard || accepted)
          next = {
            ...local,
            messages: source.messages,
            piSync: { id, revision: source.revision, dirty: false },
          };
      } else if (rejected) {
        next = { ...local, piSync: { ...local.piSync!, pending: undefined } };
      }
      if (!next || (next === local && (!activate || w.active === next.id))) return w;
      return {
        sessions: local
          ? w.sessions.map((s) => (s.id === local.id ? next! : s))
          : [...w.sessions, next],
        active: activate ? next.id : w.active,
      };
    });
  }
  useEffect(() => {
    const id = session.piSync?.id;
    if (!id) return;
    let cancelled = false;
    const events = new EventSource(`/api/pi-sync/${encodeURIComponent(id)}/events`);
    events.addEventListener("snapshot", (event) => {
      if (cancelled) return;
      try {
        const source = JSON.parse((event as MessageEvent).data) as PiLiveDetail;
        if (source.id !== id) return;
        piStreamOnline.current = true;
        receivePiSession(source);
      } catch {
        piStreamOnline.current = false;
      }
    });
    events.addEventListener("sync_error", () => { piStreamOnline.current = false; });
    events.onerror = () => { piStreamOnline.current = false; };
    return () => {
      cancelled = true;
      piStreamOnline.current = false;
      events.close();
    };
  }, [session.piSync?.id]);
  useEffect(() => {
    let cancelled = false;
    let running = false;
    async function poll() {
      if (running) return;
      running = true;
      try {
        const response = await fetch("/api/pi-sync", { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Pi 同步服务不可用");
        if (cancelled) return;
        setPiSessions(data.sessions);
        setSyncInstalled(data.installed);
        setSyncError("");
        const w = workspaceRef.current;
        const current = w.sessions.find((s) => s.id === w.active);
        const latest = [...data.sessions].sort(
          (a: PiLiveSession, b: PiLiveSession) => b.activityAt - a.activityAt,
        )[0];
        const target =
          followPi &&
          !busy &&
          !current?.piSync?.dirty &&
          !current?.piSync?.pending
            ? latest?.id || current?.piSync?.id
            : current?.piSync?.id;
        if (target && (target !== current?.piSync?.id || !piStreamOnline.current))
          await readPiSession(
            target,
            !!(
              followPi &&
              latest?.id === target &&
              !current?.piSync?.dirty &&
              !busy
            ),
            false,
            () => !cancelled,
          );
      } catch (e) {
        if (!cancelled) setSyncError((e as Error).message);
      } finally {
        running = false;
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), 1200);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [followPi, busy]);
  async function applyToPi() {
    if (!session.piSync || submittingSync) return;
    setSubmittingSync(true);
    const localId = session.id;
    try {
      const response = await fetch(
        `/api/pi-sync/${encodeURIComponent(session.piSync.id)}/apply`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            revision: session.piSync.revision,
            messages: session.messages,
          }),
        },
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "提交修改失败");
      setWorkspace((w) => ({
        ...w,
        sessions: w.sessions.map((s) =>
          s.id === localId && s.piSync
            ? { ...s, piSync: { ...s.piSync, pending: result.id } }
            : s,
        ),
      }));
      setNotice("已提交，正在等待 Pi 确认。确认后可在终端继续对话。");
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setSubmittingSync(false);
    }
  }
  function addMessage(after?: number) {
    const messages = [...session.messages];
    messages.splice(after === undefined ? messages.length : after + 1, 0, {
      id: uid(),
      role: "user",
      content: "",
      enabled: true,
    });
    patch({ messages });
    setTab("editor");
  }
  function move(index: number, delta: number) {
    const messages = [...session.messages];
    [messages[index], messages[index + delta]] = [
      messages[index + delta],
      messages[index],
    ];
    patch({ messages });
  }
  function createSession(copy?: Session) {
    const next = copy
      ? { ...structuredClone(copy), id: uid(), runs: [] }
      : newSession();
    delete next.piSync;
    setFollowPi(false);
    if (!copy && piConnection?.connected && piConnection.defaultModel)
      next.settings = {
        ...next.settings,
        protocol: "pi-subscription",
        model: piConnection.defaultModel,
        reasoning: true,
        reasoningEffort: "medium",
      };
    setWorkspace((w) => ({ sessions: [...w.sessions, next], active: next.id }));
    setTab("editor");
    setSidebar(false);
    setSelectedRun(undefined);
  }
  function exportSession() {
    const { apiKey: _key, ...settings } = session.settings;
    const blob = new Blob(
      [
        pretty({
          version: 1,
          title: session.title,
          settings,
          messages: session.messages,
        }),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${session.title || "pi-experiment"}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setNotice("已导出实验，不包含 API Key。");
  }
  async function importFile(file?: File) {
    if (!file) return;
    try {
      if (file.size > 5_000_000) throw new Error("文件不能超过 5 MB");
      const data = fileSchema.parse(JSON.parse(await file.text()));
      createSession({
        id: uid(),
        title: data.title,
        settings: { ...data.settings, apiKey: "" },
        messages: data.messages.map((m) => ({ ...m, id: uid() })),
        runs: [],
      });
      setNotice("实验已导入。");
    } catch (error) {
      setNotice(
        `导入失败：${error instanceof Error ? error.message : "JSON 格式无效"}`,
      );
    }
  }
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice("已复制到剪贴板。");
    } catch {
      setNotice("无法访问剪贴板，请手动选择并复制。");
    }
  }
  async function run() {
    if (session.piSync) {
      setNotice(
        "请先应用到 Pi，再在 Pi 终端继续对话。独立实验可使用「从此处分支」。",
      );
      return;
    }
    if (busy) return;
    if (
      !enabled.length ||
      !enabled.some(
        (m) => m.content.trim() || m.toolCalls?.length || m.role === "tool",
      )
    ) {
      setNotice("请先添加至少一条有内容的消息。");
      return;
    }
    const runId = uid();
    const started = Date.now();
    const sessionId = session.id;
    const settings = { ...session.settings, apiKey };
    const record: Run = {
      id: runId,
      at: started,
      status: "running",
      output: "",
      thinking: "",
      elapsed: 0,
      snapshot: {
        settings: { ...settings, apiKey: "" },
        messages: structuredClone(session.messages),
      },
    };
    setWorkspace((w) => ({
      ...w,
      sessions: w.sessions.map((s) =>
        s.id === sessionId
          ? { ...s, runs: [record, ...s.runs].slice(0, 30) }
          : s,
      ),
    }));
    setSelectedRun(runId);
    setTab("editor");
    followOutput.current = true;
    setBusy(true);
    setStreamingThought({ id: "", text: "" });
    setStreamingMessageId("");
    const abort = new AbortController();
    controller.current = abort;
    let text = "";
    let reasoning = "";
    let currentMessageId = uid();
    const texts = new Map<string, string>();
    const trace: Message[] = [];
    const requests: unknown[] = [];
    const updateRun = (values: Partial<Run>) =>
      setWorkspace((w) => ({
        ...w,
        sessions: w.sessions.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                runs: s.runs.map((r) =>
                  r.id === runId
                    ? { ...r, ...values, elapsed: Date.now() - started }
                    : r,
                ),
              }
            : s,
        ),
      }));
    const upsertMessage = (message: Message) => {
      const index = trace.findIndex((m) => m.id === message.id);
      if (index === -1) trace.push(message);
      else trace[index] = { ...trace[index], ...message };
      setWorkspace((w) => ({
        ...w,
        sessions: w.sessions.map((s) => {
          if (s.id !== sessionId) return s;
          const exists = s.messages.some((m) => m.id === message.id);
          return {
            ...s,
            messages: exists
              ? s.messages.map((m) =>
                  m.id === message.id ? { ...m, ...message } : m,
                )
              : [...s.messages, message],
          };
        }),
      }));
      updateRun({ trace: [...trace] });
    };
    try {
      const response = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: pretty({ messages: session.messages, settings }),
        signal: abort.signal,
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || `HTTP ${response.status}`);
      }
      if (!response.body) throw new Error("浏览器不支持流式响应");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let complete = false;
      while (true) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === "runtime") updateRun({ cwd: event.cwd });
          if (event.type === "request") {
            requests.push(event.payload);
            updateRun({
              request: event.payload,
              requests: [...requests],
              turns: event.turn,
            });
          }
          if (event.type === "assistant_start") {
            currentMessageId = event.id;
            setStreamingMessageId(event.id);
            setStreamingThought({ id: event.id, text: "" });
            texts.set(event.id, "");
            upsertMessage({
              id: event.id,
              role: "assistant",
              content: "",
              enabled: true,
            });
          }
          if (event.type === "text") {
            const id = event.id || currentMessageId;
            const content = (texts.get(id) || "") + event.delta;
            texts.set(id, content);
            upsertMessage({ id, role: "assistant", content, enabled: true });
            text = [...texts.values()].filter(Boolean).join("\n\n");
            updateRun({ output: text });
          }
          if (event.type === "assistant" || event.type === "message") {
            upsertMessage(event.message);
            if (event.message.role === "assistant") {
              texts.set(event.message.id, event.message.content);
              text = [...texts.values()].filter(Boolean).join("\n\n");
              updateRun({ output: text });
            }
          }
          if (event.type === "tool_activity") setToolActivity(event);
          if (event.type === "tool_activity_end") setToolActivity(null);
          if (event.type === "thinking") {
            reasoning += event.delta;
            setStreamingThought((previous) => ({
              id: event.id || currentMessageId,
              text: (previous.id === (event.id || currentMessageId) ? previous.text : "") + event.delta,
            }));
            updateRun({ thinking: reasoning });
          }
          if (event.type === "done") {
            complete = true;
            updateRun({
              status:
                event.reason === "length"
                  ? "length"
                  : event.reason === "turn_limit"
                    ? "turn_limit"
                    : "done",
              usage: event.usage,
              turns: event.turns,
              output: text,
            });
            if (event.reason === "turn_limit")
              setNotice("已达到 Agent 最大轮数；可检查轨迹后再次运行继续。");
          }
          if (event.type === "error") throw new Error(event.message);
        }
        if (chunk.done) break;
      }
      if (!complete) throw new Error("连接提前结束，已保留收到的内容。");
    } catch (error) {
      if (abort.signal.aborted) {
        const resolved = new Set(
          trace.filter((m) => m.role === "tool").map((m) => m.toolCallId),
        );
        for (const message of [...trace]) {
          for (const call of message.toolCalls || []) {
            if (resolved.has(call.id)) continue;
            upsertMessage({
              id: uid(),
              role: "tool",
              enabled: true,
              content:
                "执行已停止，未收到该工具的完整结果。操作可能已经部分完成，请检查实际文件状态后再继续。",
              toolCallId: call.id,
              toolName: call.name,
              isError: true,
            });
          }
        }
        updateRun({ status: "stopped", output: text });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        updateRun({ status: "error", error: message, output: text });
        setNotice(message);
      }
    } finally {
      setBusy(false);
      setStreamingMessageId("");
      setToolActivity(null);
      controller.current = null;
    }
  }
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void run();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebar ? "visible" : ""}`}>
        <a className="brand" href="/" onClick={(e) => e.preventDefault()}>
          <span className="brand-icon">π</span>
          <span>
            pi<span className="brand-light">lab</span>
            <small>LLM PLAYGROUND</small>
          </span>
          <span className="version">v0.1</span>
        </a>
        <button
          className="new-experiment"
          disabled={busy || !!session.piSync?.pending}
          onClick={() => createSession()}
        >
          <Plus size={16} /> 新建实验 <kbd>＋</kbd>
        </button>
        <div className="nav-label">工作空间</div>
        <div className="nav-active">
          <FlaskConical size={16} /> 消息实验室{" "}
          <span>{workspace.sessions.length}</span>
        </div>
        <div className="session-heading">
          <span>我的实验</span>
          <button
            className="icon-button"
            disabled={busy || !!session.piSync?.pending}
            title="新建实验"
            onClick={() => createSession()}
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="session-list">
          {workspace.sessions.map((s) => (
            <button
              key={s.id}
              disabled={busy || !!session.piSync?.pending}
              className={`session-item ${s.id === session.id ? "selected" : ""}`}
              onClick={() => {
                setFollowPi(false);
                setWorkspace((w) => ({ ...w, active: s.id }));
                setSelectedRun(undefined);
                setSidebar(false);
              }}
            >
              <MessageSquare size={14} />
              <span>{s.title || "未命名实验"}</span>
              {s.id === session.id && <i />}
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          <div className="local-info">
            <span className="green-dot" />
            <span>
              本地工作空间<small>实验自动保存在此浏览器</small>
            </span>
          </div>
          <button
            className="help-button"
            onClick={() =>
              setNotice(
                "修改任意角色和历史消息后，点击「运行」生成下一条 assistant 消息。⌘ / Ctrl + Enter 快速运行。",
              )
            }
          >
            <CircleHelp size={16} /> 使用帮助 <ArrowUpRight size={14} />
          </button>
        </div>
      </aside>
      <main className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button mobile-menu"
              onClick={() => setSidebar(!sidebar)}
              aria-label="打开菜单"
            >
              <Menu size={19} />
            </button>
            <FlaskConical size={16} />
            <span>消息实验室</span>
            <ChevronRight size={13} />
            <span className="current-crumb">
              {session.title || "未命名实验"}
            </span>
          </div>
          <div className="topbar-actions">
            <span className="saved">
              <Check size={13} /> 自动保存
            </span>
            <button
              className="text-button"
              onClick={() => fileInput.current?.click()}
              disabled={busy || !!session.piSync?.pending}
            >
              <Upload size={14} /> 导入
            </button>
            <button className="text-button" onClick={exportSession}>
              <Download size={14} /> 导出
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(e) => {
                void importFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </div>
        </header>
        <div className="workspace-header">
          <div>
            <div className="eyebrow">BUILD. RUN. REFINE.</div>
            <div className="title-row">
              <input
                aria-label="实验名称"
                className="experiment-title"
                value={session.title}
                disabled={busy || !!session.piSync?.pending}
                onChange={(e) => patch({ title: e.target.value })}
                maxLength={200}
              />
              <span className="draft-tag">
                {session.piSync ? "Pi 上下文" : "草稿"}
              </span>
            </div>
            <p>自由编排上下文，探索每一条消息如何改变模型的回答。</p>
          </div>
          {isSubscription ? (
            <label className="button secondary connection-button model-switcher">
              <span className="connection-dot" />
              <select
                aria-label="切换模型"
                disabled={busy || !!session.piSync?.pending}
                value={session.settings.model}
                onChange={(e) => setting("model", e.target.value)}
              >
                {modelOptions.map((model) => (
                  <option key={model.id} value={model.id}>
                    Pi · {model.id}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} />
            </label>
          ) : (
            <button
              className="button secondary connection-button"
              onClick={() => setConnection(true)}
              disabled={busy || !!session.piSync?.pending}
            >
              <span className="connection-dot" />
              <span>{session.settings.model}</span>
              <ChevronDown size={14} />
            </button>
          )}
        </div>
        <section className="pi-sync-panel" aria-label="Pi 实时同步">
          <div className="pi-sync-heading">
            <span
              className={piSource?.online ? "green-dot" : "sync-offline-dot"}
            />
            <strong>Pi 实时同步</strong>
            <select
              aria-label="Pi 会话"
              value={session.piSync?.id || ""}
              disabled={busy || !!session.piSync?.pending}
              onChange={(e) => {
                if (e.target.value) {
                  setFollowPi(false);
                  void readPiSession(e.target.value, true)
                    .then(() => setTab("editor"))
                    .catch((e) => setNotice(e.message));
                }
              }}
            >
              <option value="">
                选择 Pi 会话（{piSessions.filter((s) => s.online).length}{" "}
                个在线）
              </option>
              {piSessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.online ? "●" : "○"} {s.name} · {s.model?.id || "未选模型"}{" "}
                  · {s.sessionId.slice(-8)}
                </option>
              ))}
            </select>
            <label className="sync-follow">
              <input
                type="checkbox"
                checked={followPi}
                onChange={(e) => setFollowPi(e.target.checked)}
              />
              跟随最新会话
            </label>
          </div>
          {!session.piSync ? (
            <p>
              {syncError ||
                (syncInstalled
                  ? "新开的 Pi 会话自动同步；已打开的 Pi 请执行 /reload。选中会话后，网页修改可应用到 Pi。"
                  : "运行 npm run install:sync 安装扩展，然后在 Pi 执行 /reload，即可同步任何目录下的对话。")}
            </p>
          ) : (
            <>
              <div className="pi-sync-status" role="status">
                <span>
                  {syncError ||
                    (session.piSync.pending
                      ? "等待 Pi 确认修改…"
                      : session.piSync.dirty
                        ? piSource?.revision !== session.piSync.revision
                          ? "有本地修改 · Pi 上下文已有变化，请核对后重新同步"
                          : "有本地修改 · 尚未应用到 Pi"
                        : piSource?.error ||
                          (piSource?.online
                            ? piSource.busy
                              ? "Pi 正在执行 · 消息持续同步"
                              : piSource.applied
                                ? `修改已应用${piSource.lastAppliedRequest ? ` · 已用于第 ${piSource.lastAppliedRequest} 次请求` : " · 下次请求生效"}`
                                : "实时同步中 · 可编辑历史上下文"
                            : piSource?.applied
                              ? `Pi 已离线 · 修改已用于第 ${piSource.lastAppliedRequest} 次请求，恢复会话后可继续`
                              : "Pi 已离线 · 可查看历史，恢复 Pi 后继续编辑"))}
                </span>
                <div className="pi-sync-actions">
                  {session.piSync.pending && !piSource?.online && (
                    <button
                      className="text-button"
                      onClick={async () => {
                        const source = session.piSync!;
                        try {
                          const response = await fetch(
                            `/api/pi-sync/${encodeURIComponent(source.id)}/cancel`,
                            {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({
                                commandId: source.pending,
                              }),
                            },
                          );
                          const data = await response.json();
                          if (!response.ok) throw new Error(data.error);
                          setWorkspace((w) => ({
                            ...w,
                            sessions: w.sessions.map((s) =>
                              s.id === session.id && s.piSync
                                ? {
                                    ...s,
                                    piSync: { ...s.piSync, pending: undefined },
                                  }
                                : s,
                            ),
                          }));
                        } catch (e) {
                          setNotice((e as Error).message);
                        }
                      }}
                    >
                      保留草稿并解除等待
                    </button>
                  )}
                  <button
                    className="text-button"
                    disabled={
                      busy || !!session.piSync.pending || !session.piSync.dirty
                    }
                    onClick={() =>
                      void readPiSession(session.piSync!.id, false, true).catch(
                        (e) => setNotice(e.message),
                      )
                    }
                  >
                    放弃修改并同步
                  </button>
                  <button
                    className="button primary"
                    disabled={
                      busy ||
                      submittingSync ||
                      !!session.piSync.pending ||
                      !session.piSync.dirty ||
                      !piSource?.online ||
                      piSource.busy ||
                      piSource.revision !== session.piSync.revision
                    }
                    onClick={() => void applyToPi()}
                  >
                    应用到 Pi
                  </button>
                </div>
              </div>
              {piSource?.ack?.status === "rejected" && (
                <p className="error-text">
                  Pi 拒绝了上次修改：{piSource.ack.error}
                </p>
              )}
              <p className="pi-sync-path" title={piSource?.sessionFile}>
                {piSource?.cwd} · 在 Pi 终端继续对话；模型和工具由 Pi
                管理，网页参数用于独立分支实验。
              </p>
            </>
          )}
        </section>
        <div className="workspace-grid">
          <section className="editor-pane">
            <div className="tabs-row">
              <div className="tabs">
                <button
                  className={tab === "editor" ? "active" : ""}
                  onClick={() => setTab("editor")}
                >
                  <Layers size={15} /> 消息编排{" "}
                  <span>{session.messages.length}</span>
                </button>
                <button
                  className={tab === "request" ? "active" : ""}
                  onClick={() => setTab("request")}
                >
                  <Braces size={15} /> 请求检查
                </button>
                <button
                  className={tab === "history" ? "active" : ""}
                  onClick={() => setTab("history")}
                >
                  <History size={15} /> 运行记录
                  {session.runs.length > 0 && (
                    <span>{session.runs.length}</span>
                  )}
                </button>
              </div>
              <span className="editor-hint">
                {tab === "editor" ? "所有消息均可编辑" : "仅保留当前会话记录"}
              </span>
            </div>
            <div
              className="editor-scroll"
              ref={editorScroll}
              onScroll={(e) => {
                const element = e.currentTarget;
                followOutput.current =
                  element.scrollHeight -
                    element.scrollTop -
                    element.clientHeight <
                  100;
              }}
            >
              {tab === "editor" && (
                <>
                  <div className="context-note">
                    <span>
                      <Layers size={14} />{" "}
                      {isSubscription
                        ? "system → instructions，其余消息按下方顺序发送"
                        : "上下文按下方顺序发送给模型"}
                    </span>
                    <span>{enabled.length} 条启用</span>
                  </div>
                  <div className="message-list">
                    {session.messages.map((message, index) => (
                      <div className="message-group" key={message.id}>
                        <article
                          className={`message-card ${message.role} ${!message.enabled ? "disabled" : ""}`}
                        >
                          <div className="message-toolbar">
                            <span className="message-number">
                              {String(index + 1).padStart(2, "0")}
                            </span>
                            <span className={`role-dot ${message.role}`} />
                            <select
                              aria-label={`消息 ${index + 1} 角色`}
                              value={message.role}
                              disabled={busy || !!session.piSync?.pending}
                              onChange={(e) =>
                                changeMessage(message.id, {
                                  role: e.target.value as Message["role"],
                                  toolCalls: undefined,
                                  toolCallId: undefined,
                                  toolName: undefined,
                                  isError: undefined,
                                  providerState: undefined,
                                })
                              }
                            >
                              {roles.map((role) => (
                                <option key={role}>{role}</option>
                              ))}
                            </select>
                            {message.role === "system" && (
                              <span className="role-description">全局指令</span>
                            )}
                            {message.role === "developer" && (
                              <span className="role-description">
                                开发者指令
                              </span>
                            )}
                            {message.role === "tool" && (
                              <span
                                className={`role-description ${message.isError ? "error-text" : ""}`}
                              >
                                {message.toolName || "工具结果"}
                                {message.isError ? " · 失败" : ""}
                              </span>
                            )}
                            <div className="message-actions">
                              <button
                                className="icon-button"
                                disabled={busy || index === 0}
                                title="上移消息"
                                onClick={() => move(index, -1)}
                              >
                                <ArrowUp size={14} />
                              </button>
                              <button
                                className="icon-button"
                                disabled={
                                  busy || index === session.messages.length - 1
                                }
                                title="下移消息"
                                onClick={() => move(index, 1)}
                              >
                                <ArrowDown size={14} />
                              </button>
                              <span className="toolbar-divider" />
                              <button
                                className="icon-button"
                                disabled={busy || !!session.piSync?.pending}
                                title={
                                  message.enabled
                                    ? "从上下文排除此消息"
                                    : "启用消息"
                                }
                                onClick={() =>
                                  changeMessage(message.id, {
                                    enabled: !message.enabled,
                                  })
                                }
                              >
                                {message.enabled ? (
                                  <Eye size={14} />
                                ) : (
                                  <EyeOff size={14} />
                                )}
                              </button>
                              <button
                                className="icon-button"
                                disabled={busy || !!session.piSync?.pending}
                                title="复制消息"
                                onClick={() => {
                                  const messages = [...session.messages];
                                  messages.splice(index + 1, 0, {
                                    ...message,
                                    id: uid(),
                                  });
                                  patch({ messages });
                                }}
                              >
                                <Copy size={14} />
                              </button>
                              <button
                                className="icon-button delete"
                                disabled={busy || !!session.piSync?.pending}
                                title="删除消息"
                                onClick={() =>
                                  patch({
                                    messages: session.messages.filter(
                                      (m) => m.id !== message.id,
                                    ),
                                  })
                                }
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          </div>
                          {message.role === "tool" && (
                            <div className="tool-result-fields">
                              <label>
                                工具名称
                                <input
                                  aria-label={`消息 ${index + 1} 工具名称`}
                                  disabled={busy || !!session.piSync?.pending}
                                  value={message.toolName || ""}
                                  onChange={(e) =>
                                    changeMessage(message.id, {
                                      toolName: e.target.value,
                                    })
                                  }
                                />
                              </label>
                              <label>
                                Call ID
                                <input
                                  aria-label={`消息 ${index + 1} Call ID`}
                                  disabled={busy || !!session.piSync?.pending}
                                  value={message.toolCallId || ""}
                                  onChange={(e) =>
                                    changeMessage(message.id, {
                                      toolCallId: e.target.value,
                                    })
                                  }
                                />
                              </label>
                              <label className="tool-error-toggle">
                                <input
                                  type="checkbox"
                                  disabled={busy || !!session.piSync?.pending}
                                  checked={message.isError || false}
                                  onChange={(e) =>
                                    changeMessage(message.id, {
                                      isError: e.target.checked,
                                    })
                                  }
                                />
                                错误结果
                              </label>
                            </div>
                          )}
                          <textarea
                            aria-label={`消息 ${index + 1} 内容`}
                            value={message.content}
                            ref={busy && streamingMessageId === message.id ? streamingTextarea : undefined}
                            readOnly={busy}
                            disabled={(busy && streamingMessageId !== message.id) || !!session.piSync?.pending}
                            placeholder={
                              message.role === "tool"
                                ? "工具返回的文本或 JSON；可以在这里修改后重新运行…"
                                : message.role === "assistant"
                                  ? "在这里编辑或预填模型回答…"
                                  : "输入消息内容…"
                            }
                            onChange={(e) =>
                              changeMessage(message.id, {
                                content: e.target.value,
                              })
                            }
                            style={{
                              height: Math.min(
                                380,
                                Math.max(
                                  86,
                                  (message.content.split("\n").length +
                                    Math.ceil(message.content.length / 80)) *
                                    24 +
                                    30,
                                ),
                              ),
                            }}
                          />
                          {message.role === "assistant" && (
                            <div className="tool-calls">
                              {message.toolCalls?.map((call, callIndex) => (
                                <details
                                  className="tool-call"
                                  key={callIndex}
                                  open
                                >
                                  <summary>
                                    <Terminal size={13} />
                                    <strong>{call.name || "工具调用"}</strong>
                                    <span>TOOL CALL {callIndex + 1}</span>
                                  </summary>
                                  <div className="tool-call-fields">
                                    <label>
                                      名称
                                      <input
                                        aria-label={`消息 ${index + 1} 调用 ${callIndex + 1} 名称`}
                                        value={call.name}
                                        disabled={
                                          busy || !!session.piSync?.pending
                                        }
                                        onChange={(e) =>
                                          changeCall(message, callIndex, {
                                            name: e.target.value,
                                          })
                                        }
                                      />
                                    </label>
                                    <label>
                                      Call ID
                                      <input
                                        aria-label={`消息 ${index + 1} 调用 ${callIndex + 1} ID`}
                                        value={call.id}
                                        disabled={
                                          busy || !!session.piSync?.pending
                                        }
                                        onChange={(e) =>
                                          changeCall(message, callIndex, {
                                            id: e.target.value,
                                          })
                                        }
                                      />
                                    </label>
                                    <label className="tool-arguments">
                                      参数 JSON
                                      <textarea
                                        aria-label={`消息 ${index + 1} 调用 ${callIndex + 1} 参数`}
                                        value={call.arguments}
                                        disabled={
                                          busy || !!session.piSync?.pending
                                        }
                                        spellCheck={false}
                                        onChange={(e) =>
                                          changeCall(message, callIndex, {
                                            arguments: e.target.value,
                                          })
                                        }
                                      />
                                    </label>
                                    <div className="tool-call-actions">
                                      <button
                                        className="text-button"
                                        disabled={
                                          busy || !!session.piSync?.pending
                                        }
                                        onClick={() =>
                                          addToolResult(message, call)
                                        }
                                      >
                                        <Plus size={12} />
                                        补充工具结果
                                      </button>
                                      <button
                                        className="text-button"
                                        disabled={
                                          busy || !!session.piSync?.pending
                                        }
                                        onClick={() =>
                                          changeMessage(message.id, {
                                            toolCalls:
                                              message.toolCalls?.filter(
                                                (_, i) => i !== callIndex,
                                              ),
                                          })
                                        }
                                      >
                                        移除此调用
                                      </button>
                                    </div>
                                  </div>
                                </details>
                              ))}
                              <button
                                className="text-button add-tool-call"
                                disabled={busy || !!session.piSync?.pending}
                                onClick={() =>
                                  changeMessage(message.id, {
                                    toolCalls: [
                                      ...(message.toolCalls || []),
                                      {
                                        id: `call_${uid().replaceAll("-", "")}`,
                                        name: "read",
                                        arguments: '{"path":"README.md"}',
                                      },
                                    ],
                                  })
                                }
                              >
                                <Plus size={12} />
                                添加工具调用
                              </button>
                            </div>
                          )}
                          {busy && streamingMessageId === message.id && (
                            <div className="stream-status" role="status">
                              <span className="run-dot running" />
                              {message.content ? "流式接收中…" : streamingThought.text ? "正在思考…" : "等待模型输出…"}
                            </div>
                          )}
                          {busy && streamingThought.id === message.id && streamingThought.text && (
                            <details className="message-thinking" open>
                              <summary>思考摘要 · 实时</summary>
                              <pre>{streamingThought.text}</pre>
                            </details>
                          )}
                          {!(busy && streamingThought.id === message.id && streamingThought.text) && !!message.providerState?.thinking.some(
                            (b) => b.thinking,
                          ) && (
                            <details className="message-thinking">
                              <summary>思考内容</summary>
                              <pre>
                                {message.providerState.thinking
                                  .map((b) => b.thinking)
                                  .join("\n")}
                              </pre>
                            </details>
                          )}
                          <div className="message-footer">
                            <span>
                              {message.content.length.toLocaleString()} 字符
                              {!message.enabled && " · 已排除"}
                            </span>
                            <button
                              disabled={busy || !!session.piSync?.pending}
                              onClick={() =>
                                createSession({
                                  ...session,
                                  title: `${session.title} · 分支`,
                                  messages: session.messages.slice(
                                    0,
                                    index + 1,
                                  ),
                                })
                              }
                              title="将截至此处的消息复制到新实验"
                            >
                              <GitBranch size={12} /> 从此处分支
                            </button>
                          </div>
                        </article>
                        <button
                          className="insert-message"
                          disabled={busy || !!session.piSync?.pending}
                          onClick={() => addMessage(index)}
                          title="在此处插入消息"
                        >
                          <Plus size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                  {session.piSync && piSource?.partial && (
                    <div
                      className="tool-activity pi-stream-preview"
                      role="status"
                    >
                      <strong>Pi 正在生成 · 流式同步</strong>
                      <pre>
                        {piSource.partial.content ||
                          piSource.partial.providerState?.thinking.map((b) => b.thinking).join("\n") ||
                          (piSource.partial.toolCalls?.length
                            ? pretty(piSource.partial.toolCalls)
                            : "正在思考…")}
                      </pre>
                    </div>
                  )}
                  {toolActivity && (
                    <div className="tool-activity" role="status">
                      <Terminal size={15} />
                      <strong>正在执行 {toolActivity.name}</strong>
                      <pre>{pretty(toolActivity.arguments)}</pre>
                      {toolActivity.output && <pre>{toolActivity.output}</pre>}
                    </div>
                  )}
                  <button
                    className="add-message"
                    disabled={busy || !!session.piSync?.pending}
                    onClick={() => addMessage()}
                  >
                    <Plus size={16} />
                    <span>添加消息</span>
                    <small>任意角色，自由插入</small>
                  </button>
                  <div className="editor-tip">
                    <CircleHelp size={14} />
                    <span>
                      修改历史消息后再次运行，即可观察上下文变化带来的影响。
                    </span>
                  </div>
                </>
              )}
              {tab === "request" && (
                <div className="inspector">
                  <div className="section-heading">
                    <span>请求与协议</span>
                    <button
                      className="text-button"
                      onClick={() =>
                        void copy(
                          pretty(
                            activeRun?.request || {
                              settings: {
                                ...session.settings,
                                apiKey: undefined,
                              },
                              messages: enabled,
                            },
                          ),
                        )
                      }
                    >
                      <Copy size={13} /> 复制
                    </button>
                  </div>
                  <p>
                    运行时会捕获 Pi 实际发送的请求体。API Key
                    不会出现在这里。下方配置草稿随编辑更新；已发送的请求保持不变。
                  </p>
                  <h4>当前配置与消息草稿</h4>
                  <pre>
                    {pretty({
                      protocol: session.settings.protocol,
                      baseUrl: session.settings.baseUrl,
                      model: session.settings.model,
                      reasoningEffort,
                      toolMode: session.settings.toolMode,
                      workingDirectory:
                        session.settings.workingDirectory || runtimeCwd,
                      maxTurns: session.settings.maxTurns,
                      temperature: session.settings.temperature,
                      maxTokens: session.settings.maxTokens,
                      messages: enabled.map(
                        ({ id: _id, enabled: _enabled, ...message }) => message,
                      ),
                    })}
                  </pre>
                  <h4>
                    本次运行 · 实际请求体（
                    {activeRun?.requests?.length ||
                      (activeRun?.request ? 1 : 0)}{" "}
                    轮）
                  </h4>
                  {activeRun?.requests?.length ? (
                    activeRun.requests.map((request, i) => (
                      <details
                        className="request-turn"
                        key={i}
                        open={i === activeRun.requests!.length - 1}
                      >
                        <summary>第 {i + 1} 轮请求</summary>
                        <pre>{pretty(request)}</pre>
                      </details>
                    ))
                  ) : (
                    <pre>
                      {activeRun?.request
                        ? pretty(activeRun.request)
                        : "// 尚未发送请求。运行后会显示真实 payload。"}
                    </pre>
                  )}
                </div>
              )}
              {tab === "history" && (
                <div className="history-list">
                  {!session.runs.length && (
                    <div className="empty-panel">
                      <History size={28} />
                      <h3>每次探索，都有迹可循</h3>
                      <p>
                        运行后可查看回答、耗时和原始请求，
                        <br />
                        也可以恢复当时的消息与参数。
                      </p>
                    </div>
                  )}
                  {session.runs.map((record, index) => (
                    <article
                      className={`run-card ${activeRun?.id === record.id ? "selected" : ""}`}
                      key={record.id}
                    >
                      <div className="section-heading">
                        <button
                          className="run-title"
                          onClick={() => setSelectedRun(record.id)}
                        >
                          <span className={`run-dot ${record.status}`} />
                          运行 {session.runs.length - index}
                          <span>
                            {new Date(record.at).toLocaleTimeString("zh-CN")}
                          </span>
                        </button>
                        <button
                          className="text-button"
                          disabled={busy || !!session.piSync?.pending}
                          onClick={() => {
                            patch({
                              settings: record.snapshot.settings,
                              messages: structuredClone(
                                record.snapshot.messages,
                              ),
                            });
                            setTab("editor");
                            setNotice("已恢复该次运行前的消息与参数。");
                          }}
                        >
                          <RotateCcw size={13} /> 恢复输入
                        </button>
                      </div>
                      <div className="run-model">
                        {record.snapshot.settings.model}
                        {" · reasoning: "}
                        {getReasoningEffort(record.snapshot.settings)}
                      </div>
                      <p className={record.error ? "error-text" : ""}>
                        {record.error ||
                          record.output ||
                          (record.status === "running"
                            ? "正在等待模型响应…"
                            : "无文本输出")}
                      </p>
                      {record.thinking && (
                        <details>
                          <summary>思考内容</summary>
                          <pre>{record.thinking}</pre>
                        </details>
                      )}
                      {!!record.trace?.some(
                        (m) => m.toolCalls?.length || m.role === "tool",
                      ) && (
                        <details>
                          <summary>
                            工具轨迹 ·{" "}
                            {
                              record.trace.filter((m) => m.role === "tool")
                                .length
                            }{" "}
                            次调用 · {record.turns} 轮
                          </summary>
                          {record.trace.map((m) => (
                            <div className="trace-step" key={m.id}>
                              <strong>
                                {m.role === "tool"
                                  ? `${m.toolName} ${m.isError ? "· 失败" : "· 结果"}`
                                  : "assistant"}
                              </strong>
                              {m.toolCalls?.map((c) => (
                                <pre key={c.id}>
                                  {c.name}({c.arguments})
                                </pre>
                              ))}
                              {m.content && <pre>{m.content}</pre>}
                            </div>
                          ))}
                        </details>
                      )}
                      <footer>
                        <span>{statusText(record.status)}</span>
                        <span>
                          {(record.elapsed / 1000).toFixed(1)} s{" "}
                          {record.usage &&
                            ` · ${record.usage.input + record.usage.output} tokens`}
                        </span>
                        <button
                          onClick={() => {
                            setSelectedRun(record.id);
                            setTab("request");
                          }}
                        >
                          <Braces size={12} /> 查看请求
                        </button>
                      </footer>
                    </article>
                  ))}
                </div>
              )}
            </div>
            <div className="run-bar">
              <div>
                <span className={`run-dot ${busy ? "running" : ""}`} />
                <span>{busy ? "流式生成中…" : "准备就绪 · 流式输出"}</span>
                <small>
                  {enabled.length} 条消息 · {characters.toLocaleString()} 字符
                </small>
              </div>
              {busy ? (
                <button
                  className="button stop"
                  onClick={() => controller.current?.abort()}
                >
                  <Square size={14} /> 停止生成
                </button>
              ) : (
                <button className="button primary" onClick={() => void run()}>
                  <Play size={14} fill="currentColor" />{" "}
                  {session.piSync ? "在 Pi 终端继续" : "运行"}{" "}
                  {!session.piSync && <kbd>⌘ ↵</kbd>}
                </button>
              )}
            </div>
          </section>
          <aside className="settings-pane">
            <div className="settings-title">
              <Settings2 size={16} />
              <h2>模型配置</h2>
              <span>PARAMETERS</span>
            </div>
            <div className="settings-content">
              <label className="field-label" htmlFor="protocol">
                接口协议 <span>API</span>
              </label>
              <select
                id="protocol"
                className="field-input"
                disabled={busy || !!session.piSync?.pending}
                value={session.settings.protocol}
                onChange={(e) => {
                  const protocol = e.target.value as Settings["protocol"];
                  patch({
                    settings: {
                      ...session.settings,
                      protocol,
                      ...(protocol === "pi-subscription" &&
                      piConnection?.defaultModel
                        ? {
                            model: piConnection.defaultModel,
                            reasoning: true,
                            reasoningEffort: "medium",
                          }
                        : {}),
                    },
                  });
                }}
              >
                {Object.entries(protocolNames).map(([value, name]) => (
                  <option value={value} key={value}>
                    {name}
                  </option>
                ))}
              </select>
              <label className="field-label" htmlFor="model">
                模型 <span>MODEL</span>
              </label>
              {isSubscription ? (
                <select
                  id="model"
                  className="field-input"
                  disabled={busy || !!session.piSync?.pending}
                  value={session.settings.model}
                  onChange={(e) => setting("model", e.target.value)}
                >
                  {modelOptions.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="model"
                  className="field-input"
                  disabled={busy || !!session.piSync?.pending}
                  value={session.settings.model}
                  onChange={(e) => setting("model", e.target.value)}
                  placeholder="输入模型 ID"
                />
              )}
              <p className="field-help model-help">
                {isSubscription
                  ? "选择 Pi 模型后，下一次运行立即使用新模型。"
                  : "填写服务商提供的模型 ID，下一次运行生效。"}
              </p>
              <button
                className="endpoint-button"
                disabled={busy || !!session.piSync?.pending}
                onClick={() => setConnection(true)}
              >
                <span>
                  <span className="connection-dot" />{" "}
                  {isSubscription
                    ? piConnection?.connected
                      ? "Pi 订阅 · 已登录"
                      : "Pi 订阅 · 查看登录状态"
                    : "自定义连接设置"}
                </span>
                <ArrowUpRight size={14} />
              </button>
              <div className="settings-divider" />
              <label className="field-label" htmlFor="tool-mode">
                工具模式 <span>AGENT TOOLS</span>
              </label>
              <select
                id="tool-mode"
                className="field-input"
                disabled={busy || !!session.piSync?.pending}
                value={session.settings.toolMode}
                onChange={(e) =>
                  setting("toolMode", e.target.value as Settings["toolMode"])
                }
              >
                <option value="none">关闭 · 仅生成回答</option>
                <option value="read-only">只读 · 文件与搜索</option>
                <option value="agent">Agent · 文件读写与命令执行</option>
              </select>
              <p className="field-help">
                {session.settings.toolMode === "none"
                  ? "启用后由 Pi 自动执行工具，并将结果交给模型继续处理。"
                  : session.settings.toolMode === "read-only"
                    ? "read · grep · find · ls"
                    : "read · grep · find · ls · bash · edit · write"}
              </p>
              {session.settings.toolMode !== "none" && (
                <>
                  <label className="field-label" htmlFor="working-directory">
                    工具工作目录
                  </label>
                  <input
                    id="working-directory"
                    className="field-input mono-input"
                    disabled={busy || !!session.piSync?.pending}
                    value={session.settings.workingDirectory}
                    placeholder={runtimeCwd || "默认使用服务启动目录"}
                    onChange={(e) =>
                      setting("workingDirectory", e.target.value)
                    }
                  />
                  <p className="field-help">
                    本机真实执行，目录是起点而非隔离沙箱。修改历史不会回滚已产生的文件改动。
                  </p>
                  <label className="field-label" htmlFor="max-turns">
                    最大 Agent 轮数 <span>1–50</span>
                  </label>
                  <input
                    id="max-turns"
                    className="field-input mono-input"
                    type="number"
                    min="1"
                    max="50"
                    disabled={busy || !!session.piSync?.pending}
                    value={session.settings.maxTurns}
                    onChange={(e) => setting("maxTurns", +e.target.value)}
                  />
                  <p className="field-help">
                    每轮模型生成后自动执行工具，直到回答完成、停止或达到上限。
                  </p>
                </>
              )}
              <div className="settings-divider" />
              <label className="field-label" htmlFor="temperature">
                Temperature{" "}
                <span className="value-pill">
                  {session.settings.temperature.toFixed(2)}
                </span>
              </label>
              <input
                id="temperature"
                className="slider"
                type="range"
                min="0"
                max="2"
                step="0.05"
                disabled={busy || isSubscription || reasoningEffort !== "off"}
                value={session.settings.temperature}
                onChange={(e) => setting("temperature", +e.target.value)}
              />
              <div className="range-labels">
                <span>
                  精确 <small>0</small>
                </span>
                <span>
                  <small>2</small> 发散
                </span>
              </div>
              <p className="field-help">
                {isSubscription
                  ? "Pi 订阅不发送 Temperature，使用模型默认采样。"
                  : reasoningEffort !== "off"
                    ? "推理模式下不发送 Temperature。"
                    : "控制输出的随机程度。数值越低，回答越稳定。"}
              </p>
              <label className="field-label" htmlFor="max-tokens">
                最大输出 Tokens
              </label>
              <input
                id="max-tokens"
                className="field-input mono-input"
                type="number"
                min="1"
                max="128000"
                disabled={busy || isSubscription}
                value={session.settings.maxTokens}
                onChange={(e) => setting("maxTokens", +e.target.value)}
              />
              <p className="field-help">
                {isSubscription
                  ? "订阅接口不接受输出长度参数，由模型与服务控制。"
                  : "限制本次生成的最大长度。"}
              </p>
              <label className="field-label" htmlFor="reasoning-effort">
                推理强度 <span>REASONING EFFORT</span>
              </label>
              <select
                id="reasoning-effort"
                aria-label="Reasoning effort"
                className="field-input"
                disabled={busy || supportedEfforts.length < 2}
                value={reasoningEffort}
                onChange={(e) => {
                  const effort = e.target.value as ReasoningEffort;
                  patch({
                    settings: {
                      ...session.settings,
                      reasoningEffort: effort,
                      reasoning: effort !== "off",
                    },
                  });
                }}
              >
                {supportedEfforts.map((effort) => {
                  const mapped = isSubscription
                    ? subscriptionModel?.reasoningEffortMap?.[effort]
                    : undefined;
                  return (
                    <option key={effort} value={effort}>
                      {effort === "off" ? "off · 关闭推理" : effort}
                      {mapped && mapped !== effort ? `（发送 ${mapped}）` : ""}
                    </option>
                  );
                })}
              </select>
              <p className="field-help">
                {supportedEfforts.length === 1 && supportedEfforts[0] === "off"
                  ? "当前模型不支持调整推理强度。"
                  : isSubscription
                    ? "按 Pi 模型能力列出档位，下一次运行生效。实际发送值可在请求检查中查看。"
                    : "通过 Pi 转换为对应协议的推理参数；实际支持范围取决于服务商和模型。"}
              </p>
              <div className="settings-divider" />
              <div className="section-heading">
                <h3>本次运行</h3>
                <span className="tiny-label">METRICS</span>
              </div>
              <div className="metrics">
                <div>
                  <span>输入 Tokens</span>
                  <strong>
                    {activeRun?.usage?.input?.toLocaleString() ?? "—"}
                  </strong>
                </div>
                <div>
                  <span>输出 Tokens</span>
                  <strong>
                    {activeRun?.usage?.output?.toLocaleString() ?? "—"}
                  </strong>
                </div>
                <div>
                  <span>运行耗时</span>
                  <strong>
                    {activeRun
                      ? `${(activeRun.elapsed / 1000).toFixed(1)} s`
                      : "—"}
                  </strong>
                </div>
                <div>
                  <span>状态</span>
                  <strong
                    className={
                      activeRun?.status === "error" ? "error-text" : ""
                    }
                  >
                    {activeRun ? statusText(activeRun.status) : "未运行"}
                  </strong>
                </div>
              </div>
              {activeRun?.error && (
                <div className="error-box">{activeRun.error}</div>
              )}
              <div className="engine-card">
                <div>
                  <Terminal size={15} />
                  <strong>Powered by Pi</strong>
                  <span>AGENT CORE</span>
                </div>
                <p>
                  直接编辑上下文，以真实请求
                  <br />
                  观察模型行为。
                </p>
                <button onClick={() => setTab("request")}>
                  检查请求数据 <ArrowUpRight size={13} />
                </button>
              </div>
              <button
                className="delete-session"
                disabled={busy || !!session.piSync?.pending}
                onClick={() => {
                  if (workspace.sessions.length === 1) {
                    const next = newSession();
                    setWorkspace({ sessions: [next], active: next.id });
                  } else {
                    const remaining = workspace.sessions.filter(
                      (s) => s.id !== session.id,
                    );
                    setWorkspace({
                      sessions: remaining,
                      active: remaining[0].id,
                    });
                  }
                  setNotice("已删除当前实验。");
                }}
              >
                <Trash2 size={13} /> 删除当前实验
              </button>
            </div>
          </aside>
        </div>
        <footer className="app-footer">
          <span>
            <span className="green-dot" /> Local-first workspace
          </span>
          <span>消息保存在浏览器 · API Key 仅驻留内存</span>
          <span>CRAFT YOUR CONTEXT.</span>
        </footer>
      </main>
      {notice && (
        <div className="toast" role="status">
          <CircleHelp size={16} />
          <span>{notice}</span>
          <button
            className="icon-button"
            onClick={() => setNotice("")}
            aria-label="关闭通知"
          >
            <X size={14} />
          </button>
        </div>
      )}
      {connection && (
        <div className="modal-backdrop" onClick={() => setConnection(false)}>
          <section
            className="connection-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="connection-heading"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-heading">
              <span className="modal-icon">
                <Settings2 size={21} />
              </span>
              <button
                className="icon-button"
                onClick={() => setConnection(false)}
                aria-label="关闭连接设置"
              >
                <X size={19} />
              </button>
            </div>
            <h2 id="connection-heading">
              {isSubscription ? "使用 Pi 订阅" : "连接你的模型"}
            </h2>
            {isSubscription ? (
              <>
                <div className="subscription-status">
                  <span className="green-dot" />
                  <strong>
                    {piConnection?.connected
                      ? "已复用本机 Pi 登录"
                      : "尚未检测到 Pi 订阅登录"}
                  </strong>
                  <span>OpenAI Codex</span>
                </div>
                <p className="field-help">
                  直接使用 Pi 的订阅额度，无需填写 API Key。凭证只在本地后端由
                  Pi 管理，并使用 Pi 原有的锁机制自动刷新。
                </p>
                <div className="connection-info">
                  <CircleHelp size={15} />
                  <span>
                    {piConnection?.connected
                      ? `当前默认模型：${piConnection.defaultModel}。开头的 system 作为 instructions 发送，developer / user / assistant 保留原始顺序。订阅请求固定使用 Pi 内置的 OpenAI Codex 地址。`
                      : "请先在终端运行 pi，使用 /login 登录 OpenAI Codex，然后刷新本页面。"}
                  </span>
                </div>
              </>
            ) : (
              <>
                <p>使用云端 API，或连接 Ollama、vLLM 等本地兼容接口。</p>
                <label className="field-label" htmlFor="base-url">
                  Base URL
                </label>
                <input
                  autoFocus
                  id="base-url"
                  className="field-input mono-input"
                  value={session.settings.baseUrl}
                  onChange={(e) => setting("baseUrl", e.target.value)}
                  placeholder="https://api.openai.com/v1"
                />
                <label className="field-label" htmlFor="api-key">
                  API Key <span>可选</span>
                </label>
                <input
                  id="api-key"
                  className="field-input mono-input"
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-… 或使用服务端环境变量"
                />
                <p className="field-help">
                  Key
                  仅保留在当前页面内存中，不写入浏览器存储或导出文件。留空时使用服务端环境变量；本地无鉴权接口可直接留空。
                </p>
                <div className="connection-info">
                  <CircleHelp size={15} />
                  <span>
                    URL 填接口根地址（如 /v1），无需包含
                    /chat/completions。不同协议需使用对应服务地址。
                  </span>
                </div>
              </>
            )}
            <button
              className="button primary modal-save"
              onClick={() => setConnection(false)}
            >
              <Check size={15} /> 完成设置
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
function statusText(status: string) {
  return (
    (
      {
        running: "生成中",
        done: "已完成",
        length: "达到长度上限",
        turn_limit: "达到 Agent 轮次上限",
        stopped: "已停止",
        error: "运行失败",
      } as Record<string, string>
    )[status] || status
  );
}
