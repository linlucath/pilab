import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CircleHelp, X } from "lucide-react";
import { type Message, type ReasoningEffort, type Settings, type ToolCall } from "../shared/schema";
import type { GptSessionSummary } from "../shared/gpt-sessions";
import { addToolResult as createToolResult, completeToolBranchEnd, deleteMessageWithToolPairs, deleteToolCallWithResult, patchMessageWithToolPairs, patchToolCallWithResult, toolHistoryError } from "../shared/tool-history";
import { useProjectWorkspace, type Run, type Session, type Workspace } from "./workspace-store";
import { newSession, uid, loadLegacyWorkspace } from "./utils/session";
import { contextTokenMetrics } from "./utils/context-tokens";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { MessageStream } from "./components/MessageStream";
import { ComposerBar } from "./components/ComposerBar";
import { ThreadTabs } from "./components/ThreadTabs";
import { installGlobalErrorLogging, reportClientDiagnostic } from "./utils/logger";

type PiConnection = {
  connected: boolean; provider: string; defaultModel?: string;
  models: { id: string; name: string; reasoningEfforts: ReasoningEffort[]; reasoningEffortMap?: Partial<Record<ReasoningEffort, string | null>> }[];
};
type ToolActivity = { name: string; arguments: unknown; output: string };
type WorkerWakeNotice = { sessionId: string; cwd: string; names: string[] };
type WorkerReview = Pick<WorkerWakeNotice, "sessionId" | "cwd" | "names">;
type SessionStreamView = { streamingId: string; thinking: string; toolActivity: ToolActivity | null };
type RunControl = { sessionId: string; runId: string; lastSeq: number; shouldSubscribe: boolean; readerController?: AbortController; resume?: () => void };
const emptyStreamView: SessionStreamView = { streamingId: "", thinking: "", toolActivity: null };
const activeWorkerStatuses = new Set(["starting", "running", "waiting_input"]);
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
function sameStringMap(left: Map<string, string>, right: Map<string, string>) {
  return left.size === right.size && [...left].every(([key, value]) => right.get(key) === value);
}

function updateSessionUrl(sessionId: string, replace = false) {
  const url = new URL(window.location.href);
  if (url.searchParams.get("session") === sessionId) return;
  url.searchParams.set("session", sessionId);
  if (replace) window.history.replaceState(window.history.state, "", url);
  else window.history.pushState(window.history.state, "", url);
}
function normalizedWorkerCwd(value: string) {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "/";
}
function workerSignature(worker: GptSessionSummary, cwd: string) {
  const version = typeof worker.replySequence === "number"
    ? ["reply", worker.replySequence]
    : ["turn", worker.updatedAt, worker.lastReplyPreview];
  return JSON.stringify([normalizedWorkerCwd(cwd), worker.id, ...version]);
}
function workerNoticeNames(content: string) {
  const match = /^后台 GPT 工兵已交卷：(.+?)。请使用 (?:subagent_query|gpt_session_read)/.exec(content.trim());
  return match ? [...match[1].matchAll(/「([^」]+)」/g)].map((item) => item[1]) : [];
}

export default function App() {
  useEffect(() => installGlobalErrorLogging(), []);
  const [notice, setNotice] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try { return localStorage.getItem("pilab-theme-v2") === "dark" ? "dark" : "light"; }
    catch { return "light"; }
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.matchMedia("(max-width: 860px)").matches);
  const [compactTools, setCompactTools] = useState(() => {
    try { return localStorage.getItem("pilab-tools-compact-v1") !== "false"; } catch { return true; }
  });
  const [runErrors, setRunErrors] = useState<Record<string, string>>({});
  const [scrollRequest, setScrollRequest] = useState(0);
  const [streamViews, setStreamViews] = useState<Record<string, SessionStreamView>>({});
  const [activeRuns, setActiveRuns] = useState<Map<string, string>>(() => new Map());
  const [startingSessions, setStartingSessions] = useState<Set<string>>(() => new Set());
  const [piConnection, setPiConnection] = useState<PiConnection | null>(null);
  const [gptSessionSnapshot, setGptSessionSnapshot] = useState<{ ownerSessionId: string; cwd: string; sessions: GptSessionSummary[] }>({ ownerSessionId: "", cwd: "", sessions: [] });
  const [selectedWorkerId, setSelectedWorkerId] = useState("");
  const [workerMessagesById, setWorkerMessagesById] = useState<Record<string, Message[]>>({});
  const [pendingWorkerMessagesById, setPendingWorkerMessagesById] = useState<Record<string, Message[]>>({});
  const [workerMessagesError, setWorkerMessagesError] = useState("");
  const workerMessagesRef = useRef<Record<string, Message[]>>({});
  const workerMessagesDirtyRef = useRef(new Set<string>());
  const workerMessageBaselineRef = useRef<Record<string, Map<string, Message>>>({});
  const pendingWorkerMessagesRef = useRef<Record<string, Message[]>>({});
  const [gptSessionsError, setGptSessionsError] = useState("");
  workerMessagesRef.current = workerMessagesById;
  pendingWorkerMessagesRef.current = pendingWorkerMessagesById;
  const [workerWakeNotices, setWorkerWakeNotices] = useState<WorkerWakeNotice[]>([]);
  const workerSnapshotsRef = useRef(new Map<string, Map<string, GptSessionSummary>>());
  const activeRunsRef = useRef(activeRuns);
  const startingSessionsRef = useRef(startingSessions);
  const runControlsRef = useRef(new Map<string, RunControl>());
  const completedRunIdsRef = useRef(new Set<string>());
  const busyForSessionRef = useRef<(sessionId: string) => boolean>(() => false);
  const sessionRouteInitialized = useRef(false);
  const sessionWorkspaceRequests = useRef(new Map<string, Promise<string>>());
  const runStartLocks = useRef(new Set<string>());

  const { workspace, setWorkspace, workspaceRef, ready, error: storageError } =
    useProjectWorkspace(loadLegacyWorkspace, () => newSession(), setNotice);
  const session = workspace.sessions.find((item) => item.id === workspace.active) || workspace.sessions[0] || newSession();
  const requestSessionWorkspace = useCallback(async (sessionId: string) => {
    const response = await fetch("/api/session-workspaces", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId }),
    });
    const data = await response.json();
    if (!response.ok || typeof data.workingDirectory !== "string") throw new Error(data.error || "无法创建会话工作区。");
    return data.workingDirectory as string;
  }, []);
  const ensureSessionWorkspace = useCallback(async (sessionId: string) => {
    const current = workspaceRef.current.sessions.find((item) => item.id === sessionId);
    if (current?.settings.workingDirectory.trim()) return current.settings.workingDirectory;
    const pending = sessionWorkspaceRequests.current.get(sessionId);
    if (pending) return pending;
    const request = requestSessionWorkspace(sessionId).then((workingDirectory) => {
      setWorkspace((currentWorkspace) => ({
        ...currentWorkspace,
        sessions: currentWorkspace.sessions.map((item) => item.id === sessionId && !item.settings.workingDirectory.trim()
          ? { ...item, settings: { ...item.settings, workingDirectory } }
          : item),
      }));
      return workingDirectory;
    }).finally(() => sessionWorkspaceRequests.current.delete(sessionId));
    sessionWorkspaceRequests.current.set(sessionId, request);
    return request;
  }, [requestSessionWorkspace, setWorkspace, workspaceRef]);
  useEffect(() => {
    if (!ready) return;
    const routeId = new URL(window.location.href).searchParams.get("session");
    if (!sessionRouteInitialized.current) {
      sessionRouteInitialized.current = true;
      if (routeId && workspace.sessions.some((item) => item.id === routeId)) {
        if (workspace.active !== routeId)
          setWorkspace((current) => current.active === routeId ? current : { ...current, active: routeId, followPi: false });
        return;
      }
      updateSessionUrl(workspace.active, true);
      return;
    }
    if (routeId !== workspace.active) updateSessionUrl(workspace.active, true);
  }, [ready, workspace.active, workspace.sessions, setWorkspace]);
  useEffect(() => {
    if (!ready) return;
    const onPopState = () => {
      const routeId = new URL(window.location.href).searchParams.get("session");
      if (routeId && workspaceRef.current.sessions.some((item) => item.id === routeId))
        setWorkspace((current) => current.active === routeId ? current : { ...current, active: routeId, followPi: false });
      else updateSessionUrl(workspaceRef.current.active, true);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [ready, setWorkspace, workspaceRef]);
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
  const [metricsSnapshot, setMetricsSnapshot] = useState(() => ({ sessionId: session.id, messages: session.messages }));
  const metricMessages = metricsSnapshot.sessionId === session.id ? metricsSnapshot.messages : session.messages;
  const contextMetrics = useMemo(() => contextTokenMetrics(metricMessages), [metricMessages]);
  useEffect(() => {
    const timer = window.setTimeout(() => setMetricsSnapshot({ sessionId: session.id, messages: session.messages }), 250);
    return () => window.clearTimeout(timer);
  }, [session.id, session.messages]);
  const effectiveCwd = session.settings.workingDirectory.trim();
  const reportGptSessions = useCallback((ownerSessionId: string, sessions: GptSessionSummary[]) => {
    const cwdKey = normalizedWorkerCwd(effectiveCwd);
    setGptSessionSnapshot((current) => current.ownerSessionId === ownerSessionId && current.cwd === effectiveCwd &&
      JSON.stringify(current.sessions) === JSON.stringify(sessions)
      ? current : { ownerSessionId, cwd: effectiveCwd, sessions });
    const snapshotKey = `${ownerSessionId}\\0${cwdKey}`;
    const previous = workerSnapshotsRef.current.get(snapshotKey);
    const nextById = new Map(sessions.map((worker) => [worker.id, worker]));
    workerSnapshotsRef.current.set(snapshotKey, nextById);
    const workersByName = new Map(sessions.map((worker) => [worker.name, worker]));
    const pruneResolvedNotices = (notices: WorkerWakeNotice[]) => notices.flatMap((notice) => {
      if (notice.sessionId !== ownerSessionId || normalizedWorkerCwd(notice.cwd) !== cwdKey) return [notice];
      const names = notice.names.filter((name) => {
        const worker = workersByName.get(name);
        return !worker || (worker.hasUnreadReply && !worker.hasActiveWaiter);
      });
      return names.length ? [{ ...notice, names }] : [];
    });
    setWorkerWakeNotices((current) => {
      const next = pruneResolvedNotices(current);
      return JSON.stringify(current) === JSON.stringify(next) ? current : next;
    });
    const completed = sessions.filter((worker) => {
      const old = previous?.get(worker.id);
      return worker.ownerSessionId === ownerSessionId && !activeWorkerStatuses.has(worker.status) &&
        worker.hasUnreadReply && !worker.hasActiveWaiter && (!old || !old.hasUnreadReply || !!old.hasActiveWaiter);
    });
    if (!completed.length) return;
    const owner = workspaceRef.current.sessions.find((item) => item.id === ownerSessionId);
    if (!owner) return;
    const names = completed.filter((worker) => !owner.reviewedWorkerSignatures?.includes(workerSignature(worker, effectiveCwd))).map((worker) => worker.name);
    if (!names.length) return;
    const notice = { sessionId: ownerSessionId, cwd: effectiveCwd, names };
    setWorkerWakeNotices((current) => {
      const next = pruneResolvedNotices(current);
      const existingIndex = next.findIndex((item) => item.sessionId === ownerSessionId && normalizedWorkerCwd(item.cwd) === cwdKey);
      if (existingIndex < 0) next.push(notice);
      else next[existingIndex] = { ...next[existingIndex], names: [...new Set([...next[existingIndex].names, ...names])] };
      return next;
    });
  }, [effectiveCwd, workspaceRef]);
  const visibleGptSessions = gptSessionSnapshot.ownerSessionId === session.id && gptSessionSnapshot.cwd === effectiveCwd
    ? gptSessionSnapshot.sessions.filter((worker) => worker.ownerSessionId === session.id) : [];
  const selectedWorker = visibleGptSessions.find((worker) => worker.id === selectedWorkerId);
  const currentMessages = selectedWorker ? workerMessagesById[selectedWorker.id] || [] : session.messages;
  const currentContextMetrics = selectedWorker ? contextTokenMetrics(currentMessages) : contextMetrics;
  const updateSelectedWorkerMessages = (update: (messages: Message[]) => Message[], markDirty = true) => {
    const workerId = selectedWorkerId;
    if (!workerId) return false;
    if (markDirty) workerMessagesDirtyRef.current.add(workerId);
    setWorkerMessagesById((current) => ({ ...current, [workerId]: update(current[workerId] || []) }));
    return true;
  };
  const updateWorkerSummary = useCallback((worker: GptSessionSummary) => {
    if (worker.ownerSessionId !== session.id) return;
    const snapshotKey = `${session.id}\\0${normalizedWorkerCwd(effectiveCwd)}`;
    const previous = workerSnapshotsRef.current.get(snapshotKey);
    if (previous) workerSnapshotsRef.current.set(snapshotKey, new Map(previous).set(worker.id, worker));
    setGptSessionSnapshot((current) => {
      if (current.ownerSessionId !== session.id || current.cwd !== effectiveCwd) return current;
      const index = current.sessions.findIndex((item) => item.id === worker.id);
      const sessions = index < 0 ? [...current.sessions, worker] : current.sessions.map((item) => item.id === worker.id ? worker : item);
      return JSON.stringify(current.sessions) === JSON.stringify(sessions)
        ? current : { ...current, sessions };
    });
  }, [effectiveCwd, session.id]);
  useEffect(() => {
    setSelectedWorkerId("");
    setWorkerMessagesError("");
  }, [session.id]);
  useEffect(() => {
    if (!selectedWorker) return;
    const workerId = selectedWorker.id;
    let cancelled = false;
    let loading = false;
    const controller = new AbortController();
    const loadMessages = async () => {
      if (loading || cancelled) return;
      loading = true;
      try {
        const query = new URLSearchParams({ cwd: effectiveCwd, ownerSessionId: session.id });
        const response = await fetch(`/api/gpt-sessions/${encodeURIComponent(selectedWorker.name)}/messages?${query}`, { cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "读取工兵消息失败。");
        if (cancelled) return;
        if (data.session) updateWorkerSummary(data.session);
        const serverMessages = Array.isArray(data.messages) ? data.messages as Message[] : [];
        const pending = pendingWorkerMessagesRef.current[workerId] || [];
        const remaining = [...pending];
        for (const message of serverMessages) {
          const index = remaining.findIndex((item) => item.role === message.role && item.content === message.content);
          if (index >= 0) remaining.splice(index, 1);
        }
        const remainingIds = new Set(remaining.map((message) => message.id));
        const matchedPendingIds = new Set(pending.filter((message) => !remainingIds.has(message.id)).map((message) => message.id));
        setPendingWorkerMessagesById((current) => ({ ...current, [workerId]: remaining }));
        const localMessages = (workerMessagesRef.current[workerId] || []).filter((message) => !matchedPendingIds.has(message.id));
        const baseline = workerMessageBaselineRef.current[workerId] || new Map<string, Message>();
        let messages = [...serverMessages, ...remaining];
        if (workerMessagesDirtyRef.current.has(workerId)) {
          const localById = new Map(localMessages.map((message) => [message.id, message]));
          const serverIds = new Set(serverMessages.map((message) => message.id));
          const resolvedById = new Map<string, Message>();
          for (const message of serverMessages) {
            const local = localById.get(message.id);
            const previous = baseline.get(message.id);
            if (previous && !local) continue;
            resolvedById.set(message.id, local && previous && JSON.stringify(local) !== JSON.stringify(previous) ? local : message);
          }
          messages = [
            ...localMessages.flatMap((message) => {
              const resolved = resolvedById.get(message.id);
              if (resolved) return [resolved];
              return !baseline.has(message.id) && !serverIds.has(message.id) ? [message] : [];
            }),
            ...serverMessages
              .filter((message) => !localById.has(message.id) && !baseline.has(message.id))
              .map((message) => resolvedById.get(message.id) || message),
            ...remaining.filter((message) => !localById.has(message.id)),
          ];
        }
        workerMessageBaselineRef.current[workerId] = new Map(serverMessages.map((message) => [message.id, message]));
        setWorkerMessagesById((current) => {
          return JSON.stringify(current[workerId] || []) === JSON.stringify(messages)
            ? current : { ...current, [workerId]: messages };
        });
        setWorkerMessagesError("");
      } catch (error) {
        if (!controller.signal.aborted) setWorkerMessagesError(error instanceof Error ? error.message : "读取工兵消息失败。");
      } finally { loading = false; }
    };
    void loadMessages();
    const timer = window.setInterval(() => void loadMessages(), activeWorkerStatuses.has(selectedWorker.status) ? 2_000 : 5_000);
    return () => { cancelled = true; controller.abort(); window.clearInterval(timer); };
  }, [selectedWorker?.id, selectedWorker?.name, selectedWorker?.status, session.id, effectiveCwd, updateWorkerSummary]);
  const fetchGptSessions = useCallback(async (signal?: AbortSignal) => {
    if (!effectiveCwd) return;
    const query = new URLSearchParams({ cwd: effectiveCwd, ownerSessionId: session.id });
    try {
      const response = await fetch(`/api/gpt-sessions?${query}`, { cache: "no-store", signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "读取工兵会话失败。");
      if (signal?.aborted) return;
      reportGptSessions(session.id, Array.isArray(data.sessions) ? data.sessions : []);
      setGptSessionsError("");
    } catch (cause) {
      if (!signal?.aborted) setGptSessionsError(cause instanceof Error ? cause.message : "读取工兵会话失败。");
    }
  }, [effectiveCwd, reportGptSessions, session.id]);
  const activeWakeNotices = workerWakeNotices.filter((notice) => notice.sessionId === session.id);
  const workerWakeNotice = activeWakeNotices.length ? {
    names: [...new Set(activeWakeNotices.flatMap((notice) => notice.names))],
  } : null;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("pilab-theme-v2", theme); } catch { /* storage is optional */ }
  }, [theme]);
  useEffect(() => { try { localStorage.setItem("pilab-tools-compact-v1", String(compactTools)); } catch { /* storage is optional */ } }, [compactTools]);
  useEffect(() => {
    if (!ready || !effectiveCwd) return;
    let cancelled = false;
    let polling = false;
    const controller = new AbortController();
    const poll = async () => {
      if (polling || cancelled) return;
      polling = true;
      try { await fetchGptSessions(controller.signal); }
      finally { polling = false; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1_200);
    return () => { cancelled = true; controller.abort(); window.clearInterval(timer); };
  }, [ready, effectiveCwd, fetchGptSessions]);
  useEffect(() => {
    if (!ready) return;
    const needsWorkspace = workspace.sessions.filter((item) => !item.settings.workingDirectory.trim());
    if (!needsWorkspace.length) return;
    void Promise.all(needsWorkspace.map((item) => ensureSessionWorkspace(item.id)))
      .catch((error) => setNotice(`创建会话工作区失败：${error instanceof Error ? error.message : String(error)}`));
  }, [ready, workspace.sessions, ensureSessionWorkspace]);
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
        if (!sameStringMap(activeRunsRef.current, next)) {
          activeRunsRef.current = next;
          setActiveRuns(next);
        }
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
    const compactQuery = window.matchMedia("(max-width: 860px)");
    let compact = compactQuery.matches;
    const onResize = () => {
      if (compactQuery.matches === compact) return;
      compact = compactQuery.matches;
      if (!compact) setSidebarCollapsed(false);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (selectedWorkerId || !(event.metaKey || event.ctrlKey) || event.key !== "Enter" || busyForSessionRef.current(workspaceRef.current.active)) return;
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
    if (!selectedWorkerId && currentRunLocksActiveSession()) return;
    if (selectedWorkerId) {
      const target = workerMessagesRef.current[selectedWorkerId]?.find((message) => message.id === id);
      if (!target) return;
      if (values.role !== undefined && values.role !== target.role &&
        (target.role === "tool" || !!target.toolCalls?.length || values.role === "tool")) {
        setNotice("不能直接更改工具调用或结果的角色，以免破坏工具配对。");
        return;
      }
      updateSelectedWorkerMessages((messages) => patchMessageWithToolPairs(messages, id, values));
      return;
    }
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
    if (!selectedWorkerId && currentRunLocksActiveSession()) return;
    if (selectedWorkerId) {
      updateSelectedWorkerMessages((messages) => patchToolCallWithResult(messages, message.id, index, { ...values, ...(values.id ? { thoughtSignature: undefined } : {}) }));
      return;
    }
    updateActive((current) => ({
      ...current,
      messages: patchToolCallWithResult(current.messages, message.id, index, { ...values, ...(values.id ? { thoughtSignature: undefined } : {}) }),
      ...(current.piSync ? { piSync: { ...current.piSync, dirty: true } } : {}),
    }));
  };
  const addMessage = (after?: number, role: Message["role"] = "user") => {
    if (!selectedWorkerId && currentRunLocksActiveSession()) return;
    const id = uid();
    if (selectedWorkerId) {
      updateSelectedWorkerMessages((current) => {
        const messages = [...current];
        messages.splice(after === undefined ? messages.length : Math.max(0, Math.min(after + 1, messages.length)), 0, { id, role, content: "", enabled: true });
        return messages;
      });
      return;
    }
    updateActive((current) => {
      const messages = [...current.messages];
      messages.splice(after === undefined ? messages.length : Math.max(0, Math.min(after + 1, messages.length)), 0, { id, role, content: "", enabled: true });
      return { ...current, messages, ...(current.piSync ? { piSync: { ...current.piSync, dirty: true } } : {}) };
    });
    setScrollRequest((value) => value + 1);
  };
  const moveMessage = (index: number, delta: number) => {
    if (!selectedWorkerId && currentRunLocksActiveSession()) return;
    const move = (messages: Message[]) => {
      if (index + delta < 0 || index + delta >= messages.length) return messages;
      const next = [...messages];
      [next[index], next[index + delta]] = [next[index + delta], next[index]];
      return next;
    };
    if (selectedWorkerId) {
      const messages = workerMessagesRef.current[selectedWorkerId] || [];
      const issue = toolHistoryError(move(messages).filter((message) => message.enabled));
      if (issue) { setNotice(`无法移动这条消息：${issue}`); return; }
      updateSelectedWorkerMessages(move);
      return;
    }
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
    if (!selectedWorkerId && currentRunLocksActiveSession()) return;
    if (selectedWorkerId) {
      updateSelectedWorkerMessages((messages) => deleteMessageWithToolPairs(messages, id));
      return;
    }
    const activeId = workspaceRef.current.active;
    const active = workspaceRef.current.sessions.find((item) => item.id === activeId);
    const target = active?.messages.find((message) => message.id === id);
    const dismissedNames = target ? workerNoticeNames(target.content) : [];
    const ownerKey = active ? `${active.id}\\0${normalizedWorkerCwd(effectiveCwd)}` : "";
    const ownerWorkers = active ? workerSnapshotsRef.current.get(ownerKey) : undefined;
    const dismissedSignatures = active && dismissedNames.length ? [...(ownerWorkers?.values() || [])]
      .filter((worker) => worker.ownerSessionId === active.id && dismissedNames.includes(worker.name))
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
    if (!selectedWorkerId && currentRunLocksActiveSession()) return;
    if (selectedWorkerId) {
      updateSelectedWorkerMessages((messages) => deleteToolCallWithResult(messages, assistantId, callId));
      return;
    }
    updateActive((current) => ({
      ...current,
      messages: deleteToolCallWithResult(current.messages, assistantId, callId),
      ...(current.piSync ? { piSync: { ...current.piSync, dirty: true } } : {}),
    }));
  };
  const addManualToolResult = (assistantId: string, callId: string, content: string, isError: boolean): boolean => {
    if (!selectedWorkerId && currentRunLocksActiveSession()) return false;
    if (selectedWorkerId) {
      const messages = workerMessagesRef.current[selectedWorkerId] || [];
      try {
        const next = createToolResult(messages, assistantId, callId, content, isError);
        updateSelectedWorkerMessages(() => next);
        return true;
      } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); return false; }
    }
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
  const createSession = async (copy?: Session) => {
    const id = uid();
    try {
      const workingDirectory = await requestSessionWorkspace(id);
      const next: Session = copy
        ? { ...structuredClone(copy), id, title: copy.title, settings: { ...copy.settings, workingDirectory }, runs: [] }
        : newSession(workingDirectory, id);
      delete next.piSync;
      setWorkspace((current) => ({ ...current, sessions: [...current.sessions, next], rootSessionIds: [next.id, ...current.rootSessionIds], active: next.id, followPi: false }));
      setScrollRequest((value) => value + 1);
      return true;
    } catch (error) { setNotice(`无法创建新会话：${error instanceof Error ? error.message : String(error)}`); return false; }
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
  const duplicateSession = (source: Session) => { void createSession({ ...source, title: `${source.title} · 副本` }); };
  const deleteSession = async (id: string) => {
    if (busyForSessionRef.current(id)) return;
    const target = workspaceRef.current.sessions.find((item) => item.id === id);
    if (!target || !window.confirm(`删除「${target.title}」？此操作无法撤销。`)) return;
    let replacement: Session | undefined;
    if (workspaceRef.current.sessions.length === 1) {
      const replacementId = uid();
      try { replacement = newSession(await requestSessionWorkspace(replacementId), replacementId); }
      catch (error) { setNotice(`无法创建替代会话：${error instanceof Error ? error.message : String(error)}`); return; }
    }
    setWorkspace((current) => {
      const sessions = current.sessions.filter((item) => item.id !== id);
      const folders = current.folders.map((folder) => ({ ...folder, sessionIds: folder.sessionIds.filter((sessionId) => sessionId !== id) }));
      let rootSessionIds = current.rootSessionIds.filter((sessionId) => sessionId !== id);
      if (!sessions.length && replacement) {
        sessions.push(replacement);
        rootSessionIds = [replacement.id, ...rootSessionIds];
      }
      return { ...current, sessions, folders, rootSessionIds, active: current.active === id ? sessions[0]?.id || current.active : current.active, followPi: false };
    });
  };
  const branchAt = (message: Message, index: number) => {
    if (selectedWorkerId) {
      const messages = workerMessagesRef.current[selectedWorkerId] || [];
      const end = completeToolBranchEnd(messages, index);
      if (end === null) { setNotice("无法在未完成的工具调用处创建分支；请先补齐工具结果。"); return; }
      if (selectedWorker) void createSession({ ...session, title: `${selectedWorker.name} · 分支`, messages: messages.slice(0, end + 1) });
      return;
    }
    if (busyForSessionRef.current(workspaceRef.current.active)) return;
    const currentSession = workspaceRef.current.sessions.find((item) => item.id === workspaceRef.current.active);
    if (!currentSession) return;
    const end = completeToolBranchEnd(currentSession.messages, index);
    if (end === null) { setNotice("无法在未完成的工具调用处创建分支；请先补齐工具结果。"); return; }
    createSession({ ...currentSession, title: `${currentSession.title} · 分支`, messages: currentSession.messages.slice(0, end + 1) });
  };
  const selectSession = (id: string) => {
    if (!workspaceRef.current.sessions.some((item) => item.id === id)) return;
    updateSessionUrl(id);
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
  async function copyText(value: string) { try { await navigator.clipboard.writeText(value); setNotice("已复制到剪贴板。"); } catch { setNotice("无法访问剪贴板。"); } }

  async function run(messagesToRun?: Message[], targetSessionId?: string, resumeRunId?: string) {
    if (!ready) return;
    const currentWorkspace = workspaceRef.current;
    const sessionId = targetSessionId || currentWorkspace.active;
    if (!resumeRunId && (busyForSessionRef.current(sessionId) || runStartLocks.current.has(sessionId))) return;
    let activeSession = currentWorkspace.sessions.find((item) => item.id === sessionId);
    if (!activeSession) return;
    if (!resumeRunId) runStartLocks.current.add(sessionId);
    const releaseStartLock = () => runStartLocks.current.delete(sessionId);
    if (!activeSession.settings.workingDirectory.trim()) {
      try {
        await ensureSessionWorkspace(sessionId);
        activeSession = workspaceRef.current.sessions.find((item) => item.id === sessionId);
        if (!activeSession?.settings.workingDirectory.trim()) throw new Error("会话工作区尚未就绪。");
      } catch (error) {
        releaseStartLock();
        setNotice(`无法启动运行：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    const runMessages = messagesToRun || activeSession.messages;
    const activeMessages = runMessages.filter((message) => message.enabled);
    if (!resumeRunId && (!activeMessages.length || !activeMessages.some((message) => message.content.trim() || message.images?.length || message.toolCalls?.length || message.role === "tool"))) {
      const message = "请先添加至少一条有内容且已启用的消息。";
      releaseStartLock(); setSessionRunError(activeSession.id, message); return;
    }
    const historyIssue = resumeRunId ? undefined : toolHistoryError(activeMessages);
    if (historyIssue) { releaseStartLock(); setSessionRunError(activeSession.id, historyIssue); return; }
    const runId = uid(); const started = Date.now();
    const settings = { ...activeSession.settings, apiKey: "" };
    const record: Run = { id: runId, at: started, status: "running", output: "", thinking: "", elapsed: 0, snapshot: { settings: { ...settings, apiKey: "" }, messages: structuredClone(runMessages) } };
    setSessionStarting(sessionId, true);
    releaseStartLock();
    setSessionRunError(sessionId);
    setWorkspace((current) => ({ ...current, sessions: current.sessions.map((item) => item.id === sessionId ? { ...item, runs: [record, ...item.runs].slice(0, 30) } : item) }));
    updateStreamView(sessionId, () => emptyStreamView);
    let remoteRunId = "";
    let runControl: RunControl | null = null;
    let text = ""; let thought = ""; let currentMessageId = uid(); let terminalReceived = false; let errorEventReceived = false; let failureMessage = "";
    let finalGenerationStatus = "done";
    const textById = new Map<string, string>(); const pendingTextIds = new Set<string>(); const trace: Message[] = []; const requests: unknown[] = [];
    let pendingThinkingText = "";
    let streamTextFlushTimer: number | undefined;
    const updateRun = (values: Partial<Run>) => setWorkspace((current) => ({ ...current, sessions: current.sessions.map((item) => item.id === sessionId ? { ...item, runs: item.runs.map((run) => run.id === runId ? { ...run, ...values, elapsed: Date.now() - started } : run) } : item) }));
    const upsert = (message: Message) => {
      const index = trace.findIndex((item) => item.id === message.id); if (index < 0) trace.push(message); else trace[index] = { ...trace[index], ...message };
      setWorkspace((current) => ({ ...current, sessions: current.sessions.map((item) => item.id !== sessionId ? item : { ...item, messages: item.messages.some((entry) => entry.id === message.id) ? item.messages.map((entry) => entry.id === message.id ? { ...entry, ...message } : entry) : [...item.messages, message] }) }));
      updateRun({ trace: [...trace] });
    };
    const flushPendingText = () => {
      if (streamTextFlushTimer !== undefined) window.clearTimeout(streamTextFlushTimer);
      streamTextFlushTimer = undefined;
      if (!pendingTextIds.size && !pendingThinkingText) return;
      if (pendingTextIds.size) {
        for (const id of pendingTextIds) {
          const content = textById.get(id);
          if (content !== undefined) upsert({ id, role: "assistant", content, enabled: true });
        }
        pendingTextIds.clear();
        text = [...textById.values()].filter(Boolean).join("\n\n");
        updateRun({ output: text });
      }
      if (pendingThinkingText) {
        const delta = pendingThinkingText;
        pendingThinkingText = "";
        updateStreamView(sessionId, (current) => ({ ...current, thinking: current.thinking + delta }));
        updateRun({ thinking: thought });
      }
    };
    const scheduleStreamFlush = () => {
      if (streamTextFlushTimer === undefined)
        streamTextFlushTimer = window.setTimeout(flushPendingText, 30);
    };
    const queueStreamText = (id: string, content: string) => {
      textById.set(id, content);
      pendingTextIds.add(id);
      scheduleStreamFlush();
    };
    const removeEmpty = (id: string) => {
      const empty = (message: Message) => message.id === id && message.role === "assistant" && !message.content.trim() && !message.toolCalls?.length && !message.images?.length && !message.providerState?.thinking.some((item) => item.thinking);
      const existing = trace.find((message) => message.id === id); if (existing && !empty(existing)) return;
      const index = trace.findIndex(empty); if (index >= 0) trace.splice(index, 1); textById.delete(id); pendingTextIds.delete(id); text = [...textById.values()].filter(Boolean).join("\n\n");
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
        if (event.type === "runtime") updateRun({ cwd: event.cwd as string | undefined });
        if (event.type === "request") { requests.push(event.payload); updateRun({ request: event.payload, requests: [...requests], turns: event.turn }); }
        if (event.type === "assistant_start") {
          flushPendingText();
          currentMessageId = event.id; updateStreamView(sessionId, (current) => ({ ...current, streamingId: event.id, thinking: "" })); textById.set(event.id, "");
          upsert({ id: event.id, role: "assistant", content: "", enabled: true });
        }
        if (event.type === "text") { const id = event.id || currentMessageId; const next = (textById.get(id) || "") + event.delta; queueStreamText(id, next); }
        if (event.type === "thinking") { thought += event.delta; pendingThinkingText += event.delta; scheduleStreamFlush(); }
        if (event.type === "assistant" || event.type === "message") {
          flushPendingText();
          const message = event.message as Message;
          const failedEmpty = message.role === "assistant" && ["error", "aborted"].includes(message.providerState?.stopReason || "") && !message.content.trim() && !message.toolCalls?.length && !message.images?.length && !message.providerState?.thinking.some((item) => item.thinking);
          if (failedEmpty) removeEmpty(message.id); else upsert(message);
          if (message.role === "assistant") { textById.set(message.id, message.content); text = [...textById.values()].filter(Boolean).join("\n\n"); updateRun({ output: text }); }
        }
        if (event.type === "tool_activity") updateStreamView(sessionId, (current) => ({ ...current, toolActivity: event as ToolActivity }));
        if (event.type === "tool_activity_end") updateStreamView(sessionId, (current) => ({ ...current, toolActivity: null }));
        if (event.type === "done") { flushPendingText(); finalGenerationStatus = event.reason === "length" ? "length" : event.reason === "turn_limit" ? "turn_limit" : "done"; updateRun({ status: finalGenerationStatus, usage: event.usage, turns: event.turns, output: text }); if (workspaceRef.current.active === sessionId && event.reason === "turn_limit") setNotice("已达到 Agent 最大轮数；可检查轨迹后继续。"); if (workspaceRef.current.active === sessionId && event.reason === "length") setNotice("已达到输出上限，回复未完成。"); }
        if (event.type === "error") { errorEventReceived = true; failureMessage = typeof event.message === "string" ? event.message : "模型运行发生错误。"; updateRun({ status: "error", error: failureMessage, output: text }); setSessionRunError(sessionId, failureMessage); }
        if (event.type === "run_status") {
          flushPendingText();
          terminalReceived = true;
          completedRunIdsRef.current.add(remoteRunId);
          if (completedRunIdsRef.current.size > 100)
            completedRunIdsRef.current.delete(completedRunIdsRef.current.values().next().value!);
          if (event.status === "completed") {
            updateRun({ status: finalGenerationStatus, error: undefined, output: text });
            if (!errorEventReceived) setSessionRunError(sessionId);
          }
          else if (event.status === "aborted") { settlePendingToolCalls("执行已停止，未收到该工具的完整结果。操作可能已经部分完成，请检查实际文件状态后再继续。"); updateRun({ status: "stopped", error: undefined, output: text }); setSessionRunError(sessionId); }
          else if (event.status === "failed") {
            const message = typeof event.message === "string" ? event.message : failureMessage || "模型运行失败。";
            settlePendingToolCalls(message);
            updateRun({ status: "error", error: message, output: text });
            setSessionRunError(sessionId, message);
          }
          if (runControl) { runControlsRef.current.delete(sessionId); setActiveRunForSession(sessionId, undefined); }
          updateStreamView(sessionId, () => emptyStreamView);
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
      flushPendingText();
      setSessionStarting(sessionId, false);
      if (runControl && runControlsRef.current.get(sessionId) === runControl) {
        runControl.readerController?.abort();
        runControlsRef.current.delete(sessionId);
        setActiveRunForSession(sessionId, undefined);
      }
      updateStreamView(sessionId, () => emptyStreamView);
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
  const sendMessage = (content: string, role: Message["role"], shouldRun: boolean, targetSessionOrImages?: string | Message["images"]): boolean => {
    const targetSessionId = typeof targetSessionOrImages === "string" ? targetSessionOrImages : undefined;
    const images = Array.isArray(targetSessionOrImages) ? targetSessionOrImages : undefined;
    if (busyForSessionRef.current(targetSessionId || workspaceRef.current.active) || !ready) return false;
    const activeId = targetSessionId || workspaceRef.current.active;
    const activeSession = workspaceRef.current.sessions.find((item) => item.id === activeId);
    if (!activeSession) return false;
    const message: Message = { id: uid(), role, content, enabled: true, ...(images?.length ? { images } : {}) };
    const nextWorkspace = setWorkspace((current) => {
      const target = current.sessions.find((item) => item.id === activeId);
      if (!target) return current;
      return {
        ...current,
        sessions: current.sessions.map((item) => item.id !== activeId ? item : {
          ...item, messages: [...item.messages, message],
        }),
      };
    });
    const nextSession = nextWorkspace.sessions.find((item) => item.id === activeId);
    if (!nextSession?.messages.some((item) => item.id === message.id)) return false;
    if (workspaceRef.current.active === activeId) setScrollRequest((value) => value + 1);
    if (shouldRun) void run(nextSession.messages, activeId);
    return true;
  };
  const sendWorkerGuidance = async (content: string, _role: Message["role"], _shouldRun: boolean, images?: Message["images"]): Promise<boolean> => {
    const workerId = selectedWorkerId;
    const worker = visibleGptSessions.find((item) => item.id === workerId);
    if (!worker || !ready) return false;
    if (images?.length) { setNotice("工兵指导目前只支持文本消息。"); return false; }
    try {
      const response = await fetch(`/api/gpt-sessions/${encodeURIComponent(worker.name)}/send`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: effectiveCwd, ownerSessionId: session.id, message: content, mode: "steer" }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "发送工兵指导失败。");
      if (data.session) updateWorkerSummary(data.session);
      const message: Message = { id: uid(), role: "user", content, enabled: true };
      setPendingWorkerMessagesById((current) => ({ ...current, [workerId]: [...(current[workerId] || []), message] }));
      setWorkerMessagesById((current) => {
        const messages = current[workerId] || [];
        if (messages.some((item) => item.role === "user" && item.content === content)) return current;
        return { ...current, [workerId]: [...messages, message] };
      });
      setWorkerMessagesError("");
      return true;
    } catch (error) {
      setWorkerMessagesError(error instanceof Error ? error.message : "发送工兵指导失败。");
      return false;
    }
  };
  function rememberReviewedWorkers(sessionId: string, cwd: string, names: string[]) {
    const owner = workspaceRef.current.sessions.find((item) => item.id === sessionId);
    if (!owner) return;
    const ownerKey = `${sessionId}\\0${normalizedWorkerCwd(cwd)}`;
    const ownerWorkers = workerSnapshotsRef.current.get(ownerKey);
    const signatures = [...(ownerWorkers?.values() || [])]
      .filter((worker) => worker.ownerSessionId === sessionId && names.includes(worker.name))
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
    const ownerKey = target ? `${target.id}\\0${normalizedWorkerCwd(review.cwd)}` : "";
    const ownerWorkers = target ? workerSnapshotsRef.current.get(ownerKey) : undefined;
    const ownedNames = new Set([...(ownerWorkers?.values() || [])].filter((worker) => worker.ownerSessionId === target?.id).map((worker) => worker.name));
    const unique = target ? [...new Set(review.names.filter((name) => ownedNames.has(name)))] : [];
    const matchesNotice = (notice: WorkerWakeNotice | WorkerReview) => notice.sessionId === review.sessionId && normalizedWorkerCwd(notice.cwd) === normalizedWorkerCwd(review.cwd);
    if (!target || !unique.length) {
      setWorkerWakeNotices((current) => current.filter((notice) => !matchesNotice(notice)));
      return;
    }
    if (busyForSessionRef.current(target.id)) {
      setNotice("所属会话正在运行；工兵交卷提醒已保留，运行结束后请再次点击审阅。");
      return;
    }
    const prompt = `后台 GPT 工兵已交卷：${unique.map((name) => `「${name}」`).join("、")}。请使用 subagent_query 对每个工兵执行 action=status，读取新简报并核对完成情况，给用户一份简洁、准确的中文汇报；如有失败、diagnostics、问题或待决策事项，请明确指出。不要重启或打断仍在运行的工兵。`;
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
  const messageStreamHandlersRef = useRef({
    updateMessage, updateCall, addMessage, moveMessage, deleteMessage, deleteToolCall, addManualToolResult, branchAt, selectSession,
    copyMessage: (text: string) => { void copyText(text); },
  });
  messageStreamHandlersRef.current = {
    updateMessage, updateCall, addMessage, moveMessage, deleteMessage, deleteToolCall, addManualToolResult, branchAt, selectSession,
    copyMessage: (text: string) => { void copyText(text); },
  };
  const onMessage = useCallback((...args: Parameters<typeof updateMessage>) => messageStreamHandlersRef.current.updateMessage(...args), []);
  const onCall = useCallback((...args: Parameters<typeof updateCall>) => messageStreamHandlersRef.current.updateCall(...args), []);
  const onAdd = useCallback((...args: Parameters<typeof addMessage>) => messageStreamHandlersRef.current.addMessage(...args), []);
  const onMove = useCallback((...args: Parameters<typeof moveMessage>) => messageStreamHandlersRef.current.moveMessage(...args), []);
  const onDelete = useCallback((...args: Parameters<typeof deleteMessage>) => messageStreamHandlersRef.current.deleteMessage(...args), []);
  const onDeleteCall = useCallback((...args: Parameters<typeof deleteToolCall>) => messageStreamHandlersRef.current.deleteToolCall(...args), []);
  const onAddToolResult = useCallback((...args: Parameters<typeof addManualToolResult>) => messageStreamHandlersRef.current.addManualToolResult(...args), []);
  const onBranch = useCallback((...args: Parameters<typeof branchAt>) => messageStreamHandlersRef.current.branchAt(...args), []);
  const onCopyMessage = useCallback((text: string) => messageStreamHandlersRef.current.copyMessage(text), []);
  if (!ready) return <div className="app-loading" role="status">{storageError || "正在打开本地工作区…"}{storageError && <button onClick={() => location.reload()}>重试</button>}</div>;
  return <div className={`app-shell ${sidebarCollapsed ? "sidebar-compact" : ""}`}>
    <Sidebar sessions={workspace.sessions} folders={workspace.folders} rootSessionIds={workspace.rootSessionIds} active={session.id} collapsed={sidebarCollapsed} activeRuns={activeRuns} onToggle={() => setSidebarCollapsed((value) => !value)} onCreate={() => createSession()} onCreateFolder={createFolder} onSelect={selectSession} onRename={renameSession} onDuplicate={duplicateSession} onDelete={deleteSession} onRenameFolder={renameFolder} onDeleteFolder={deleteFolder} onToggleFolder={toggleFolder} onMoveSession={moveSession} />
    <main className="app-main">
      <TopBar session={session} sidebarCollapsed={sidebarCollapsed} onToggleSidebar={() => setSidebarCollapsed((value) => !value)} onTitle={(title) => patchSession({ title })} />
      <div className="workspace-body">
        <section className="conversation-pane">
          <ThreadTabs sessionId={session.id} workers={visibleGptSessions} selectedWorkerId={selectedWorkerId} onSelectWorker={setSelectedWorkerId} onCloseWorker={(workerId) => setSelectedWorkerId((current) => current === workerId ? "" : current)} />
          {gptSessionsError && !selectedWorker && <div className="run-error-banner" role="status"><AlertTriangle size={17} /><div><strong>读取工兵列表失败</strong><span>{gptSessionsError}</span></div><button onClick={() => setGptSessionsError("")} aria-label="关闭工兵列表错误">关闭<X size={14} /></button></div>}
          {selectedWorker && workerMessagesError && <div className="run-error-banner" role="alert"><AlertTriangle size={17} /><div><strong>工兵对话失败</strong><span>{workerMessagesError}</span></div><button onClick={() => setWorkerMessagesError("")} aria-label="关闭工兵对话错误">关闭<X size={14} /></button></div>}
          <MessageStream sessionId={`${session.id}:${selectedWorker?.id || "main"}`} scrollRequest={scrollRequest} messages={currentMessages} assistantName={selectedWorker ? `${selectedWorker.model} · ${selectedWorker.name}` : "Gemini"} busy={selectedWorker ? false : busy} compactTools={compactTools} streamingId={selectedWorker ? undefined : streamingId} streamingThinking={selectedWorker ? undefined : streamingThinking} toolActivity={selectedWorker ? undefined : toolActivity} gptWorkers={selectedWorker ? [] : visibleGptSessions} onMessage={onMessage} onCall={onCall} onAdd={onAdd} onMove={onMove} onDelete={onDelete} onDeleteCall={onDeleteCall} onAddToolResult={onAddToolResult} onBranch={onBranch} onCopy={onCopyMessage} />
          {!selectedWorker && runErrors[session.id] && <div className="run-error-banner" role="alert"><AlertTriangle size={17} /><div><strong>本次运行失败</strong><span>{runErrors[session.id]}</span></div><button onClick={() => setSessionRunError(session.id)} aria-label="关闭运行错误">关闭<X size={14} /></button></div>}
          <ComposerBar key={session.id} busy={selectedWorker ? false : busy} workerMode={!!selectedWorker} placeholder={selectedWorker ? `给工兵发送直接指导 (Steer)…` : undefined} toolName={selectedWorker ? undefined : toolActivity?.name} messageCount={currentMessages.length} contextTokens={currentContextMetrics.context} savedPercent={currentContextMetrics.savedPercent} settings={session.settings} models={piConnection?.models || []} defaultModel={piConnection?.defaultModel} piConnected={piConnection?.connected} onSetting={updateSetting} onNotice={setNotice} onRefreshModels={() => void refreshPiStatus()} backgroundWorkers={selectedWorker ? [] : visibleGptSessions.filter((worker) => activeWorkerStatuses.has(worker.status))} wakeNotice={selectedWorker ? undefined : workerWakeNotice} onDismissWake={() => dismissSessionWorkerWake(session.id)} onReviewWorkers={() => reviewCurrentSessionWorkers(session.id)} onSend={selectedWorker ? sendWorkerGuidance : sendMessage} onRun={() => { if (!selectedWorker) void run(); }} onStop={() => { if (!selectedWorker) void abortRun(); }} />
        </section>
      </div>
    </main>
    {notice && <div className="toast" role="status"><CircleHelp size={16} /><span>{notice}</span><button onClick={() => setNotice("")} aria-label="关闭提示"><X size={14} /></button></div>}
  </div>;
}
