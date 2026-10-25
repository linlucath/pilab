import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface RpcTransport {
  request<T = any>(type: string, fields?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  reply(fields: Record<string, unknown>): Promise<void>;
  stop(): Promise<void>;
}

export interface RpcProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  onEvent(event: Record<string, any>): void;
  onExit(error?: Error): void;
}

/** One long-lived native Pi process. Commands finish on acceptance, not on model completion. */
export class PiRpcProcess implements RpcTransport {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, {
    resolve(value: any): void;
    reject(error: Error): void;
    timeout: NodeJS.Timeout;
  }>();
  private buffer = "";
  private stderr = "";
  private failure?: Error;
  private stopping = false;
  private stopped?: Promise<void>;
  private closed: Promise<void>;

  constructor(private options: RpcProcessOptions) {
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.closed = new Promise((resolve) => {
      this.child.once("close", (code, signal) => {
        this.fail(new Error(`Pi process exited (${signal || code}). ${this.stderr}`));
        options.onExit(this.stopping ? undefined : this.failure);
        resolve();
      });
    });
    this.child.once("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-16_000);
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
  }

  private fail(error: Error) {
    this.failure ||= error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(this.failure);
    }
    this.pending.clear();
  }

  private consume(chunk: string) {
    this.buffer += chunk;
    // JSON strings may contain U+2028/U+2029. Only LF is a protocol boundary.
    let boundary: number;
    while ((boundary = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, boundary).replace(/\r$/, "");
      this.buffer = this.buffer.slice(boundary + 1);
      if (!line.trim()) continue;
      if (line.length > 32_000_000) {
        this.fail(new Error("Pi emitted an oversized RPC record."));
        void this.stop();
        return;
      }
      let event: Record<string, any>;
      try {
        event = JSON.parse(line);
      } catch {
        this.stderr = (this.stderr + line).slice(-16_000);
        continue;
      }
      if (event.type === "response" && this.pending.has(event.id)) {
        const pending = this.pending.get(event.id)!;
        this.pending.delete(event.id);
        clearTimeout(pending.timeout);
        if (event.success) pending.resolve(event.data);
        else pending.reject(new Error(event.error || `Pi rejected ${event.command}.`));
      } else this.options.onEvent(event);
    }
    if (this.buffer.length > 32_000_000) {
      this.fail(new Error("Pi emitted an oversized RPC record."));
      void this.stop();
    }
  }

  private write(record: Record<string, unknown>) {
    return new Promise<void>((resolve, reject) => {
      if (this.failure) return reject(this.failure);
      if (this.stopping) return reject(new Error("Pi process is closing."));
      this.child.stdin.write(`${JSON.stringify(record)}\n`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async request<T = any>(type: string, fields: Record<string, unknown> = {}, timeoutMs = this.options.requestTimeoutMs ?? 45_000): Promise<T> {
    if (this.failure) throw this.failure;
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi did not acknowledge ${type} within the RPC deadline.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      void this.write({ ...fields, type, id }).catch((error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(timeout);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  reply(fields: Record<string, unknown>) {
    return this.write({ ...fields, type: "extension_ui_response" });
  }

  stop(): Promise<void> {
    return (this.stopped ||= this.stopProcess());
  }

  private async stopProcess() {
    this.stopping = true;
    this.fail(new Error("Pi process closed."));
    // EOF lets Pi abort work, kill its tracked shell children, and flush the session.
    this.child.stdin.end();
    const term = setTimeout(() => this.child.kill("SIGTERM"), 3_000);
    const kill = setTimeout(() => this.child.kill("SIGKILL"), 6_000);
    try {
      await this.closed;
    } finally {
      clearTimeout(term);
      clearTimeout(kill);
    }
  }
}
