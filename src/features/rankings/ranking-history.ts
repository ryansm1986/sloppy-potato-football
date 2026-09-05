import type { AgentRankingSnapshot } from "./agent-api";
import type { ResearchRunOption } from "./ResearchRunHistory";

export type RankingResearchRun = ResearchRunOption & { snapshots: AgentRankingSnapshot[] };

export function groupRankingRuns(snapshots: AgentRankingSnapshot[]): RankingResearchRun[] {
  const grouped = new Map<string, AgentRankingSnapshot[]>();
  for (const snapshot of snapshots) {
    const id = snapshot.researchJobId ?? snapshot.id;
    grouped.set(id, [...(grouped.get(id) ?? []), snapshot]);
  }
  return [...grouped].map(([id, members]) => {
    const sorted = [...members].sort((a, b) => Date.parse(b.savedAt ?? b.createdAt ?? b.generatedAt) - Date.parse(a.savedAt ?? a.createdAt ?? a.generatedAt));
    const first = sorted[0];
    const playerCount = new Set(members.flatMap((snapshot) => snapshot.entries.map((entry) => entry.playerId ?? entry.playerName.toLowerCase()))).size;
    const sources = new Set(members.map((snapshot) => snapshot.source.canonicalKey)).size;
    return {
      id,
      researchJobId: first.researchJobId,
      generatedAt: first.savedAt ?? first.createdAt ?? first.generatedAt,
      title: `${first.season} ${first.scoringFormat.toUpperCase()} · ${first.positionScope ?? "ALL"} · ${first.leagueSize ?? 12} teams`,
      detail: `${sources} source${sources === 1 ? "" : "s"} · ${playerCount} players`,
      snapshots: sorted,
    };
  }).sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt) || b.id.localeCompare(a.id));
}
