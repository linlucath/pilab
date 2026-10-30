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
  thoughtSignature: z.string().max(1_000_000).optional(),
});
const thinkingSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string().max(200_000),
  thinkingSignature: z.string().max(1_000_000).optional(),
  redacted: z.boolean().optional(),
});
export const MAX_MESSAGE_IMAGES = 8;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_MESSAGE_IMAGE_BYTES = 40 * 1024 * 1024;
export const imageReferenceSchema = z.object({
  file: z.string().regex(/^(files|previews)\/[a-f0-9]{64}\.(png|jpg|webp|gif|bmp)$/),
  id: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  name: z.string().max(100), collection: z.string().max(100).optional(),
  kind: z.enum(["image", "overview"]),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"]),
  width: z.number().int().positive(), height: z.number().int().positive(),
  size: z.number().int().positive().max(MAX_IMAGE_BYTES).optional(),
});
const messageImagesSchema = z.array(imageReferenceSchema).max(MAX_MESSAGE_IMAGES).superRefine((images, context) => {
  const knownBytes = images.reduce((total, image) => total + (image.size || 0), 0);
  if (knownBytes > MAX_MESSAGE_IMAGE_BYTES)
    context.addIssue({ code: "custom", message: `单条消息图片总大小不能超过 ${MAX_MESSAGE_IMAGE_BYTES / (1024 * 1024)} MiB。` });
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
  compactedByModel: z.boolean().optional(),
  modelSummary: z.string().optional(),
  gptReply: z.object({
    session: z.string().regex(/^gpt-[a-f0-9-]+$/),
    sequence: z.number().int().nonnegative(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  }).optional(),
  images: messageImagesSchema.optional(),
  providerState: z
    .object({
      api: z.string().max(100),
      provider: z.string().max(100),
      model: z.string().max(200),
      thinking: z.array(thinkingSchema).max(100),
      // Gemini/Argon may attach large opaque thought signatures to text blocks.
      textSignature: z.string().max(1_000_000).optional(),
      stopReason: z.enum(["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"]).optional(),
      rawStopReason: z.string().max(200).optional(),
      errorMessage: z.string().max(12_000).optional(),
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
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
  model: "gemini-3.8-flash",
  apiKey: "",
  temperature: 0.7,
  maxTokens: 16384,
  reasoning: false,
  reasoningEffort: "low",
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
