import { z } from "zod";
export const roles = [
  "system",
  "developer",
  "user",
  "assistant",
  "tool",
] as const;
export const reasoningEfforts = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningEffort = (typeof reasoningEfforts)[number];
export const toolCallSchema = z.object({
  id: z.string().min(1).max(300),
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  arguments: z.string().max(200_000),
});
const thinkingSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string().max(200_000),
  thinkingSignature: z.string().max(1_000_000).optional(),
  redacted: z.boolean().optional(),
});
export const messageSchema = z.object({
  id: z.string().min(1).max(100),
  role: z.enum(roles),
  content: z.string().max(200_000),
  enabled: z.boolean(),
  toolCalls: z.array(toolCallSchema).max(100).optional(),
  toolCallId: z.string().max(300).optional(),
  toolName: z.string().max(128).optional(),
  isError: z.boolean().optional(),
  providerState: z
    .object({
      api: z.string().max(100),
      provider: z.string().max(100),
      model: z.string().max(200),
      thinking: z.array(thinkingSchema).max(100),
      textSignature: z.string().max(20_000).optional(),
    })
    .optional(),
});
export const settingsSchema = z.object({
  protocol: z.enum([
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "pi-subscription",
  ]),
  baseUrl: z
    .url()
    .refine(
      (value) => ["http:", "https:"].includes(new URL(value).protocol),
      "仅支持 HTTP(S) 地址",
    ),
  model: z.string().trim().min(1).max(200),
  apiKey: z.string().max(4000).optional().default(""),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().min(1).max(128_000),
  // Retain the old switch for v1 imports; an explicit effort takes precedence.
  reasoning: z.boolean().default(false),
  reasoningEffort: z.enum(reasoningEfforts).optional(),
  toolMode: z.enum(["none", "read-only", "agent"]).default("none"),
  workingDirectory: z.string().max(4000).default(""),
  maxTurns: z.number().int().min(1).max(50).default(12),
});
export const runSchema = z.object({
  settings: settingsSchema,
  messages: z.array(messageSchema).min(1).max(500),
});
export const fileSchema = z.object({
  version: z.literal(1),
  title: z.string().max(200),
  settings: settingsSchema.omit({ apiKey: true }),
  messages: z.array(messageSchema).max(500),
});
export type Message = z.infer<typeof messageSchema>;
export type ToolCall = z.infer<typeof toolCallSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export function getReasoningEffort(
  settings: Pick<Settings, "reasoning" | "reasoningEffort">,
): ReasoningEffort {
  return settings.reasoningEffort ?? (settings.reasoning ? "medium" : "off");
}
export const defaults: Settings = {
  protocol: "openai-completions",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4.1-mini",
  apiKey: "",
  temperature: 0.7,
  maxTokens: 2048,
  reasoning: false,
  reasoningEffort: undefined,
  toolMode: "none",
  workingDirectory: "",
  maxTurns: 12,
};
export const initialMessages: Message[] = [
  {
    id: "initial-system",
    role: "system",
    enabled: true,
    content: "You are a helpful assistant. Be clear, precise, and thoughtful.",
  },
  {
    id: "initial-user",
    role: "user",
    enabled: true,
    content: "用一个简短的例子，解释什么是大语言模型的上下文。",
  },
];
