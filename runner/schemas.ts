import { z } from "zod";

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const jobTypeSchema = z.enum(["source_refresh", "player_research", "rankings_research"]);
const scoringFormatSchema = z.enum(["ppr", "half_ppr", "standard"]);
const rankingTypeSchema = z.enum(["redraft", "weekly", "rest_of_season", "dynasty", "rookie"]);
const positionSchema = z.enum(["ALL", "QB", "RB", "WR", "TE", "K", "DST"]);

export const researchJobInputSchema = z.object({
  type: jobTypeSchema,
  subject: boundedText(200).optional(),
  sourceName: boundedText(200).optional(),
  scoringFormat: scoringFormatSchema,
  rankingType: rankingTypeSchema,
  position: positionSchema,
  season: z.string().regex(/^20\d{2}$/).optional(),
  week: z.number().int().min(1).max(25).optional(),
  rankingLimit: z.number().int().min(1).max(500).optional(),
}).strict();

export const researchJobSchema = z.object({
  id: boundedText(120),
  type: jobTypeSchema,
  input: researchJobInputSchema,
  attempt: z.number().int().min(1).max(10),
  maxAttempts: z.number().int().min(1).max(10),
  leaseToken: z.string().uuid(),
  leaseExpiresAt: z.string().datetime({ offset: true }),
  executionContext: boundedText(2_000),
}).strict();

const rankingEntrySchema = z.object({
  playerName: boundedText(120),
  position: z.string().trim().toUpperCase().max(10).nullable(),
  team: z.string().trim().toUpperCase().max(5).nullable(),
  rank: z.number().int().positive().max(500),
  previousRank: z.number().int().positive().max(500).nullable(),
  tier: z.number().int().positive().max(100).nullable(),
  insight: z.string().trim().max(600).nullable(),
}).strict();

export const researchResultSchema = z.object({
  summary: boundedText(5_000),
  generatedAt: z.string().datetime({ offset: true }),
  citations: z.array(z.object({
    title: boundedText(300),
    url: z.string().url().max(2_000),
    publisher: z.string().trim().max(120).nullable(),
    publishedAt: z.string().datetime({ offset: true }).nullable(),
    accessedAt: z.string().datetime({ offset: true }).nullable(),
  }).strict()).max(50),
  insights: z.array(z.object({
    subject: boundedText(160),
    finding: boundedText(1_200),
    confidence: z.enum(["low", "medium", "high"]).nullable(),
    citationUrls: z.array(z.string().url().max(2_000)).max(10),
  }).strict()).max(100),
  rankingSnapshot: z.object({
    sourceUrl: z.string().url().max(2_000).nullable(),
    title: boundedText(140),
    scoringFormat: scoringFormatSchema,
    rankingType: rankingTypeSchema,
    season: z.string().regex(/^20\d{2}$/),
    week: z.number().int().min(1).max(25).nullable(),
    summary: z.string().trim().max(1_500).nullable(),
    methodology: z.string().trim().max(2_000).nullable(),
    entries: z.array(rankingEntrySchema).min(1).max(500),
  }).strict().nullable(),
}).strict().superRefine((result, context) => {
  const ranks = result.rankingSnapshot?.entries.map((entry) => entry.rank);
  if (!ranks) return;
  const sorted = [...ranks].sort((left, right) => left - right);
  if (new Set(ranks).size !== ranks.length || sorted.some((rank, index) => rank !== index + 1)) {
    context.addIssue({ code: "custom", path: ["rankingSnapshot", "entries"], message: "Ranks must be unique and contiguous from 1" });
  }
});

export type ResearchJob = z.infer<typeof researchJobSchema>;
export type ResearchResult = z.infer<typeof researchResultSchema>;
