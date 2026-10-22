// Explicit opt-in smoke test. Uses the local Pi subscription and its usage allowance.
import { generate } from "../server/engine";
import { piStatus } from "../server/pi-subscription";
import { defaults, type Message } from "../shared/schema";
if (!process.argv.includes("--live"))
  throw new Error("Pass --live to use the real Pi subscription.");
const status = await piStatus();
if (!status.connected || !status.defaultModel)
  throw new Error("Pi subscription is not logged in.");
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 90_000);
const started = Date.now();
let output = "";
let request: unknown;
let usage: unknown;
let failure: unknown;
const messages: Message[] = [
  {
    id: "1",
    role: "system",
    content: "This is a small integration test of a message editing tool.",
    enabled: true,
  },
  {
    id: "2",
    role: "developer",
    content:
      "For the final response, output exactly PI_SUBSCRIPTION_OK and nothing else.",
    enabled: true,
  },
  {
    id: "3",
    role: "user",
    content: "This message was edited before sending.",
    enabled: true,
  },
  {
    id: "4",
    role: "assistant",
    content: "Historical assistant text, manually inserted by the editor.",
    enabled: true,
  },
  {
    id: "5",
    role: "user",
    content: "Please complete the integration test now.",
    enabled: true,
  },
];
try {
  await generate(
    {
      settings: {
        ...defaults,
        protocol: "pi-subscription",
        model: status.defaultModel,
        reasoning: false,
      },
      messages,
    },
    (e) => {
      if (e.type === "request") request = e.payload;
      if (e.type === "text") output += e.delta;
      if (e.type === "done") usage = e.usage;
      if (e.type === "error") failure = e.message;
    },
    controller.signal,
  );
  console.log(
    JSON.stringify(
      {
        provider: status.provider,
        model: status.defaultModel,
        output,
        usage,
        elapsedMs: Date.now() - started,
        failure,
        request,
      },
      null,
      2,
    ),
  );
  if (failure || !output.includes("PI_SUBSCRIPTION_OK")) process.exitCode = 1;
} finally {
  clearTimeout(timeout);
}
