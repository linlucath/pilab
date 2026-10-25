import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type Attachment = { name?: string; path?: string };
type TestResult = { status?: string; expectedStatus?: string; error?: { message?: string; stack?: string } | string; errors?: { message?: string }[]; attachments?: Attachment[] };
type Spec = { title?: string; ok?: boolean; tests?: { expectedStatus?: string; results?: TestResult[] }[]; specs?: Spec[]; suites?: Suite[] };
type Suite = { title?: string; specs?: Spec[]; suites?: Suite[] };
type BehaviorResult = { id: string; title: string; states: string[]; error?: string; screenshots: string[] };

const root = process.cwd();
const outputDir = path.join(root, "artifacts", "patrol");
await mkdir(outputDir, { recursive: true });
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const behaviorArg = args.find((arg) => !arg.startsWith("-"));
const testArgs = behaviorArg
  ? [...args.filter((arg) => arg !== behaviorArg), "--grep", behaviorArg]
  : args;
const child = spawn(process.execPath, [path.join(root, "node_modules/@playwright/test/cli.js"), "test", ...testArgs, "--reporter=json"], {
  cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
const exitCode = await new Promise<number>((resolve) => child.once("close", (code) => resolve(code ?? 1)));

function parseReport(value: string) {
  const start = value.indexOf("{");
  if (start < 0) return undefined;
  try { return JSON.parse(value.slice(start)); } catch { return undefined; }
}
function clean(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
function short(value: string) { return Array.from(value).slice(0, 400).join(""); }
function isScreenshot(attachment: Attachment) { return /screenshot/i.test(attachment.name || "") || /\.png$/i.test(attachment.path || ""); }
function collectSuites(suites: Suite[], parents: string[], results: BehaviorResult[]) {
  for (const suite of suites || []) {
    const title = suite.title ? [...parents, suite.title] : parents;
    for (const nested of suite.suites || []) collectSuites([nested], title, results);
    for (const spec of suite.specs || []) {
      const fullTitle = [...title, spec.title || ""].filter(Boolean).join(" ");
      const id = /(?:^|\s)([A-Z][A-Z0-9]*-\d+)\b/.exec(fullTitle)?.[1] || "NO-ID";
      const tests = spec.tests || [];
      const states: string[] = [];
      const errors: string[] = [];
      const screenshots = new Set<string>();
      for (const test of tests) {
        const result = test.results?.at(-1);
        states.push(result?.status || (spec.ok ? "passed" : test.expectedStatus === "skipped" ? "skipped" : "failed"));
        const messages = [
          typeof result?.error === "string" ? result.error : result?.error?.message,
          ...(result?.errors || []).map((error) => error.message),
        ].map(clean).filter(Boolean);
        errors.push(...messages);
        for (const attachment of result?.attachments || []) if (isScreenshot(attachment) && attachment.path)
          screenshots.add(path.relative(root, attachment.path).split(path.sep).join("/"));
      }
      if (!states.length) states.push(spec.ok ? "passed" : "failed");
      results.push({ id, title: fullTitle, states, ...(errors[0] ? { error: short(errors[0]) } : {}), screenshots: [...screenshots] });
    }
  }
}

const parsed = parseReport(stdout);
const results: BehaviorResult[] = [];
if (parsed?.suites) collectSuites(parsed.suites, [], results);
const grouped = new Map<string, BehaviorResult>();
for (const result of results) {
  const existing = grouped.get(result.id);
  if (!existing) grouped.set(result.id, { ...result });
  else {
    existing.states.push(...result.states);
    if (!existing.error && result.error) existing.error = result.error;
    existing.screenshots.push(...result.screenshots.filter((item) => !existing.screenshots.includes(item)));
    existing.title += `; ${result.title}`;
  }
}
const behaviors = [...grouped.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
const passed = behaviors.filter((item) => item.states.every((state) => state === "passed")).length;
const failed = behaviors.filter((item) => item.states.some((state) => ["failed", "timedOut", "interrupted", "unexpected"].includes(state))).length;
const skipped = behaviors.filter((item) => item.states.every((state) => state === "skipped")).length;

const specsPath = path.join(root, "specs", "behaviors.md");
let specBehaviors: { id: string; title: string }[] = [];
let specsPresent = false;
try {
  const source = await readFile(specsPath, "utf8");
  specsPresent = true;
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const heading = /^###\s+([A-Z][A-Z0-9]*-\d+)\s+(.+?)\s*$/.exec(lines[i]);
    if (!heading) continue;
    const metadata = /^优先级:\s*\S+\s*·\s*可测性:\s*(\S+)\s*·\s*状态:\s*.+$/.exec(lines[i + 1] || "");
    if (metadata?.[1] === "mock") specBehaviors.push({ id: heading[1], title: heading[2] });
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const coveredIds = new Set(behaviors.filter((item) => item.id !== "NO-ID").map((item) => item.id));
const gaps = specBehaviors.filter((item) => !coveredIds.has(item.id));
const date = new Date().toISOString();
const lines = [
  "# Pi Lab E2E Patrol Report",
  "",
  `- Generated: ${date}`,
  `- Result: ${passed} passed · ${failed} failed · ${skipped} skipped · ${gaps.length} mock coverage gaps`,
  behaviorArg ? `- Filter: \`${behaviorArg}\`` : "- Filter: all E2E tests",
  "",
  "## Behavior results",
  "",
  "| ID | Result | Behavior / test | Failure evidence | Screenshot |",
  "| --- | --- | --- | --- | --- |",
];
if (!behaviors.length) lines.push(`| — | ${exitCode === 0 ? "passed" : "failed"} | No behavior tests were reported | ${short(stderr || stdout || "No Playwright JSON report was produced.")} | — |`);
for (const item of behaviors) {
  const state = item.states.every((value) => value === "passed") ? "PASS" : item.states.every((value) => value === "skipped") ? "SKIP" : "FAIL";
  lines.push(`| ${item.id} | ${state} | ${item.title.replaceAll("|", "\\|")} | ${state === "FAIL" ? (item.error || "Failure details unavailable").replaceAll("|", "\\|") : "—"} | ${item.screenshots.length ? item.screenshots.join("<br>") : "—"} |`);
}
lines.push("", "## Mock coverage gaps", "");
if (!specsPresent) lines.push("`specs/behaviors.md` was not present; coverage gaps were not evaluated.");
else if (!gaps.length) lines.push("No uncovered mock-testable behaviors found.");
else for (const gap of gaps) lines.push(`- ${gap.id} ${gap.title}`);
lines.push("", "## Notes", "", "- Failure messages are truncated to at most 400 characters per behavior.", "- Failure screenshots and traces are retained under `artifacts/playwright/`.", "");
await writeFile(path.join(outputDir, "report.md"), lines.join("\n"), "utf8");
console.log(`Patrol: ${passed} passed · ${failed} failed · ${skipped} skipped · ${gaps.length} gaps; report: artifacts/patrol/report.md`);
if (exitCode !== 0 || failed > 0) process.exitCode = 1;
