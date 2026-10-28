import { z } from "zod";
export const gptSessionStatus = ["starting", "running", "idle", "waiting_input", "interrupted", "suspended", "closed", "error"] as const;
export const gptSessionSummarySchema = z.object({
  id: z.string(), name: z.string(), role: z.string().max(80).optional(), rolePreset: z.enum(["scout", "experimenter", "implementer"]).optional(), status: z.enum(gptSessionStatus), model: z.string(), updatedAt: z.number(),
  replySequence: z.number().int().nonnegative().optional(), hasUnreadReply: z.boolean(), pendingQuestionCount: z.number().int().nonnegative(),
  recentTools: z.array(z.object({ name: z.string(), status: z.enum(["running", "completed", "error"]), at: z.number() })),
  lastReplyPreview: z.string().max(300),
});
export type GptSessionSummary = z.infer<typeof gptSessionSummarySchema>;
