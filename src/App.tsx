import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CircleHelp, X } from "lucide-react";
import {
  defaults, fileSchema, getReasoningEffort, messageSchema, reasoningEfforts,
  type Message, type ReasoningEffort, type Settings, type ToolCall,
} from "../shared/schema";
import type { PiLiveDetail, PiLiveSession } from "../shared/pi-sync";
import type { GptSessionSummary } from "../shared/gpt-sessions";
import { piSessionIdentity } from "../shared/workspace";
import { addToolResult as createToolResult, completeToolBranchEnd, deleteMessageWithToolPairs, deleteToolCallWithResult, patchMessageWithToolPairs, patchToolCallWithResult, toolHistoryError } from "../shared/tool-history";
import { useProjectWorkspace, type Run, type Session, type Workspace } from "./workspace-store";
import { newSession, uid, loadLegacyWorkspace, parseToolArguments } from "./utils/session";
import { contextTokenMetrics } from "./utils/context-tokens";
import { buildForkMessages } from "../shared/session-fork";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { MessageStream } from "./components/MessageStream";
import { ComposerBar } from "./components/ComposerBar";
import { RightPanel } from "./components/RightPanel";
import { RequestInspector } from "./components/RequestInspector";
import { RunHistory } from "./components/RunHistory";
import { SessionForkModal } from "./components/SessionForkModal";
import { DiagnosticsView } from "./components/DiagnosticsView";
import { installGlobalErrorLogging, reportClientDiagnostic } from "./utils/logger";

type DebugPanel = "request" | "history" | "diagnostics";
type PiConnection = {
  connected: boolean; provider: string; defaultModel?: string;
  models: { id: string; name: string; reasoningEfforts: ReasoningEffort[]; reasoningEffortMap?: Partial<Record<ReasoningEffort, string | null>> }[];
};
type ToolActivity = { name: string; arguments: unknown; output: string };
type CompactedMessage = Message & { compactedByModel?: boolean; modelSummary?: string };
type WorkerWakeNotice = { sessionId: string; cwd: string; names: string[] };
type WorkerReview = Pick<WorkerWakeNotice, "sessionId" | "cwd" | "names">;
type ForkNotice = { sourceId: string; forkId: string; title: string };
type SessionStreamView = { streamingId: string; thinking: string; toolActivity: ToolActivity | null };
type RunControl = { sessionId: string; runId: string; lastSeq: number; shouldSubscribe: boolean; readerController?: AbortController; resume?: () => void };
const emptyStreamView: SessionStreamView = { streamingId: "", thinking: "", toolActivity: null };
const activeWorkerStatuses = new Set(["starting", "running", "waiting_input"]);
const pretty = (value: unknown) => JSON.stringify(value, null, 2);

function normalizedWorkerCwd(value: string) {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "/";
}
function workerDispatches(call: ToolCall): { name: string; cwd?: string }[] {
  const args = parseToolArguments(call.arguments);
  if (call.name === "gpt_session_create" || call.name === "gpt_session_send")
    return typeof args.name === "string" && args.name.trim() ? [{ name: args.name.trim(), ...(typeof args.cwd === "string" ? { cwd: args.cwd } : {}) }] : [];
  if (call.name === "gpt_session_batch" && Array.isArray(args.tasks))
    return args.tasks.flatMap((task: unknown) => task && typeof task === "object" && typeof (task as Record<string, unknown>).name === "string"
      ? [{ name: ((task as Record<string, unknown>).name as string).trim(), ...(typeof (task as Record<string, unknown>).cwd === "string" ? { cwd: (task as Record<string, unknown>).cwd as string } : {}) }]
      : []).filter((task) => !!task.name);
  return [];
}
function sessionOwnsWorker(session: Session, workerName: string, workerCwd: string, runtimeCwd: string) {
  const expectedCwd = normalizedWorkerCwd(workerCwd);
  const defaultCwd = session.settings.workingDirectory.trim() || runtimeCwd;
  return session.messages.some((message) => message.toolCalls?.some((call) => workerDispatches(call).some((dispatch) =>
    dispatch.name === workerName && normalizedWorkerCwd(dispatch.cwd?.trim() || defaultCwd) === expectedCwd)));
}
function workerSignature(worker: GptSessionSummary, cwd: string) {
  const version = typeof worker.replySequence === "number"
    ? ["reply", worker.replySequence]
    : ["turn", worker.updatedAt, worker.lastReplyPreview];
  return JSON.stringify([normalizedWorkerCwd(cwd), worker.id, ...version]);
}
function workerNoticeNames(content: string) {
  const match = /^后台 GPT 工兵已交卷：(.+?)。请使用 gpt_session_read/.exec(content.trim());
  return match ? [...match[1].matchAll(/「([^」]+)」/g)].map((item) => item[1]) : [];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && !!entry) : [];
}
function compactionEntries(event: Record<string, unknown>) {
  const entries: { ids: string[]; summary?: string }[] = [];
  const summaryValue = [event.modelSummary, event.summary, event.content].find((value) => typeof value === "string" && value.trim());
  const defaultSummary = typeof summaryValue === "string" ? summaryValue : undefined;
  for (const key of ["groups", "compactedGroups", "items"]) {
    const groups = event[key];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || typeof group !== "object") continue;
      const item = group as Record<string, unknown>;
      const ids = ["messageIds", "ids", "messages", "toolCallIds"].flatMap((field) => stringList(item[field]));
      const summary = [item.modelSummary, item.summary].find((value) => typeof value === "string" && value.trim());
      if (ids.length) entries.push({ ids: [...new Set(ids)], summary: typeof summary === "string" ? summary : defaultSummary });
    }
  }
  for (const key of ["messages", "compactedMessages"]) {
    if (!Array.isArray(event[key])) continue;
    for (const value of event[key] as unknown[]) {
      if (!value || typeof value !== "object") continue;
      const item = value as Record<string, unknown>;
      const id = typeof item.id === "string" ? item.id : typeof item.messageId === "string" ? item.messageId : "";
      const summary = [item.modelSummary, item.summary].find((entry) => typeof entry === "string" && entry.trim());
      if (id) entries.push({ ids: [id], summary: typeof summary === "string" ? summary : defaultSummary });
    }
  }
  const directIds = ["messageIds", "compactedMessageIds", "ids", "toolCallIds"].flatMap((key) => stringList(event[key]));
  if (directIds.length) entries.push({ ids: [...new Set(directIds)], summary: defaultSummary });
  return entries;
}

export default function App() {
  useEffect(() => installGlobalErrorLogging(), []);
  const [notice, setNotice] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try { return localStorage.getItem("pilab-theme-v2") === "dark" ? "dark" : "light"; }
    catch { return "light"; }
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.matchMedia("(max-width: 860px)").matches);
  const [rightOpen, setRightOpen] = useState(() => !window.matchMedia("(max-width: 860px)").matches);
  const [compactTools, setCompactTools] = useState(() => {
    try { return localStorage.getItem("pilab-tools-compact-v1") !== "false"; } catch { return true; }
  });
  const [debugPanel, setDebugPanel] = useState<DebugPanel | null>(null);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [archiveableToolGroupCount, setArchiveableToolGroupCount] = useState(0);
  const [archiveToolRequest, setArchiveToolRequest] = useState(0);
  const [runErrors, setRunErrors] = useState<Record<string, string>>({});
  const [scrollRequest, setScrollRequest] = useState(0);
  const [streamViews, setStreamViews] = useState<Record<string, SessionStreamView>>({});
  const [activeRuns, setActiveRuns] = useState<Map<string, string>>(() => new Map());
  const [startingSessions, setStartingSessions] = useState<Set<string>>(() => new Set());
  const [runtimeCwd, setRuntimeCwd] = useState("");
  const [piConnection, setPiConnection] = useState<PiConnection | null>(null);
  const [piSessions, setPiSessions] = useState<PiLiveSession[]>([]);
  const [gptSessionSnapshot, setGptSessionSnapshot] = useState<{ cwd: string; sessions: GptSessionSummary[] }>({ cwd: "", sessions: [] });
  const [composerText, setComposerText] = useState("");
  const [workerWakeNotices, setWorkerWakeNotices] = useState<WorkerWakeNotice[]>([]);
  const workerSnapshotsRef = useRef(new Map<string, Map<string, GptSessionSummary>>());
  const [forkModalOpen, setForkModalOpen] = useState(false);
  const [forkNotice, setForkNotice] = useState<ForkNotice | null>(null);
  const forkSwitchSourceRef = useRef<string | null>(null);
  const [syncError, setSyncError] = useState("");
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [selectedRun, setSelectedRun] = useState<string>();
  const activeRunsRef = useRef(activeRuns);
  const startingSessionsRef = useRef(startingSessions);
  const runControlsRef = useRef(new Map<string, RunControl>());
  const completedRunIdsRef = useRef(new Set<string>());
  const busyForSessionRef = useRef<(sessionId: string) => boolean>(() => false);
  const piStreamOnline = useRef(false);

  const { workspace, setWorkspace, workspaceRef, ready, error: storageError, status: storageStatus } =
    useProjectWorkspace(loadLegacyWorkspace, () => newSession(runtimeCwd), setNotice);
  const session = workspace.sessions.find((item) => item.id === workspace.active) || workspace.sessions[0] || newSession(runtimeCwd);
  const currentApiKey = apiKeys[session.id] || "";
  const activeRun = session.runs.find((run) => run.id === selectedRun) || session.runs[0];
  const busy = activeRuns.has(session.id) || startingSessions.has(session.id) || runControlsRef.current.has(session.id);
  const streamView = streamViews[session.id] || emptyStreamView;
  const streamingId = streamView.streamingId;
  const streamingThinking = streamView.thinking;
  const toolActivity = streamView.toolActivity;
  activeRunsRef.current = activeRuns;
  startingSessionsRef.current = startingSessions;
  busyForSessionRef.current = (sessionId) => activeRunsRef.current.has(sessionId) || runControlsRef.current.has(sessionId) || startingSessionsRef.current.has(sessionId);
  const setActiveRunForSession = (sessionId: string, runId: string | undefined) => {
    const next = new Map(activeRunsRef.current);
    if (runId) next.set(sessionId, runId); else next.delete(sessionId);
    activeRunsRef.current = next; setActiveRuns(next);
  };
  const setSessionStarting = (sessionId: string, starting: boolean) => {
    const next = new Set(startingSessionsRef.current);
    if (starting) next.add(sessionId); else next.delete(sessionId);
    startingSessionsRef.current = next; setStartingSessions(next);
  };
  const updateStreamView = (sessionId: string, update: (current: SessionStreamView) => SessionStreamView) =>
    setStreamViews((current) => ({ ...current, [sessionId]: update(current[sessionId] || emptyStreamView) }));
  const setSessionRunError = (sessionId: string, message?: string) => setRunErrors((current) => {
    if (message) return { ...current, [sessionId]: message };
    const next = { ...current }; delete next[sessionId]; return next;
  });
  const enabledMessages = session.messages.filter((message) => message.enabled);
  const [metricsSnapshot, setMetricsSnapshot] = useState(() => ({ sessionId: session.id, messages: session.messages }));
  const metricMessages = metricsSnapshot.sessionId === session.id ? metricsSnapshot.messages : session.messages;
  const contextMetrics = useMemo(() => contextTokenMetrics(metricMessages), [metricMessages]);
  useEffect(() => {
    const timer = window.setTimeout(() => setMetricsSnapshot({ sessionId: session.id, messages: session.messages }), 250);
    return () => window.clearTimeout(timer);
  }, [session.id, session.messages]);
  const effectiveCwd = session.settings.workingDirectory.trim() || runtimeCwd;
  const reportArchiveableToolGroups = useCallback((count: number) => setArchiveableToolGroupCount(count), []);
  const reportGptSessions = useCallback((sessions: GptSessionSummary[]) => {
    setGptSessionSnapshot({ cwd: effectiveCwd, sessions });
    const cwdKey = normalizedWorkerCwd(effectiveCwd);
    const previous = workerSnapshotsRef.current.get(cwdKey);
    const nextById = new Map(sessions.map((worker) => [worker.id, worker]));
    workerSnapshotsRef.current.set(cwdKey, nextById);
    const workersByName = new Map(sessions.map((worker) => [worker.name, worker]));
    const pruneResolvedNotices = (notices: WorkerWakeNotice[]) => notices.flatMap((notice) => {
      if (normalizedWorkerCwd(notice.cwd) !== cwdKey) return [notice];
      const names = notice.names.filter((name) => {
        const worker = workersByName.get(name);
        return !worker || (worker.hasUnreadReply && !worker.hasActiveWaiter);
      });
      return names.length ? [{ ...notice, names }] : [];
    });
    setWorkerWakeNotices(pruneResolvedNotices);
    const completed = sessions.filter((worker) => {
      const old = previous?.get(worker.id);
      return worker.hasUnreadReply && !worker.hasActiveWaiter && (!old || !old.hasUnreadReply || !!old.hasActiveWaiter);
    });
    if (!completed.length) return;

    const ownerGroups = new Map<string, { sessionId: string; cwd: string; names: string[] }>();
    const currentWorkspace = workspaceRef.current;
    for (const worker of completed) {
      const signature = workerSignature(worker, effectiveCwd);
      for (const owner of currentWorkspace.sessions) {
        if (!sessionOwnsWorker(owner, worker.name, effectiveCwd, runtimeCwd) || owner.reviewedWorkerSignatures?.includes(signature)) continue;
        const key = `${owner.id}\\0${cwdKey}`;
        const group = ownerGroups.get(key) || { sessionId: owner.id, cwd: effectiveCwd, names: [] };
        if (!group.names.includes(worker.name)) group.names.push(worker.name);
        ownerGroups.set(key, group);
      }
    }
    if (!ownerGroups.size) return;

    setWorkerWakeNotices((current) => {
      const next = pruneResolvedNotices(current);
      for (const group of ownerGroups.values()) {
        const existingIndex = next.findIndex((notice) => notice.sessionId === group.sessionId && normalizedWorkerCwd(notice.cwd) === cwdKey);
        if (existingIndex < 0) next.push(group);
        else next[existingIndex] = { ...next[existingIndex], names: [...new Set([...next[existingIndex].names, ...group.names])] };
      }
      return next;
    });
  }, [effectiveCwd, runtimeCwd, workspaceRef]);
  const visibleGptSessions = gptSessionSnapshot.cwd === effectiveCwd ? gptSessionSnapshot.sessions : [];
  const activeWakeNotices = workerWakeNotices.filter((notice) => notice.sessionId === session.id);
  const workerWakeNotice = activeWakeNotices.length ? {
    names: [...new Set(activeWakeNotices.flatMap((notice) => notice.names))],
  } : null;
  const updateComposerText = (value: string) => setComposerText(value);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("pilab-theme-v2", theme); } catch { /* storage is optional */ }
  }, [theme]);
  useEffect(() => { try { localStorage.setItem("pilab-tools-compact-v1", String(compactTools)); } catch { /* storage is optional */ } }, [compactTools]);
  useEffect(() => { fetch("/api/health").then((response) => response.json()).then((data) => setRuntimeCwd(data.workingDirectory || "")).catch(() => {}); }, []);
  useEffect(() => {
    if (!ready || !runtimeCwd || session.settings.workingDirectory || session.messages.length !== 1 || session.messages[0]?.role !== "system" || session.title !== "新建对话") return;
    setWorkspace((current) => ({ ...current, sessions: current.sessions.map((item) => item.id === session.id ? { ...item, settings: { ...item.settings, workingDirectory: runtimeCwd } } : item) }));
  }, [ready, runtimeCwd, session.id]);
  useEffect(() => {
    if (notice) { const timer = setTimeout(() => setNotice(""), 5000); return () => clearTimeout(timer); }
  }, [notice]);
  useEffect(() => {
    const control = runControlsRef.current.get(session.id);
    if (control) {
      control.shouldSubscribe = true;
      control.resume?.();
      control.resume = undefined;
    }
    setSelectedRun(undefined);
    setDebugPanel(null);
    setDirectoryOpen(false);
    return () => {
      const previous = runControlsRef.current.get(session.id);
      if (!previous) return;
      previous.shouldSubscribe = false;
      previous.readerController?.abort();
    };
  }, [session.id]);
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const response = await fetch("/api/runs/active", { cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json() as { runs?: { sessionId?: unknown; runId?: unknown }[] };
        if (cancelled) return;
        const next = new Map<string, string>();
        for (const run of data.runs || [])
          if (typeof run.sessionId === "string" && typeof run.runId === "string" && !completedRunIdsRef.current.has(run.runId)) next.set(run.sessionId, run.runId);
        activeRunsRef.current = next;
        setActiveRuns(next);
      } catch { /* Keep the last known active-run snapshot until the service responds. */ }
      finally { polling = false; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [ready]);
  useEffect(() => {
    if (!ready || startingSessions.has(session.id) || runControlsRef.current.has(session.id)) return;
    const runId = activeRuns.get(session.id);
    if (runId) void run(undefined, session.id, runId);
  }, [activeRuns, ready, session.id, startingSessions]);
  useEffect(() => {
    if (!debugPanel) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setDebugPanel(null); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [debugPanel]);
  useEffect(() => {
    const compactQuery = window.matchMedia("(max-width: 860px)");
    let compact = compactQuery.matches;
    const onResize = () => {
      if (compactQuery.matches === compact) return;
      compact = compactQuery.matches;
      if (!compact) setSidebarCollapsed(false);
      setRightOpen(!compact);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => {
    if (!rightOpen || window.innerWidth > 860) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setRightOpen(false); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [rightOpen]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== "Enter" || busyForSessionRef.current(workspaceRef.current.active)) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      event.preventDefault();
      void run();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  const updateActive = useCallback((update: (current: Session) => Session) => {
    setWorkspace((current) => ({ ...current, sessions: current.sessions.map((item) => item.id === current.active ? update(item) : item) }));
  }, [setWorkspace]);
  const patchSession = (values: Partial<Session>) => updateActive((current) => ({
    ...current, ...values,
    ...(values.messages && current.piSync ? { piSync: { ...current.piSync, dirty: true } } : {}),
  }));
  const updateSetting = <K extends keyof Settings>(key: K, value: Settings[K]) => updateActive((current) => ({ ...current, settings: { ...current.settings, [key]: value } }));
  const currentRunLocksActiveSession = () => busyForSessionRef.current(workspaceRef.current.active);
  const updateMessage = (id: string, values: Partial<Message>) => {
    if (currentRunLocksActiveSession()) return;
    const active = workspaceRef.current.sessions.find((item) => item.id === workspaceRef.current.active);
    const target = active?.messages.find((message) => message.id === id);
    if (!active || !target) return;
    if (values.role !== undefined && values.role !== target.role &&
      (target.role === "tool" || !!target.toolCalls?.length || values.role === "tool")) {
      setNotice("不能直接更改工具调用或结果的角色，以免破坏工具配对。");
      return;
    }
    updateActive((current) => ({
      ...current,
      messages: patchMessageWithToolPairs(current.messages, id, values),
      ...(current.piSync ? { piSync: { ...current.piSync, dirty: true } } : {}),
    }));
  };
  const updateCall = (message: Message, index: number, values: Partial<ToolCall>) => {
    if (currentRunLocksActiveSession()) return;
    updateActive((current) => ({
      ...current,
      messages: patchToolCallWithResult(current.messages, message.id, index, { ...values, ...(values.id ? { thoughtSignature: undefined } : {}) }),
      ...(current.piSync ? { piSync: { ...current.piSync, dirty: true } } : {}),
    }));
  };
  const addMessage = (after?: number, role: Message["role"] = "user") => {
    if (currentRunLocksActiveSession()) return;
    const id = uid();
    updateActive((current) => {
      const messages = [...current.messages];
      messages.splice(after === undefined ? messages.length : Math.max(0, Math.min(after + 1, messages.length)), 0, { id, role, content: "", enabled: true });
      return { ...current, messages, ...(current.piSync ? { piSync: { ...current.piSync, dirty: true } } : {}) };
    });
    setScrollRequest((value) => value + 1);
  };
  const moveMessage = (index: number, delta: number) => {
    if (currentRunLocksActiveSession()) return;
    const move = (messages: Message[]) => {
      if (index + delta < 0 || index + delta >= messages.length) return messages;
      const next = [...messages];
      [next[index], next[index + delta]] = [next[index + delta], next[index]];
      return next;
    };
    const active = workspaceRef.current.sessions.find((item) => item.id === workspaceRef.current.active);
    if (!active) return;
    const issue = toolHistoryError(move(active.messages).filter((message) => message.enabled));
    if (issue) { setNotice(`无法移动这条消息：${issue}`); return; }
    updateActive((current) => {
      const messages = move(current.messages);
      return { ...current, messages, ...(current.piSync ? { piSync: { ...current.piSync, dirty: true } } : {}) };
    });
  };
  const deleteMessage = (id: string) => {
    if (currentRunLocksActiveSession()) return;
    const activeId = workspaceRef.current.active;
    const active = workspaceRef.current.sessions.find((item) => item.id === activeId);
    const target = active?.messages.find((message) => message.id === id);
    const dismissedNames = target ? workerNoticeNames(target.content) : [];
    const dismissedSignatures = active && dismissedNames.length ? visibleGptSessions
      .filter((worker) => dismissedNames.includes(worker.name) && sessionOwnsWorker(active, worker.name, effectiveCwd, runtimeCwd))
      .map((worker) => workerSignature(worker, effectiveCwd)) : [];
    if (dismissedNames.length) {
      setWorkerWakeNotices((current) => current.flatMap((notice) => {
        if (notice.sessionId !== activeId) return [notice];
        const names = notice.names.filter((name) => !dismissedNames.includes(name));
        return names.length ? [{ ...notice, names }] : [];
      }));
    }
    updateActive((current) => ({
      ...current,
      ...(dismissedSignatures.length ? { reviewedWorkerSignatures: [...new Set([...(current.reviewedWorkerSignatures || []), ...dismissedSignatures])].slice(-1_000) } : {}),
      messages: deleteMessageWithToolPairs(current.messages, id),
      ...(current.piSync ? { piSync: { ...current.piSync, dirty: true } } : {}),
    }));
  };
  const deleteToolCall = (assistantId: string, callId: string) => {
    if (currentRunLocksActiveSession()) return;
    updateActive((current) => ({
      ...current,
      messages: deleteToolCallWithResult(current.messages, assistantId, callId),
      ...(current.piSync ? { piSync: { ...current.piSync, dirty: true } } : {}),
    }));
  };
  const addManualToolResult = (assistantId: string, callId: string, content: string, isError: boolean): boolean => {
    if (currentRunLocksActiveSession()) return false;
    const active = workspaceRef.current.sessions.find((item) => item.id === workspaceRef.current.active);
    if (!active) return false;
    let messages: Message[];
    try { messages = createToolResult(active.messages, assistantId, callId, content, isError); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); return false; }
    const nextWorkspace = setWorkspace((current) => ({
      ...current,
      sessions: current.sessions.map((item) => item.id !== active.id ? item : {
        ...item, messages, ...(item.piSync ? { piSync: { ...item.piSync, dirty: true } } : {}),
      }),
    }));
    const updated = nextWorkspace.sessions.find((item) => item.id === active.id);
    if (!updated) return false;
    if (!toolHistoryError(updated.messages.filter((message) => message.enabled)))
      if (/工具调用|工具结果|Call ID/.test(runErrors[active.id] || "")) setSessionRunError(active.id);
    setScrollRequest((value) => value + 1);
    return true;
  };
  const createSession = (copy?: Session) => {
    const currentSession = workspaceRef.current.sessions.find((item) => item.id === workspaceRef.current.active) || session;
    const next: Session = copy
      ? { ...structuredClone(copy), id: uid(), title: copy.title, runs: [] }
      : newSession(currentSession.settings.workingDirectory.trim() || runtimeCwd);
    delete next.piSync;
    setWorkspace((current) => ({ ...current, sessions: [...current.sessions, next], rootSessionIds: [next.id, ...current.rootSessionIds], active: next.id, followPi: false }));
    setSelectedRun(undefined); setScrollRequest((value) => value + 1);
  };
  useEffect(() => {
    const createShortcut = (event: KeyboardEvent) => {
      if ((!event.metaKey && !event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "n") return;
      event.preventDefault();
      createSession();
    };
    window.addEventListener("keydown", createShortcut);
    return () => window.removeEventListener("keydown", createShortcut);
  }, [createSession]);
  const duplicateSession = (source: Session) => createSession({ ...source, title: `${source.title} · 副本` });
  const deleteSession = (id: string) => {
    if (busyForSessionRef.current(id)) return;
    const target = workspaceRef.current.sessions.find((item) => item.id === id);
    if (!target || !window.confirm(`删除「${target.title}」？此操作无法撤销。`)) return;
    setWorkspace((current) => {
      const sessions = current.sessions.filter((item) => item.id !== id);
      const folders = current.folders.map((folder) => ({ ...folder, sessionIds: folder.sessionIds.filter((sessionId) => sessionId !== id) }));
      let rootSessionIds = current.rootSessionIds.filter((sessionId) => sessionId !== id);
      if (!sessions.length) {
        const replacement = newSession(session.settings.workingDirectory.trim() || runtimeCwd);
        sessions.push(replacement);
        rootSessionIds = [replacement.id, ...rootSessionIds];
      }
      return { ...current, sessions, folders, rootSessionIds, active: current.active === id ? sessions[0].id : current.active, followPi: false,
        hiddenPiSessions: target.piSync ? [...new Set([...current.hiddenPiSessions, piSessionIdentity(target.piSync)])] : current.hiddenPiSessions };
    });
  };
  const branchAt = (message: Message, index: number) => {
    if (busyForSessionRef.current(workspaceRef.current.active)) return;
    const currentSession = workspaceRef.current.sessions.find((item) => item.id === workspaceRef.current.active);
    if (!currentSession) return;
    const end = completeToolBranchEnd(currentSession.messages, index);
    if (end === null) { setNotice("无法在未完成的工具调用处创建分支；请先补齐工具结果。"); return; }
    createSession({ ...currentSession, title: `${currentSession.title} · 分支`, messages: currentSession.messages.slice(0, end + 1) });
  };
  function createForkSession(title: string, memory: string, keepRecentTurns = 0, switchActive = true, sourceId?: string, allowWhileRunning = false, forkId?: string, forkMessages?: Message[]) {
    const sourceSessionId = sourceId || workspaceRef.current.active;
    if (busyForSessionRef.current(sourceSessionId) && !allowWhileRunning) return undefined;
    const source = workspaceRef.current.sessions.find((item) => item.id === sourceSessionId);
    if (!source || !memory.trim()) return undefined;
    const id = forkId || uid();
    const existing = workspaceRef.current.sessions.find((item) => item.id === id);
    if (existing) return id;
    const { piSync: _piSync, ...copy } = source;
    const next: Session = {
      ...structuredClone(copy), id, title: title.trim().slice(0, 200) || `${source.title} · 提纯分身`,
      messages: forkMessages || buildForkMessages({ messages: source.messages, distilledMemory: memory, keepRecentTurns, id: uid }),
      runs: [], parentSessionId: source.id, parentSessionTitle: source.title, forkSummary: memory.trim().slice(0, 20_000),
    };
    setWorkspace((current) => ({ ...current, sessions: [...current.sessions, next], rootSessionIds: [next.id, ...current.rootSessionIds], ...(switchActive ? { active: next.id, followPi: false } : {}) }));
    const key = apiKeys[source.id] || source.settings.apiKey || "";
    if (key) setApiKeys((current) => ({ ...current, [next.id]: key }));
    setForkNotice({ sourceId: source.id, forkId: next.id, title: next.title });
    setForkModalOpen(false);
    if (switchActive) { setSelectedRun(undefined); setScrollRequest((value) => value + 1); }
    setNotice(switchActive ? `已创建提纯分身「${next.title}」并切换过去。` : `已生成提纯分身「${next.title}」，原会话保持不变。`);
    return next.id;
  }
  const selectSession = (id: string) => {
    setWorkspace((current) => ({ ...current, active: id, followPi: false }));
  };
  const renameSession = (id: string, title: string) => setWorkspace((current) => ({ ...current, sessions: current.sessions.map((item) => item.id === id ? { ...item, title } : item) }));
  const createFolder = (name = "新建文件夹") => setWorkspace((current) => ({
    ...current, folders: [...current.folders, { id: uid(), name: name.trim().slice(0, 120) || "新建文件夹", collapsed: false, sessionIds: [] }],
  }));
  const renameFolder = (id: string, name: string) => setWorkspace((current) => ({
    ...current, folders: current.folders.map((folder) => folder.id === id ? { ...folder, name: name.trim().slice(0, 120) } : folder),
  }));
  const toggleFolder = (id: string) => setWorkspace((current) => ({
    ...current, folders: current.folders.map((folder) => folder.id === id ? { ...folder, collapsed: !folder.collapsed } : folder),
  }));
  const deleteFolder = (id: string) => setWorkspace((current) => {
    const folder = current.folders.find((item) => item.id === id);
    if (!folder) return current;
    const alreadyRoot = new Set(current.rootSessionIds);
    return {
      ...current, folders: current.folders.filter((item) => item.id !== id),
      rootSessionIds: [...current.rootSessionIds, ...folder.sessionIds.filter((sessionId) => !alreadyRoot.has(sessionId))],
    };
  });
  const moveSession = (sessionId: string, targetFolderId: string | null, targetId?: string, position: "before" | "after" | "end" = "end") => setWorkspace((current) => {
    if (!current.sessions.some((item) => item.id === sessionId) || targetId === sessionId) return current;
    const folders = current.folders.map((folder) => ({ ...folder, sessionIds: folder.sessionIds.filter((id) => id !== sessionId) }));
    const rootSessionIds = current.rootSessionIds.filter((id) => id !== sessionId);
    const folder = targetFolderId ? folders.find((item) => item.id === targetFolderId) : undefined;
    const destination = folder ? folder.sessionIds : rootSessionIds;
    let index = targetId ? destination.indexOf(targetId) : -1;
    if (index < 0) index = destination.length;
    else if (position === "after") index += 1;
    destination.splice(index, 0, sessionId);
    return { ...current, folders, rootSessionIds };
  });

  async function refreshPiStatus() {
    try { const response = await fetch("/api/pi-status", { cache: "no-store" }); if (!response.ok) throw new Error("Pi 状态请求失败"); setPiConnection(await response.json() as PiConnection); }
    catch { setNotice("暂时无法读取 Pi 登录状态。"); }
  }
  useEffect(() => { if (ready) void refreshPiStatus(); }, [ready]);
  function receivePiSession(source: PiLiveDetail, activate = false, discard = false) {
    setWorkspace((current) => {
      if (current.hiddenPiSessions.includes(source.sessionId)) return current;
      const local = current.sessions.find((item) => item.piSync && piSessionIdentity(item.piSync) === source.sessionId);
      const accepted = !!(local?.piSync?.pending && source.ack?.id === local.piSync.pending && source.ack.status === "applied");
      const rejected = !!(local?.piSync?.pending && source.ack?.id === local.piSync.pending && source.ack.status === "rejected");
      let next = local;
      if (!local) {
        const fresh = newSession(source.cwd);
        const effort = reasoningEfforts.includes(source.thinking as ReasoningEffort) ? source.thinking as ReasoningEffort : "medium";
        next = { ...fresh, title: source.name, messages: source.messages, settings: { ...fresh.settings,
          protocol: source.model ? "pi-subscription" : defaults.protocol,
          model: source.model ? source.model.provider === "openai-codex" ? source.model.id : `${source.model.provider}/${source.model.id}` : fresh.settings.model,
          workingDirectory: source.cwd, reasoningEffort: effort, reasoning: effort !== "off" },
          piSync: { id: source.id, sessionId: source.sessionId, revision: source.revision, dirty: false } };
      } else if (discard || accepted || (!local.piSync?.dirty && !local.piSync?.pending)) {
        if (source.revision !== local.piSync?.revision || local.piSync.id !== source.id || discard || accepted)
          next = { ...local, messages: source.messages, piSync: { id: source.id, sessionId: source.sessionId, revision: source.revision, dirty: false } };
      } else if (rejected) {
        next = { ...local, piSync: { ...local.piSync!, pending: undefined } };
      }
      if (!next) return current;
      const sessions = local ? current.sessions.map((item) => item.id === local.id ? next! : item) : [...current.sessions, next];
      return { ...current, sessions, ...(!local ? { rootSessionIds: [next.id, ...current.rootSessionIds] } : {}), active: activate ? next.id : current.active };
    });
  }
  async function readPiSession(id: string, activate = false, discard = false) {
    const response = await fetch(`/api/pi-sync/${encodeURIComponent(id)}`, { cache: "no-store" });
    const source = await response.json() as PiLiveDetail & { error?: string };
    if (!response.ok) throw new Error(source.error || "读取 Pi 会话失败");
    receivePiSession(source, activate, discard); return source;
  }
  async function selectPiSession(id: string) {
    setWorkspace((current) => ({ ...current, followPi: false }));
    const identity = piSessions.find((item) => item.id === id)?.sessionId;
    const existing = workspace.sessions.find((item) => item.piSync && piSessionIdentity(item.piSync) === identity);
    if (existing) setWorkspace((current) => ({ ...current, active: existing.id }));
    try { await readPiSession(id, !existing); setSyncError(""); }
    catch (error) { setSyncError((error as Error).message); }
  }
  async function applyToPi() {
    if (!session.piSync || busy || session.piSync.pending) return;
    try {
      const response = await fetch(`/api/pi-sync/${encodeURIComponent(session.piSync.id)}/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: session.piSync.revision, messages: session.messages }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "同步失败");
      setWorkspace((current) => ({ ...current, sessions: current.sessions.map((item) => item.id === session.id && item.piSync ? { ...item, piSync: { ...item.piSync, pending: data.id } } : item) }));
      setNotice("修改已提交，等待 Pi 确认。");
    } catch (error) { setNotice((error as Error).message); }
  }
  async function cancelPiApply() {
    if (!session.piSync?.pending) return;
    try {
      const response = await fetch(`/api/pi-sync/${encodeURIComponent(session.piSync.id)}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ commandId: session.piSync.pending }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "解除等待失败");
      setWorkspace((current) => ({ ...current, sessions: current.sessions.map((item) => item.id === session.id && item.piSync ? { ...item, piSync: { ...item.piSync, pending: undefined } } : item) }));
    } catch (error) { setNotice((error as Error).message); }
  }
  useEffect(() => {
    if (!ready) return;
    let cancelled = false; let running = false;
    const poll = async () => {
      if (running) return; running = true;
      try {
        const response = await fetch("/api/pi-sync", { cache: "no-store" }); const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Pi 同步服务不可用");
        if (cancelled) return;
        const sessions = data.sessions as PiLiveSession[]; setPiSessions(sessions); setSyncError("");
        const current = workspaceRef.current.sessions.find((item) => item.id === workspaceRef.current.active);
        const latest = sessions.filter((item) => !workspaceRef.current.hiddenPiSessions.includes(item.sessionId)).sort((a, b) => b.activityAt - a.activityAt)[0];
        const target = workspaceRef.current.followPi && !busy && !current?.piSync?.dirty && !current?.piSync?.pending ? latest?.id || current?.piSync?.id : current?.piSync?.id;
        if (target && (target !== current?.piSync?.id || !piStreamOnline.current)) await readPiSession(target, !!(workspaceRef.current.followPi && latest?.id === target && !busy));
      } catch (error) { if (!cancelled) setSyncError((error as Error).message); }
      finally { running = false; }
    };
    void poll(); const timer = setInterval(() => void poll(), 1800);
    return () => { cancelled = true; clearInterval(timer); };
  }, [ready, busy, workspace.followPi]);
  useEffect(() => {
    const id = session.piSync?.id;
    if (!ready || !id) return;
    let cancelled = false;
    const events = new EventSource(`/api/pi-sync/${encodeURIComponent(id)}/events`);
    events.addEventListener("snapshot", (event) => { if (cancelled) return; try { const source = JSON.parse((event as MessageEvent).data) as PiLiveDetail; if (source.id === id) { piStreamOnline.current = true; receivePiSession(source); } } catch { piStreamOnline.current = false; } });
    events.addEventListener("sync_error", () => { piStreamOnline.current = false; }); events.onerror = () => { piStreamOnline.current = false; };
    return () => { cancelled = true; piStreamOnline.current = false; events.close(); };
  }, [session.piSync?.id, ready]);

  function exportSession() {
    const { apiKey: _secret, ...settings } = session.settings;
    const blob = new Blob([pretty({ version: 1, title: session.title, settings, messages: session.messages,
      ...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
      ...(session.parentSessionTitle ? { parentSessionTitle: session.parentSessionTitle } : {}),
      ...(session.forkSummary ? { forkSummary: session.forkSummary } : {}) })], { type: "application/json" });
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `${session.title || "pi-lab"}.json`; link.click(); URL.revokeObjectURL(link.href);
    setNotice("已导出会话 JSON（不含 API Key）。");
  }
  async function importSession(file?: File) {
    if (!file) return;
    try {
      if (file.size > 5_000_000) throw new Error("JSON 文件不能超过 5 MB");
      const parsed = fileSchema.parse(JSON.parse(await file.text()));
      const imported: Session = { id: uid(), title: parsed.title, settings: { ...parsed.settings, apiKey: "" }, messages: parsed.messages.map((message) => ({ ...message, id: uid() })), runs: [],
        ...(parsed.parentSessionId ? { parentSessionId: parsed.parentSessionId } : {}),
        ...(parsed.parentSessionTitle ? { parentSessionTitle: parsed.parentSessionTitle } : {}),
        ...(parsed.forkSummary ? { forkSummary: parsed.forkSummary } : {}) };
      createSession(imported); setNotice("会话已导入。");
    } catch (error) { setNotice(`导入失败：${error instanceof Error ? error.message : "JSON 格式无效"}`); }
  }
  async function copyText(value: string) { try { await navigator.clipboard.writeText(value); setNotice("已复制到剪贴板。"); } catch { setNotice("无法访问剪贴板。"); } }

  async function run(messagesToRun?: Message[], targetSessionId?: string, resumeRunId?: string) {
    if (!ready) return;
    const currentWorkspace = workspaceRef.current;
    const sessionId = targetSessionId || currentWorkspace.active;
    if (!resumeRunId && busyForSessionRef.current(sessionId)) return;
    const activeSession = currentWorkspace.sessions.find((item) => item.id === sessionId);
    if (!activeSession) return;
    if (activeSession.piSync) { setNotice("请先在 Pi CLI 同步菜单中应用或放弃本地修改。"); return; }
    const runMessages = messagesToRun || activeSession.messages;
    const activeMessages = runMessages.filter((message) => message.enabled);
    if (!resumeRunId && (!activeMessages.length || !activeMessages.some((message) => message.content.trim() || message.toolCalls?.length || message.role === "tool"))) {
      const message = "请先添加至少一条有内容且已启用的消息。";
      setSessionRunError(activeSession.id, message); return;
    }
    const historyIssue = resumeRunId ? undefined : toolHistoryError(activeMessages);
    if (historyIssue) { setSessionRunError(activeSession.id, historyIssue); return; }
    const runId = uid(); const started = Date.now();
    const settings = { ...activeSession.settings, apiKey: apiKeys[sessionId] || "" };
    const record: Run = { id: runId, at: started, status: "running", output: "", thinking: "", elapsed: 0, snapshot: { settings: { ...settings, apiKey: "" }, messages: structuredClone(runMessages) } };
    setSessionStarting(sessionId, true);
    setSessionRunError(sessionId);
    setWorkspace((current) => ({ ...current, sessions: current.sessions.map((item) => item.id === sessionId ? { ...item, runs: [record, ...item.runs].slice(0, 30) } : item) }));
    if (currentWorkspace.active === sessionId) { setSelectedRun(runId); setDebugPanel(null); setScrollRequest((value) => value + 1); }
    updateStreamView(sessionId, () => emptyStreamView);
    let remoteRunId = "";
    let runControl: RunControl | null = null;
    let text = ""; let thought = ""; let currentMessageId = uid(); let terminalReceived = false; let errorEventReceived = false;
    let finalGenerationStatus = "done";
    const textById = new Map<string, string>(); const trace: Message[] = []; const requests: unknown[] = [];
    const updateRun = (values: Partial<Run>) => setWorkspace((current) => ({ ...current, sessions: current.sessions.map((item) => item.id === sessionId ? { ...item, runs: item.runs.map((run) => run.id === runId ? { ...run, ...values, elapsed: Date.now() - started } : run) } : item) }));
    const applyContextCompacted = (event: Record<string, unknown>) => {
      const entries = compactionEntries(event);
      const targets = new Map<string, string | undefined>();
      const availableMessages = [...activeSession.messages, ...trace];
      for (const entry of entries) for (const id of entry.ids) {
        let matchedMessage = false;
        for (const message of availableMessages) {
          const compacted = message as CompactedMessage;
          const direct = message.id === id;
          const wireId = id.includes("|") ? id.split("|")[0] : id;
          const call = message.toolCalls?.some((item) => item.id.split("|")[0] === wireId) || (message.role === "tool" && message.toolCallId?.split("|")[0] === wireId);
          if (!direct && !call) continue;
          matchedMessage = true;
          targets.set(message.id, targets.get(message.id) || entry.summary || compacted.modelSummary);
          if (call) {
            const callIds = message.role === "tool" ? [message.toolCallId] : message.toolCalls?.filter((item) => item.id.split("|")[0] === wireId).map((item) => item.id) || [];
            for (const callId of callIds) for (const paired of availableMessages) {
              if (paired.id === message.id || (paired.role === "tool" && paired.toolCallId?.split("|")[0] === callId?.split("|")[0]) || paired.toolCalls?.some((item) => item.id.split("|")[0] === callId?.split("|")[0]))
                targets.set(paired.id, targets.get(paired.id) || entry.summary || (paired as CompactedMessage).modelSummary);
            }
          }
        }
        if (!matchedMessage) continue;
      }
      if (!targets.size) return;
      const annotate = (messages: Message[]) => messages.map((message) => {
        if (!targets.has(message.id)) return message;
        const summary = targets.get(message.id);
        return { ...message, compactedByModel: true, ...(summary ? { modelSummary: summary } : {}) } as Message;
      });
      const nextTrace = annotate(trace);
      trace.splice(0, trace.length, ...nextTrace);
      setWorkspace((current) => ({ ...current, sessions: current.sessions.map((item) => item.id !== sessionId ? item : {
        ...item,
        messages: annotate(item.messages),
        runs: item.runs.map((run) => run.id !== runId ? run : { ...run, snapshot: { ...run.snapshot, messages: annotate(run.snapshot.messages) }, trace: run.trace ? annotate(run.trace) : run.trace }),
      }) }));
      if (workspaceRef.current.active === sessionId) setNotice(`上下文已压缩：${targets.size} 条历史消息已标记为摘要记录。`);
    };
    const upsert = (message: Message) => {
      const index = trace.findIndex((item) => item.id === message.id); if (index < 0) trace.push(message); else trace[index] = { ...trace[index], ...message };
      setWorkspace((current) => ({ ...current, sessions: current.sessions.map((item) => item.id !== sessionId ? item : { ...item, messages: item.messages.some((entry) => entry.id === message.id) ? item.messages.map((entry) => entry.id === message.id ? { ...entry, ...message } : entry) : [...item.messages, message] }) }));
      updateRun({ trace: [...trace] });
    };
    const removeEmpty = (id: string) => {
      const empty = (message: Message) => message.id === id && message.role === "assistant" && !message.content.trim() && !message.toolCalls?.length && !message.images?.length && !message.providerState?.thinking.some((item) => item.thinking);
      const existing = trace.find((message) => message.id === id); if (existing && !empty(existing)) return;
      const index = trace.findIndex(empty); if (index >= 0) trace.splice(index, 1); textById.delete(id); text = [...textById.values()].filter(Boolean).join("\n\n");
      setWorkspace((current) => ({ ...current, sessions: current.sessions.map((item) => item.id === sessionId ? { ...item, messages: item.messages.filter((message) => !empty(message)) } : item) })); updateRun({ trace: [...trace], output: text });
    };
    const settlePendingToolCalls = (content: string) => {
      const resolved = new Set(trace
        .filter((message) => message.role === "tool")
        .map((message) => message.toolCallId?.split("|")[0])
        .filter((id): id is string => !!id));
      for (const message of [...trace]) for (const call of message.toolCalls || []) {
        const id = call.id.split("|")[0];
        if (!id || resolved.has(id)) continue;
        resolved.add(id);
        upsert({ id: uid(), role: "tool", enabled: true, content, toolCallId: call.id, toolName: call.name, isError: true });
      }
    };
    try {
      if (resumeRunId) remoteRunId = resumeRunId;
      else {
        const response = await fetch("/api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: pretty({ sessionId, settings, messages: runMessages }) });
        if (!response.ok) { const data = await response.json(); throw new Error(data.error || `HTTP ${response.status}`); }
        const submitted = await response.json() as { runId?: unknown; sessionId?: unknown };
        if (typeof submitted.runId !== "string" || submitted.sessionId !== sessionId) throw new Error("服务未返回有效的后台运行 ID。");
        remoteRunId = submitted.runId;
      }
      runControl = { sessionId, runId: remoteRunId, lastSeq: 0, shouldSubscribe: workspaceRef.current.active === sessionId };
      runControlsRef.current.set(sessionId, runControl);
      setActiveRunForSession(sessionId, remoteRunId);
      setSessionStarting(sessionId, false);
      const consumeEvent = (event: any) => {
        if (event.type === "heartbeat") return;
        if (event.type === "context_compacted") applyContextCompacted(event as Record<string, unknown>);
        if (event.type === "session_forked") {
          const fork = (event as { fork?: { id?: unknown; title?: unknown; forkSummary?: unknown; keepRecentTurns?: unknown; messages?: unknown } }).fork;
          const parsedMessages = messageSchema.array().max(500).safeParse(fork?.messages);
          if (fork && typeof fork.id === "string" && typeof fork.title === "string" && typeof fork.forkSummary === "string" && parsedMessages.success) {
            const requestedSwitch = forkSwitchSourceRef.current === sessionId;
            const switchAfterCreate = requestedSwitch && workspaceRef.current.active === sessionId;
            if (requestedSwitch) forkSwitchSourceRef.current = null;
            createForkSession(fork.title, fork.forkSummary,
              typeof fork.keepRecentTurns === "number" ? fork.keepRecentTurns : 0,
              switchAfterCreate, sessionId, true, fork.id, parsedMessages.data);
          }
        }
        if (event.type === "runtime") updateRun({ cwd: event.cwd as string | undefined });
        if (event.type === "request") { requests.push(event.payload); updateRun({ request: event.payload, requests: [...requests], turns: event.turn }); }
        if (event.type === "assistant_start") {
          currentMessageId = event.id; updateStreamView(sessionId, (current) => ({ ...current, streamingId: event.id, thinking: "" })); textById.set(event.id, "");
          upsert({ id: event.id, role: "assistant", content: "", enabled: true });
        }
        if (event.type === "text") { const id = event.id || currentMessageId; const next = (textById.get(id) || "") + event.delta; textById.set(id, next); upsert({ id, role: "assistant", content: next, enabled: true }); text = [...textById.values()].filter(Boolean).join("\n\n"); updateRun({ output: text }); }
        if (event.type === "thinking") { thought += event.delta; updateStreamView(sessionId, (current) => ({ ...current, thinking: current.thinking + event.delta })); updateRun({ thinking: thought }); }
        if (event.type === "assistant" || event.type === "message") {
          const message = event.message as Message;
          const failedEmpty = message.role === "assistant" && ["error", "aborted"].includes(message.providerState?.stopReason || "") && !message.content.trim() && !message.toolCalls?.length && !message.images?.length && !message.providerState?.thinking.some((item) => item.thinking);
          if (failedEmpty) removeEmpty(message.id); else upsert(message);
          if (message.role === "assistant") { textById.set(message.id, message.content); text = [...textById.values()].filter(Boolean).join("\n\n"); updateRun({ output: text }); }
        }
        if (event.type === "tool_activity") updateStreamView(sessionId, (current) => ({ ...current, toolActivity: event as ToolActivity }));
        if (event.type === "tool_activity_end") updateStreamView(sessionId, (current) => ({ ...current, toolActivity: null }));
        if (event.type === "done") { finalGenerationStatus = event.reason === "length" ? "length" : event.reason === "turn_limit" ? "turn_limit" : "done"; updateRun({ status: finalGenerationStatus, usage: event.usage, turns: event.turns, output: text }); if (workspaceRef.current.active === sessionId && event.reason === "turn_limit") setNotice("已达到 Agent 最大轮数；可检查轨迹后继续。"); if (workspaceRef.current.active === sessionId && event.reason === "length") setNotice("已达到输出上限，回复未完成。"); }
        if (event.type === "error") { errorEventReceived = true; const message = typeof event.message === "string" ? event.message : "模型运行发生错误。"; updateRun({ status: "error", error: message, output: text }); setSessionRunError(sessionId, message); }
        if (event.type === "run_status") {
          terminalReceived = true;
          completedRunIdsRef.current.add(remoteRunId);
          if (completedRunIdsRef.current.size > 100)
            completedRunIdsRef.current.delete(completedRunIdsRef.current.values().next().value!);
          if (event.status === "completed") updateRun({ status: finalGenerationStatus, output: text });
          else if (event.status === "aborted") { settlePendingToolCalls("执行已停止，未收到该工具的完整结果。操作可能已经部分完成，请检查实际文件状态后再继续。"); updateRun({ status: "stopped", error: undefined, output: text }); setSessionRunError(sessionId); }
          else if (event.status === "failed") { const message = typeof event.message === "string" ? event.message : "模型运行失败。"; updateRun({ status: "error", ...(errorEventReceived ? {} : { error: message }), output: text }); if (!errorEventReceived) setSessionRunError(sessionId, message); }
          if (runControl) { runControlsRef.current.delete(sessionId); setActiveRunForSession(sessionId, undefined); }
          updateStreamView(sessionId, () => emptyStreamView);
          if (forkSwitchSourceRef.current === sessionId) forkSwitchSourceRef.current = null;
        }
      };
      const control = runControl;
      if (!control) throw new Error("后台运行订阅未初始化。");
      const waitUntilAttached = () => new Promise<void>((resolve) => {
        if (control.shouldSubscribe) resolve(); else control.resume = resolve;
      });
      while (!terminalReceived) {
        if (!control.shouldSubscribe) await waitUntilAttached();
        if (terminalReceived) break;
        const streamAbort = new AbortController();
        control.readerController = streamAbort;
        try {
          const response = await fetch(`/api/runs/${encodeURIComponent(remoteRunId)}/stream?afterSeq=${control.lastSeq}`, { cache: "no-store", signal: streamAbort.signal });
          if (!response.ok) {
            const data = await response.json().catch(() => null) as { error?: string } | null;
            const error = new Error(data?.error || `HTTP ${response.status}`) as Error & { status?: number };
            error.status = response.status;
            throw error;
          }
          if (!response.body) throw new Error("浏览器不支持流式响应");
          const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
          const consumeLine = (line: string) => {
            if (!line.trim()) return;
            const envelope = JSON.parse(line) as { seq?: unknown; event?: unknown };
            if (!Number.isSafeInteger(envelope.seq) || (envelope.seq as number) <= control.lastSeq || !envelope.event || typeof envelope.event !== "object") return;
            control.lastSeq = envelope.seq as number;
            consumeEvent(envelope.event);
          };
          while (true) {
            const chunk = await reader.read(); buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
            const lines = buffer.split("\n"); buffer = lines.pop() || "";
            for (const line of lines) consumeLine(line);
            if (chunk.done) break;
          }
          if (buffer.trim()) consumeLine(buffer);
          if (!terminalReceived && !streamAbort.signal.aborted) {
            const message = "⚠️ 回复流意外中断，正在尝试重新连接并追帧。";
            reportClientDiagnostic("stream_unexpected_eof", undefined, { runId, sessionId, inputMessageCount: activeMessages.length, receivedChars: text.length, startedAt: new Date(started).toISOString() });
            updateRun({ status: "error", error: message, output: text });
            setSessionRunError(sessionId, message);
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
        } catch (error) {
          if (streamAbort.signal.aborted) continue;
          const status = (error as Error & { status?: number }).status;
          const detail = error instanceof Error ? error.message : String(error);
          if (status === 404) {
            const message = `后台运行已不可用：${detail}`;
            updateRun({ status: "error", error: message, output: text });
            setSessionRunError(sessionId, message);
            terminalReceived = true;
          } else {
            const message = `⚠️ 回复流连接失败，正在重试：${detail}`;
            reportClientDiagnostic("run_stream_read_error", error, { runId, sessionId, receivedChars: text.length, startedAt: new Date(started).toISOString() });
            updateRun({ status: "error", error: message, output: text });
            setSessionRunError(sessionId, message);
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
        } finally {
          if (control.readerController === streamAbort) control.readerController = undefined;
        }
      }
    } catch (error) {
      removeEmpty(currentMessageId);
      const detail = error instanceof Error ? error.message : String(error);
      const message = error instanceof TypeError ? "网页连接本地服务失败。" : detail;
      reportClientDiagnostic("run_request_error", error, { runId, sessionId, inputMessageCount: activeMessages.length, receivedChars: text.length, startedAt: new Date(started).toISOString() });
      updateRun({ status: "error", error: message, output: text });
      setSessionRunError(sessionId, message);
    } finally {
      setSessionStarting(sessionId, false);
      if (runControl && runControlsRef.current.get(sessionId) === runControl) {
        runControl.readerController?.abort();
        runControlsRef.current.delete(sessionId);
        setActiveRunForSession(sessionId, undefined);
      }
      updateStreamView(sessionId, () => emptyStreamView);
      if (forkSwitchSourceRef.current === sessionId) forkSwitchSourceRef.current = null;
    }
  }
  async function abortRun() {
    const sessionId = workspaceRef.current.active;
    const runId = activeRunsRef.current.get(sessionId) || runControlsRef.current.get(sessionId)?.runId;
    if (!runId) return;
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/abort`, { method: "POST" });
      if (!response.ok) {
        const data = await response.json().catch(() => null) as { error?: string } | null;
        setNotice(data?.error || "无法停止该后台运行。");
      }
    } catch (error) { setNotice(`停止运行失败：${error instanceof Error ? error.message : String(error)}`); }
  }
  const sendMessage = (content: string, role: Message["role"], shouldRun: boolean, targetSessionId?: string): boolean => {
    if (busyForSessionRef.current(targetSessionId || workspaceRef.current.active) || !ready) return false;
    const activeId = targetSessionId || workspaceRef.current.active;
    const activeSession = workspaceRef.current.sessions.find((item) => item.id === activeId);
    if (!activeSession || activeSession.piSync) return false;
    const message: Message = { id: uid(), role, content, enabled: true };
    const nextWorkspace = setWorkspace((current) => {
      const target = current.sessions.find((item) => item.id === activeId);
      if (!target || target.piSync) return current;
      return {
        ...current,
        sessions: current.sessions.map((item) => item.id !== activeId ? item : {
          ...item, messages: [...item.messages, message], ...(item.piSync ? { piSync: { ...item.piSync, dirty: true } } : {}),
        }),
      };
    });
    const nextSession = nextWorkspace.sessions.find((item) => item.id === activeId);
    if (!nextSession?.messages.some((item) => item.id === message.id)) return false;
    if (workspaceRef.current.active === activeId) setScrollRequest((value) => value + 1);
    if (shouldRun) void run(nextSession.messages, activeId);
    return true;
  };
  function requestSmartFork(title: string, keepRecentTurns: number, switchAfterCreate = false) {
    const prompt = `请从当前完整会话中提炼「记忆结晶」，必须包含：目前已搞懂的核心原理/结论、用户的关键偏好与硬约束、已经试过并证明走不通的死胡同及原因、接下来的明确目标。去掉机械操作流水账和已解决的冗余过程，不要编造。然后必须调用 session_fork 创建新分身，title=${JSON.stringify(title)}，keepRecentTurns=${keepRecentTurns}，distilledMemory 填写提炼结果。原会话绝不修改；不要调用其他工具或派发工兵。`;
    if (switchAfterCreate) forkSwitchSourceRef.current = session.id;
    if (!sendMessage(prompt, "user", true)) {
      if (forkSwitchSourceRef.current === session.id) forkSwitchSourceRef.current = null;
      setNotice("当前会话无法启动提纯；请先退出 Pi 同步只读状态或等待当前运行结束。"); return;
    }
    setForkModalOpen(false);
    setNotice(switchAfterCreate ? "Gemini 正在提纯；完成后将切换到新分身。" : "Gemini 正在提纯记忆结晶，完成后会在原会话中提供切换卡片。");
  }
  function rememberReviewedWorkers(sessionId: string, cwd: string, names: string[]) {
    const owner = workspaceRef.current.sessions.find((item) => item.id === sessionId);
    if (!owner) return;
    const signatures = visibleGptSessions
      .filter((worker) => names.includes(worker.name) && sessionOwnsWorker(owner, worker.name, cwd, runtimeCwd))
      .map((worker) => workerSignature(worker, cwd));
    if (!signatures.length) return;
    setWorkspace((current) => ({
      ...current,
      sessions: current.sessions.map((item) => item.id === sessionId
        ? { ...item, reviewedWorkerSignatures: [...new Set([...(item.reviewedWorkerSignatures || []), ...signatures])].slice(-1_000) }
        : item),
    }));
  }
  function reviewWorkers(review: WorkerReview) {
    const target = workspaceRef.current.sessions.find((item) => item.id === review.sessionId);
    const unique = target ? [...new Set(review.names.filter((name) => sessionOwnsWorker(target, name, review.cwd, runtimeCwd)))] : [];
    const matchesNotice = (notice: WorkerWakeNotice | WorkerReview) => notice.sessionId === review.sessionId && normalizedWorkerCwd(notice.cwd) === normalizedWorkerCwd(review.cwd);
    if (!target || !unique.length) {
      setWorkerWakeNotices((current) => current.filter((notice) => !matchesNotice(notice)));
      return;
    }
    if (target.piSync) {
      setNotice("该工兵属于 Pi 同步只读会话；请先应用或放弃同步修改，再审阅交卷。");
      return;
    }
    if (busyForSessionRef.current(target.id)) {
      setNotice("所属会话正在运行；工兵交卷提醒已保留，运行结束后请再次点击审阅。");
      return;
    }
    const prompt = `后台 GPT 工兵已交卷：${unique.map((name) => `「${name}」`).join("、")}。请使用 gpt_session_read 读取这些工兵的新回复，核对完成情况，给用户一份简洁、准确的中文汇报；如有失败、问题或待决策事项，请明确指出。不要重启或打断仍在运行的工兵。`;
    if (!sendMessage(prompt, "user", true, target.id)) {
      setNotice("已保留工兵交卷提醒，但所属会话暂时不能运行；可稍后再次点击审阅。");
      return;
    }
    rememberReviewedWorkers(target.id, review.cwd, unique);
    setWorkerWakeNotices((current) => current.filter((notice) => !matchesNotice(notice)));
  }
  function reviewCurrentSessionWorkers(sessionId: string) {
    for (const notice of workerWakeNotices.filter((item) => item.sessionId === sessionId))
      reviewWorkers({ sessionId: notice.sessionId, cwd: notice.cwd, names: notice.names });
  }
  function dismissSessionWorkerWake(sessionId: string) {
    for (const item of workerWakeNotices.filter((notice) => notice.sessionId === sessionId))
      rememberReviewedWorkers(item.sessionId, item.cwd, item.names);
    setWorkerWakeNotices((current) => current.filter((notice) => notice.sessionId !== sessionId));
  }
  const inspectorDraft = {
    protocol: session.settings.protocol, model: session.settings.model, reasoningEffort: getReasoningEffort(session.settings),
    toolMode: session.settings.toolMode, workingDirectory: effectiveCwd, maxTurns: session.settings.maxTurns,
    temperature: session.settings.temperature, maxTokens: session.settings.maxTokens,
    messages: enabledMessages.map(({ id: _id, enabled: _enabled, ...message }) => message),
  };
  const setFollowPi = (value: boolean) => setWorkspace((current) => ({ ...current, followPi: value }));

  if (!ready) return <div className="app-loading" role="status">{storageError || "正在打开本地工作区…"}{storageError && <button onClick={() => location.reload()}>重试</button>}</div>;
  return <div className={`app-shell ${sidebarCollapsed ? "sidebar-compact" : ""} ${rightOpen ? "right-visible" : ""}`}>
    <Sidebar sessions={workspace.sessions} folders={workspace.folders} rootSessionIds={workspace.rootSessionIds} active={session.id} collapsed={sidebarCollapsed} activeRuns={activeRuns} onToggle={() => setSidebarCollapsed((value) => !value)} onCreate={() => createSession()} onCreateFolder={createFolder} onSelect={selectSession} onRename={renameSession} onDuplicate={duplicateSession} onDelete={deleteSession} onRenameFolder={renameFolder} onDeleteFolder={deleteFolder} onToggleFolder={toggleFolder} onMoveSession={moveSession} />
    <main className="app-main">
      <TopBar session={session} saveState={storageStatus} onDebugView={(panel) => { setDebugPanel(panel); setDirectoryOpen(false); }} directoryOpen={directoryOpen} onDirectoryToggle={() => setDirectoryOpen((open) => !open)} archiveableToolGroups={archiveableToolGroupCount} onArchiveOldTools={() => setArchiveToolRequest((request) => request + 1)} sidebarCollapsed={sidebarCollapsed} onToggleSidebar={() => setSidebarCollapsed((value) => !value)} theme={theme} onTheme={() => setTheme((value) => value === "light" ? "dark" : "light")} rightOpen={rightOpen} onRight={() => setRightOpen((value) => !value)} compactTools={compactTools} onCompactTools={() => setCompactTools((value) => !value)} piSessions={piSessions} followPi={workspace.followPi} onFollowPi={setFollowPi} syncError={syncError} onSelectPi={(id) => void selectPiSession(id)} onApplyPi={() => void applyToPi()} onDiscardPi={() => { if (session.piSync) void readPiSession(session.piSync.id, false, true).catch((error) => setSyncError(error.message)); }} onCancelPending={() => void cancelPiApply()} onTitle={(title) => patchSession({ title })} onWorkingDirectory={(workingDirectory) => updateSetting("workingDirectory", workingDirectory)} onFork={() => session.settings.toolMode === "agent" && !session.piSync ? requestSmartFork(`${session.title} · 提纯分身`, 0, true) : setForkModalOpen(true)} forkDisabled={busy} />
      <div className="workspace-body">
        {rightOpen && <button type="button" className="right-panel-backdrop" aria-label="关闭工作台遮罩" onClick={() => setRightOpen(false)} />}
        <section className="conversation-pane">
          <MessageStream sessionId={session.id} scrollRequest={scrollRequest} directoryOpen={directoryOpen} onDirectoryOpenChange={setDirectoryOpen} archiveRequest={archiveToolRequest} onArchiveableGroupsChange={reportArchiveableToolGroups} messages={session.messages} busy={busy} compactTools={compactTools} streamingId={streamingId} streamingThinking={streamingThinking} toolActivity={toolActivity} gptWorkers={visibleGptSessions} lineage={session.parentSessionId ? { parentSessionId: session.parentSessionId, parentSessionTitle: session.parentSessionTitle, forkSummary: session.forkSummary } : undefined} forkNotice={forkNotice?.sourceId === session.id ? { forkId: forkNotice.forkId, title: forkNotice.title } : undefined} onSwitchFork={selectSession} onJumpToSession={selectSession} onFork={() => setForkModalOpen(true)} onMessage={updateMessage} onCall={updateCall} onAdd={addMessage} onMove={moveMessage} onDelete={deleteMessage} onDeleteCall={deleteToolCall} onAddToolResult={addManualToolResult} onBranch={branchAt} onCopy={(text) => void copyText(text)} />
          {runErrors[session.id] && <div className="run-error-banner" role="alert"><AlertTriangle size={17} /><div><strong>本次运行失败</strong><span>{runErrors[session.id]}</span></div><button onClick={() => setSessionRunError(session.id)} aria-label="关闭运行错误">关闭<X size={14} /></button></div>}
          <ComposerBar busy={busy} blocked={!!session.piSync} toolName={toolActivity?.name} messageCount={session.messages.length} contextTokens={contextMetrics.context} savedPercent={contextMetrics.savedPercent} draft={composerText} onDraftChange={updateComposerText} backgroundWorkers={visibleGptSessions.filter((worker) => activeWorkerStatuses.has(worker.status))} wakeNotice={workerWakeNotice} onDismissWake={() => dismissSessionWorkerWake(session.id)} onReviewWorkers={() => reviewCurrentSessionWorkers(session.id)} onSend={sendMessage} onRun={() => void run()} onStop={() => void abortRun()} />
        </section>
        <RightPanel hidden={!rightOpen} onClose={() => setRightOpen(false)} session={session} busy={busy} runtimeCwd={runtimeCwd} onSessionsChange={reportGptSessions} apiKey={currentApiKey} models={piConnection?.models || []} piConnected={piConnection?.connected} piDefaultModel={piConnection?.defaultModel} activeRun={activeRun} onSetting={updateSetting} onNotice={setNotice} onApiKey={(key) => setApiKeys((current) => ({ ...current, [session.id]: key }))} onRefreshAuth={() => void refreshPiStatus()} onExport={exportSession} onImport={(file) => void importSession(file)} />
      </div>
    </main>
    {debugPanel && <div className="debug-overlay" role="presentation" onClick={() => setDebugPanel(null)}>
      <section className="debug-drawer" role="dialog" aria-modal="true" aria-labelledby="debug-drawer-title" onClick={(event) => event.stopPropagation()}>
        <header><div><small>SECONDARY TOOLS</small><h2 id="debug-drawer-title">{debugPanel === "request" ? "请求检查" : debugPanel === "history" ? "运行记录" : "诊断日志"}</h2></div><button className="icon-button" aria-label="关闭调试面板" title="关闭" onClick={() => setDebugPanel(null)}><X size={17} /></button></header>
        <div className="debug-drawer-content">
          {debugPanel === "request" && <RequestInspector draft={inspectorDraft} activeRun={activeRun} onCopy={(text) => void copyText(text)} />}
          {debugPanel === "history" && <RunHistory runs={session.runs} activeId={activeRun?.id} onSelect={setSelectedRun} onRestore={(settings, messages) => { if (busyForSessionRef.current(session.id)) return; patchSession({ settings, messages }); setDebugPanel(null); setNotice("已恢复运行前的消息与参数。"); setScrollRequest((value) => value + 1); }} onInspect={(id) => { setSelectedRun(id); setDebugPanel("request"); }} />}
          {debugPanel === "diagnostics" && <DiagnosticsView />}
        </div>
      </section>
    </div>}
    {forkModalOpen && <SessionForkModal key={session.id} session={session} canUseSmartFork={session.settings.toolMode === "agent" && !session.piSync && !busy} onClose={() => setForkModalOpen(false)} onCreate={(title, memory, carry) => createForkSession(title, memory, carry, true, session.id)} onSmartFork={requestSmartFork} />}
    {notice && <div className="toast" role="status"><CircleHelp size={16} /><span>{notice}</span><button onClick={() => setNotice("")} aria-label="关闭提示"><X size={14} /></button></div>}
  </div>;
}
