import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type LogLevel = "info" | "warn" | "error";
export type LogCategory = "server" | "run" | "gpt" | "client";
export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  category: LogCategory;
  event: string;
  message: string;
  data: Record<string, unknown>;
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILE_ENTRIES = 1000;
const MAX_MEMORY_ENTRIES = 500;
const MAX_DATA_BYTES = 48 * 1024;
const logDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".pi-lab",
  "logs",
);
const logFile = path.join(logDirectory, "pilab.jsonl");
const memory: LogEntry[] = [];

function parseEntry(line: string): LogEntry | undefined {
  try {
    const entry = JSON.parse(line) as LogEntry;
    if (
      typeof entry.id === "string" &&
      typeof entry.timestamp === "string" &&
      (entry.level === "info" || entry.level === "warn" || entry.level === "error") &&
      (entry.category === "server" || entry.category === "run" || entry.category === "gpt" || entry.category === "client") &&
      typeof entry.event === "string" &&
      typeof entry.message === "string" &&
      entry.data !== null && typeof entry.data === "object" && !Array.isArray(entry.data)
    ) return entry;
  } catch { /* Ignore an incomplete or malformed final line. */ }
  return undefined;
}

function readRecentEntries(maxEntries: number): LogEntry[] {
  if (!existsSync(logFile)) return [];
  try {
    return readFileSync(logFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-maxEntries)
      .map(parseEntry)
      .filter((entry): entry is LogEntry => !!entry);
  } catch { return []; }
}

function trimFileIfNeeded() {
  try {
    if (!existsSync(logFile) || statSync(logFile).size <= MAX_FILE_BYTES) return;
    const lines = readRecentEntries(MAX_FILE_ENTRIES).map((entry) => JSON.stringify(entry));
    let bytes = lines.reduce((total, line) => total + Buffer.byteLength(line, "utf8") + 1, 0);
    while (bytes > MAX_FILE_BYTES && lines.length) {
      bytes -= Buffer.byteLength(lines.shift()!, "utf8") + 1;
    }
    writeFileSync(logFile, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
  } catch { /* Logging must not take down the server if the disk is unavailable. */ }
}

try {
  mkdirSync(logDirectory, { recursive: true });
  trimFileIfNeeded();
  memory.push(...readRecentEntries(MAX_MEMORY_ENTRIES));
} catch { /* The in-memory logger remains usable if initialization fails. */ }

function normalizeData(data: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!data) return {};
  try {
    const serialized = JSON.stringify(data);
    if (serialized === undefined) return {};
    if (Buffer.byteLength(serialized, "utf8") <= MAX_DATA_BYTES)
      return JSON.parse(serialized) as Record<string, unknown>;
    return {
      truncated: true,
      preview: serialized.slice(0, 12_000),
      originalBytes: Buffer.byteLength(serialized, "utf8"),
    };
  } catch {
    return { serializationError: "Log data could not be serialized." };
  }
}

function pushMemory(entry: LogEntry) {
  memory.push(entry);
  if (memory.length > MAX_MEMORY_ENTRIES)
    memory.splice(0, memory.length - MAX_MEMORY_ENTRIES);
}

export function logEvent(
  category: LogCategory,
  level: LogLevel,
  event: string,
  message: string,
  data?: Record<string, unknown>,
): LogEntry {
  const entry: LogEntry = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    level,
    category,
    event: String(event).slice(0, 200),
    message: String(message).slice(0, 4000),
    data: normalizeData(data),
  };
  pushMemory(entry);
  try {
    mkdirSync(logDirectory, { recursive: true });
    appendFileSync(logFile, `${JSON.stringify(entry)}\n`, "utf8");
    trimFileIfNeeded();
  } catch { /* Keep the ring buffer available even if persistent storage fails. */ }
  return entry;
}

export function queryLogs(options: {
  category?: LogCategory;
  limit?: number;
  search?: string;
} = {}): LogEntry[] {
  const limit = Number.isFinite(options.limit)
    ? Math.max(0, Math.min(MAX_MEMORY_ENTRIES, Math.floor(options.limit!)))
    : 200;
  const search = options.search?.toLocaleLowerCase();
  const matching = memory.filter((entry) => {
    if (options.category && entry.category !== options.category) return false;
    if (search && !JSON.stringify(entry).toLocaleLowerCase().includes(search)) return false;
    return true;
  });
  return limit === 0 ? [] : matching.slice(-limit).reverse();
}

export function clearLogs(): void {
  memory.length = 0;
  try {
    mkdirSync(logDirectory, { recursive: true });
    writeFileSync(logFile, "", "utf8");
  } catch { /* Preserve the in-memory clear even if the disk is unavailable. */ }
}
