import { z } from "zod";

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const httpUrlSchema = z.string().url().max(2_000).refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "Source URLs must use HTTP or HTTPS");
const jobTypeSchema = z.enum(["source_refresh", "player_research", "rankings_research", "sleepers_research"]);
const scoringFormatSchema = z.enum(["ppr", "half_ppr", "standard"]);
const rankingTypeSchema = z.enum(["redraft", "weekly", "rest_of_season", "dynasty", "rookie"]);
const positionSchema = z.enum(["ALL", "QB", "RB", "WR", "TE", "K", "DST"]);
const leagueSizeSchema = z.union([
  z.literal(8), z.literal(10), z.literal(12), z.literal(14), z.literal(16),
]);

const commonMultiLabelPublicSuffixes = new Set([
  "ac.uk", "co.uk", "gov.uk", "me.uk", "net.uk", "org.uk",
  "asn.au", "com.au", "edu.au", "gov.au", "net.au", "org.au",
  "ac.nz", "co.nz", "govt.nz", "net.nz", "org.nz",
  "co.in", "firm.in", "gen.in", "ind.in", "net.in", "org.in",
  "co.jp", "ne.jp", "or.jp", "co.kr", "ne.kr", "or.kr",
  "com.br", "net.br", "org.br", "com.cn", "net.cn", "org.cn",
  "com.mx", "com.sg", "com.tw", "co.za", "com.ar",
]);

function canonicalPublisherDomain(value: string) {
  const hostname = new URL(value).hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  const labels = hostname.split(".").filter(Boolean);
  if (labels.length <= 2 || /^\d+(?:\.\d+){3}$/.test(hostname) || hostname.includes(":")) return hostname;
  const finalTwo = labels.slice(-2).join(".");
  return commonMultiLabelPublicSuffixes.has(finalTwo) ? labels.slice(-3).join(".") : finalTwo;
}

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
  leagueSize: leagueSizeSchema.optional().default(12),
  sleepersPerPosition: z.number().int().min(1).max(20).optional(),
  discoverNewSources: z.boolean().optional(),
  knownSourceDomains: z.array(z.string().trim().toLowerCase().min(1).max(253)
    .regex(/^[a-z0-9.-]+$/)).max(40).optional(),
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

const rankingSnapshotSchema = z.object({
  sourceUrl: z.string().url().max(2_000).nullable(),
  title: boundedText(140),
  scoringFormat: scoringFormatSchema,
  rankingType: rankingTypeSchema,
  season: z.string().regex(/^20\d{2}$/),
  week: z.number().int().min(1).max(25).nullable(),
  leagueSize: leagueSizeSchema.optional(),
  summary: z.string().trim().max(1_500).nullable(),
  methodology: z.string().trim().max(2_000).nullable(),
  entries: z.array(rankingEntrySchema).min(1).max(500),
}).strict();

const sourcedRankingSnapshotSchema = rankingSnapshotSchema.extend({
  sourceName: boundedText(100),
  sourceUrl: httpUrlSchema,
}).strict();

const sleeperSourceSchema = z.object({
  publisher: boundedText(120),
  title: boundedText(300),
  url: httpUrlSchema,
  publishedAt: z.string().datetime({ offset: true }).nullable(),
  recommendation: boundedText(1_200).nullable(),
}).strict();

const sleeperCandidateSchema = z.object({
  playerName: boundedText(120),
  position: z.enum(["QB", "RB", "WR", "TE"]),
  team: z.string().trim().toUpperCase().min(2).max(5).nullable(),
  recommendedPickStart: z.number().int().min(1).max(500),
  recommendedPickEnd: z.number().int().min(1).max(500),
  summary: boundedText(1_500),
  upside: boundedText(1_200).nullable(),
  risk: boundedText(1_200).nullable(),
  sources: z.array(sleeperSourceSchema).min(1).max(12),
}).strict().refine(
  (candidate) => candidate.recommendedPickStart <= candidate.recommendedPickEnd,
  { path: ["recommendedPickEnd"], message: "Recommended pick ranges must be ordered" },
);

const sleeperReportSchema = z.object({
  summary: boundedText(5_000),
  positionSummaries: z.object({
    QB: boundedText(1_500),
    RB: boundedText(1_500),
    WR: boundedText(1_500),
    TE: boundedText(1_500),
  }).strict(),
  candidates: z.array(sleeperCandidateSchema).min(4).max(80),
}).strict().superRefine((report, context) => {
  const positions = new Set(report.candidates.map((candidate) => candidate.position));
  for (const position of ["QB", "RB", "WR", "TE"] as const) {
    if (!positions.has(position)) {
      context.addIssue({ code: "custom", path: ["candidates"], message: `At least one ${position} is required` });
    }
  }
});

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
  rankingSnapshot: rankingSnapshotSchema.nullable(),
  // A general rankings job returns the published boards separately so the app can
  // preserve source provenance and calculate its own aggregate. Three to five
  // sources bounds both research cost and result size.
  rankingSnapshots: z.array(sourcedRankingSnapshotSchema).min(3).max(5).nullable().optional(),
  sleeperReport: sleeperReportSchema.nullable().optional(),
}).strict().superRefine((result, context) => {
  const snapshots = [
    ...(result.rankingSnapshot ? [{ path: "rankingSnapshot", snapshot: result.rankingSnapshot }] : []),
    ...(result.rankingSnapshots ?? []).map((snapshot, index) => ({ path: `rankingSnapshots.${index}`, snapshot })),
  ];
  for (const { path, snapshot } of snapshots) {
    const ranks = snapshot.entries.map((entry) => entry.rank);
    const sorted = [...ranks].sort((left, right) => left - right);
    if (new Set(ranks).size !== ranks.length || sorted.some((rank, index) => rank !== index + 1)) {
      context.addIssue({ code: "custom", path: [...path.split("."), "entries"], message: "Ranks must be unique and contiguous from 1" });
    }
  }
  const sources = result.rankingSnapshots ?? [];
  const sourceNames = sources.map((snapshot) => snapshot.sourceName.trim().toLowerCase());
  const sourceHosts = sources.map((snapshot) => canonicalPublisherDomain(snapshot.sourceUrl));
  if (new Set(sourceNames).size !== sourceNames.length || new Set(sourceHosts).size !== sourceHosts.length) {
    context.addIssue({ code: "custom", path: ["rankingSnapshots"], message: "Ranking research sources must use distinct publishers and source URLs" });
  }
});

export type ResearchJob = z.infer<typeof researchJobSchema>;
export type ResearchResult = z.infer<typeof researchResultSchema>;
