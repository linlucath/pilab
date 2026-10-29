import type { Response } from "express";
import { randomUUID } from "node:crypto";
import { generate } from "./engine";
import type { Message, Settings } from "../shared/schema";

export type RunStatus = "running" | "completed" | "failed" | "aborted";
export type RunInput = { settings: Settings; messages: Message[] };
export type RunEvent = Record<string, unknown>;
export type RunGenerator = (
  input: RunInput,
  emit: (event: RunEvent) => void,
  signal: AbortSignal,
) => Promise<Message[] | void>;
export type AppendRunMessages = (sessionId: string, messages: Message[]) => Promise<unknown>;

export interface RunTask {
  runId: string;
  sessionId: string;
  cwd: string;
  status: RunStatus;
  abortController: AbortController;
  eventBuffer: Array<{ seq: number; event: RunEvent }>;
  listeners: Set<Response>;
  listenerCloseHandlers: Map<Response, () => void>;
  lastSeq: number;
  startedAt: number;
  inputMessageCount: number;
  inputChars: number;
  protocol: string;
  model: string;
  outputChars: number;
  generatedMessages: Message[];
}

const DEFAULT_EVENT_BUFFER_LIMIT = 1_000;

export class ActiveRunError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session ${sessionId} already has an active run.`);
    this.name = "ActiveRunError";
  }
}

export class RunManager {
  readonly tasks = new Map<string, RunTask>();
  readonly activeBySession = new Map<string, string>();

  constructor(
    private readonly appendMessages: AppendRunMessages,
    private readonly generateRun: RunGenerator = generate,
    private readonly eventBufferLimit = DEFAULT_EVENT_BUFFER_LIMIT,
    private readonly observeEvent?: (task: RunTask, event: RunEvent) => void,
  ) {
    if (!Number.isInteger(eventBufferLimit) || eventBufferLimit < 1)
      throw new Error("eventBufferLimit must be a positive integer.");
  }

  startRun(sessionId: string, runInput: RunInput): { runId: string; sessionId: string } {
    if (this.activeBySession.has(sessionId)) throw new ActiveRunError(sessionId);
    const runId = randomUUID();
    const task: RunTask = {
      runId,
      sessionId,
      cwd: runInput.settings.workingDirectory.trim() || process.cwd(),
      status: "running",
      abortController: new AbortController(),
      eventBuffer: [],
      listeners: new Set(),
      listenerCloseHandlers: new Map(),
      lastSeq: 0,
      startedAt: Date.now(),
      inputMessageCount: runInput.messages.filter((message) => message.enabled).length,
      inputChars: runInput.messages.filter((message) => message.enabled).reduce((total, message) => total + message.content.length, 0),
      protocol: runInput.settings.protocol,
      model: runInput.settings.model,
      outputChars: 0,
      generatedMessages: [],
    };
    this.tasks.set(runId, task);
    this.activeBySession.set(sessionId, runId);
    this.publish(task, { type: "run_started", runId, sessionId, cwd: task.cwd, startedAt: task.startedAt });
    // Do not await: once accepted, the run has no dependency on its HTTP request/response.
    void this.execute(task, runInput);
    return { runId, sessionId };
  }

  subscribe(runId: string, res: Response, afterSeq = 0): boolean {
    const task = this.tasks.get(runId);
    if (!task) return false;
    const cursor = Number.isSafeInteger(afterSeq) && afterSeq >= 0 ? afterSeq : 0;
    res.status(200).set({
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    const onClose = () => {
      // A stream is only an observer. Losing it must never cancel the background task.
      task.listeners.delete(res);
      task.listenerCloseHandlers.delete(res);
    };
    res.on("close", onClose);
    task.listenerCloseHandlers.set(res, onClose);
    if (task.status === "running") task.listeners.add(res);
    for (const item of task.eventBuffer) {
      if (item.seq > cursor && !this.write(res, item)) break;
    }
    if (task.status !== "running") this.endListener(task, res);
    return true;
  }

  abortRun(runId: string): boolean {
    const task = this.tasks.get(runId);
    if (!task || task.status !== "running") return false;
    if (!task.abortController.signal.aborted) {
      this.publish(task, { type: "run_aborting", runId, sessionId: task.sessionId });
      task.abortController.abort();
    }
    return true;
  }

  listActive() {
    return [...this.activeBySession.values()].flatMap((runId) => {
      const task = this.tasks.get(runId);
      return task?.status === "running"
        ? [{ runId: task.runId, sessionId: task.sessionId, cwd: task.cwd, startedAt: task.startedAt, status: task.status }]
        : [];
    });
  }

  private async execute(task: RunTask, input: RunInput) {
    let failure: unknown;
    let generationFailed = false;
    try {
      const generated = await this.generateRun(input, (event) => {
        if (event.type === "error") generationFailed = true;
        this.publish(task, event);
      }, task.abortController.signal);
      task.generatedMessages = generated || [];
    } catch (error) {
      failure = error;
      generationFailed = true;
    }

    try {
      await this.appendMessages(task.sessionId, task.generatedMessages);
    } catch (error) {
      failure = error;
      generationFailed = true;
    }

    task.status = task.abortController.signal.aborted
      ? "aborted"
      : generationFailed ? "failed" : "completed";
    if (failure) {
      this.publish(task, {
        type: "error",
        message: failure instanceof Error ? failure.message : String(failure),
      });
    }
    this.publish(task, { type: "run_status", runId: task.runId, sessionId: task.sessionId, status: task.status });
    if (this.activeBySession.get(task.sessionId) === task.runId)
      this.activeBySession.delete(task.sessionId);
    for (const res of [...task.listeners]) this.endListener(task, res);
  }

  private publish(task: RunTask, event: RunEvent) {
    if (event.type === "text" && typeof event.delta === "string") task.outputChars += event.delta.length;
    try { this.observeEvent?.(task, event); } catch { /* Diagnostic observers must never affect the run. */ }
    const item = { seq: ++task.lastSeq, event };
    task.eventBuffer.push(item);
    if (task.eventBuffer.length > this.eventBufferLimit)
      task.eventBuffer.splice(0, task.eventBuffer.length - this.eventBufferLimit);
    for (const res of task.listeners) this.write(res, item);
  }

  private write(res: Response, item: { seq: number; event: RunEvent }) {
    if (res.destroyed || res.writableEnded) return false;
    try {
      res.write(`${JSON.stringify(item)}\n`);
      return true;
    } catch {
      // A write failure is treated exactly like a disconnected observer, not a run failure.
      return false;
    }
  }

  private endListener(task: RunTask, res: Response) {
    task.listeners.delete(res);
    const onClose = task.listenerCloseHandlers.get(res);
    if (onClose) res.off("close", onClose);
    task.listenerCloseHandlers.delete(res);
    if (!res.writableEnded && !res.destroyed) res.end();
  }
}
