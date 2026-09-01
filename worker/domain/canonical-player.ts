import type { NewPlayer } from "../db/schema";
import type { SleeperPlayer } from "../providers/sleeper/types";

export type CanonicalPlayerInput = Omit<NewPlayer, "id" | "createdAt" | "updatedAt">;

function toInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

export function normalizePlayerSearchName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function canonicalizeSleeperPlayer(
  externalId: string,
  sleeperPlayer?: SleeperPlayer,
): CanonicalPlayerInput {
  const teamDefense =
    /^[A-Z]{2,3}$/.test(externalId) ||
    sleeperPlayer?.position === "DEF" ||
    sleeperPlayer?.position === "DST";
  const firstName = sleeperPlayer?.first_name?.trim() || null;
  const lastName = sleeperPlayer?.last_name?.trim() || null;
  const nflTeam = sleeperPlayer?.team?.trim() || (teamDefense ? externalId : null);
  const fallbackName = teamDefense ? `${nflTeam ?? externalId} D/ST` : `Sleeper player ${externalId}`;
  const fullName =
    sleeperPlayer?.full_name?.trim() ||
    [firstName, lastName].filter(Boolean).join(" ") ||
    fallbackName;
  const newsTimestamp = toInteger(sleeperPlayer?.news_updated);

  return {
    sport: sleeperPlayer?.sport || "nfl",
    firstName,
    lastName,
    fullName,
    searchName: normalizePlayerSearchName(sleeperPlayer?.search_full_name || fullName),
    position: sleeperPlayer?.position || (teamDefense ? "DEF" : null),
    fantasyPositionsJson: JSON.stringify(
      sleeperPlayer?.fantasy_positions?.length
        ? sleeperPlayer.fantasy_positions
        : teamDefense
          ? ["DEF"]
          : [],
    ),
    nflTeam,
    number: toInteger(sleeperPlayer?.number),
    status: sleeperPlayer?.status || null,
    injuryStatus: sleeperPlayer?.injury_status || null,
    injuryBodyPart: sleeperPlayer?.injury_body_part || null,
    injuryNotes: sleeperPlayer?.injury_notes || null,
    age: toInteger(sleeperPlayer?.age),
    height: sleeperPlayer?.height || null,
    weight: sleeperPlayer?.weight ? String(sleeperPlayer.weight) : null,
    college: sleeperPlayer?.college || null,
    yearsExperience: toInteger(sleeperPlayer?.years_exp),
    depthChartPosition: sleeperPlayer?.depth_chart_position
      ? String(sleeperPlayer.depth_chart_position)
      : null,
    depthChartOrder: toInteger(sleeperPlayer?.depth_chart_order),
    isTeamDefense: teamDefense,
    newsUpdatedAt: newsTimestamp ? new Date(newsTimestamp) : null,
  };
}

export function sleeperExternalMetadata(player?: SleeperPlayer): string {
  if (!player) return "{}";

  return JSON.stringify({
    espnId: player.espn_id ?? null,
    yahooId: player.yahoo_id ?? null,
    fantasyDataId: player.fantasy_data_id ?? null,
    sportradarId: player.sportradar_id ?? null,
  });
}
