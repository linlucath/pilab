import { createHash } from "node:crypto";
import { openSync, closeSync, writeSync, readFileSync, unlinkSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const firstPort = 3100;
const portCount = 10_000;

function available(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

function lockFor(port) {
  return path.join(os.tmpdir(), `pilab-e2e-port-${port}.lock`);
}

async function claim(port) {
  const lock = lockFor(port);
  let fd;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      try {
        const ownerText = readFileSync(lock, "utf8").trim();
        if (!ownerText) return false;
        const owner = Number(ownerText);
        if (Number.isInteger(owner) && owner > 0) {
          try { process.kill(owner, 0); return false; }
          catch (ownerError) { if (ownerError?.code !== "ESRCH") return false; }
        }
        unlinkSync(lock);
        return claim(port);
      } catch { return false; }
    }
    throw error;
  }
  try {
    writeSync(fd, String(process.pid));
  } finally { closeSync(fd); }
  if (!(await available(port))) {
    try { unlinkSync(lock); } catch { /* Best effort release. */ }
    return false;
  }
  process.once("exit", () => {
    try { unlinkSync(lock); } catch { /* Process may have already removed the stale lock. */ }
  });
  return true;
}

export async function selectE2ePort() {
  const configured = process.env.PI_LAB_E2E_PORT;
  if (configured !== undefined && configured !== "") {
    const port = Number(configured);
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw new Error(`PI_LAB_E2E_PORT must be an integer between 1024 and 65535; got ${configured}`);
    // Playwright re-evaluates the config in worker processes; the selecting parent owns the port lock.
    if (process.env.PI_LAB_E2E_PORT_RESOLVED === "1") return port;
    if (!(await claim(port))) throw new Error(`PI_LAB_E2E_PORT ${port} is already claimed or in use`);
    process.env.PI_LAB_E2E_PORT = String(port);
    process.env.PI_LAB_E2E_PORT_RESOLVED = "1";
    return port;
  }
  const digest = createHash("sha256").update(projectRoot).digest();
  const offset = digest.readUInt32BE(0) % portCount;
  for (let attempt = 0; attempt < portCount; attempt++) {
    const port = firstPort + ((offset + attempt) % portCount);
    if (await claim(port)) {
      process.env.PI_LAB_E2E_PORT = String(port);
      process.env.PI_LAB_E2E_PORT_RESOLVED = "1";
      return port;
    }
  }
  throw new Error("No free E2E port found in the 3100–13099 range; set PI_LAB_E2E_PORT explicitly");
}

export function e2eOrigin(port = process.env.PI_LAB_E2E_PORT || "3100") {
  return `http://127.0.0.1:${port}`;
}
