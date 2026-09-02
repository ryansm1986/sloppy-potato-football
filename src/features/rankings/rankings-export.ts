import type { Workbook, Worksheet } from "exceljs";
import type { LeagueSize } from "../league-size";
import type { AgentRankingSnapshot } from "./agent-api";
import {
  aggregateRankingSnapshots,
  isSnapshotInScope,
  selectLatestSnapshotPerSource,
} from "./ranking-aggregate";
import { derivePositionRanks } from "./ranking-position";
import type { RankingPlayer } from "./ranking-store";

export type RankingsExportData = {
  rankings: RankingPlayer[];
  snapshots: AgentRankingSnapshot[];
  leagueSize: LeagueSize;
  favoriteSourceKeys: readonly string[];
  excludedAggregateSourceKeys: readonly string[];
  exportedAt?: Date;
};

const colors = {
  background: "FF0B0C0E",
  surface: "FF141518",
  amber: "FFF59E0B",
  amberSoft: "FF34240C",
  text: "FFF4F1E8",
  muted: "FFB2B5BB",
  green: "FF48C78E",
  border: "FF3A3D43",
};

export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function uniqueExcelSheetName(requestedName: string, usedNames: Set<string>): string {
  const cleaned = requestedName
    .replace(/[\\/*?:[\]]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^'+|'+$/g, "")
    .trim() || "Rankings";
  let candidate = cleaned.slice(0, 31);
  let suffix = 2;
  while (usedNames.has(candidate.toLocaleLowerCase("en-US"))) {
    const ending = ` (${suffix})`;
    candidate = `${cleaned.slice(0, 31 - ending.length).trimEnd()}${ending}`;
    suffix += 1;
  }
  usedNames.add(candidate.toLocaleLowerCase("en-US"));
  return candidate;
}

function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function addTitle(worksheet: Worksheet, title: string, subtitle: string, columns: number) {
  worksheet.mergeCells(1, 1, 1, Math.max(columns, 1));
  const titleCell = worksheet.getCell(1, 1);
  titleCell.value = title;
  titleCell.font = { bold: true, color: { argb: colors.text }, size: 16 };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: colors.background } };
  titleCell.alignment = { vertical: "middle" };
  worksheet.getRow(1).height = 27;

  worksheet.mergeCells(2, 1, 2, Math.max(columns, 1));
  const subtitleCell = worksheet.getCell(2, 1);
  subtitleCell.value = subtitle;
  subtitleCell.font = { color: { argb: colors.muted }, italic: true, size: 10 };
  subtitleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: colors.surface } };
  subtitleCell.alignment = { vertical: "middle", wrapText: true };
  worksheet.getRow(2).height = 25;
}

function addTable(
  worksheet: Worksheet,
  title: string,
  subtitle: string,
  headers: string[],
  rows: Array<Array<string | number | boolean | null | undefined>>,
  widths: number[],
  hyperlinkColumnIndexes: number[] = [],
) {
  addTitle(worksheet, title, subtitle, headers.length);
  const headerRow = worksheet.getRow(4);
  headerRow.values = headers;
  headerRow.height = 23;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: colors.background }, size: 10 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: colors.amber } };
    cell.alignment = { vertical: "middle", wrapText: true };
    cell.border = { bottom: { style: "thin", color: { argb: colors.border } } };
  });

  for (const values of rows) {
    const row = worksheet.addRow(values);
    row.alignment = { vertical: "top", wrapText: true };
    row.eachCell((cell, columnNumber) => {
      cell.font = { color: { argb: colors.text }, size: 10 };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: row.number % 2 === 0 ? colors.surface : colors.background },
      };
      cell.border = { bottom: { style: "hair", color: { argb: colors.border } } };
      const columnIndex = columnNumber - 1;
      if (hyperlinkColumnIndexes.includes(columnIndex) && typeof values[columnIndex] === "string") {
        const hyperlink = safeHttpUrl(values[columnIndex] as string);
        if (hyperlink) {
          cell.value = { text: hyperlink, hyperlink, tooltip: "Open original source" };
          cell.font = { color: { argb: colors.amber }, underline: true, size: 10 };
        }
      }
    });
  }

  worksheet.columns.forEach((column, index) => { column.width = widths[index] ?? 14; });
  worksheet.views = [{ state: "frozen", ySplit: 4, activeCell: "A5", showGridLines: false }];
  worksheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: headers.length } };
  worksheet.properties.defaultRowHeight = 18;
}

function sourceUrl(snapshot: AgentRankingSnapshot): string {
  return safeHttpUrl(snapshot.sourceUrl ?? snapshot.source.attributionUrl) ?? "";
}

function sourceSubtitle(snapshot: AgentRankingSnapshot): string {
  return [
    `${snapshot.scoringFormat.toUpperCase()} ${snapshot.rankingType.replaceAll("_", " ")}`,
    `${snapshot.leagueSize ?? 12} teams`,
    `season ${snapshot.season}`,
    snapshot.week === null ? "season-long" : `week ${snapshot.week}`,
    `generated ${formatDate(snapshot.generatedAt)}`,
  ].join(" · ");
}

export async function buildRankingsWorkbook(data: RankingsExportData): Promise<Workbook> {
  const { Workbook: ExcelWorkbook } = await import("exceljs");
  const workbook = new ExcelWorkbook();
  const exportedAt = data.exportedAt ?? new Date();
  workbook.creator = "Sloppy Potato Fantasy Football";
  workbook.created = exportedAt;
  workbook.modified = exportedAt;
  workbook.subject = `${data.leagueSize}-team fantasy football rankings export`;
  workbook.title = "Sloppy Potato Fantasy Football Rankings";

  const usedNames = new Set<string>();
  const fullAggregate = aggregateRankingSnapshots(data.snapshots);
  const aggregate = aggregateRankingSnapshots(data.snapshots, data.excludedAggregateSourceKeys);
  const compatibleSnapshots = fullAggregate
    ? data.snapshots.filter((snapshot) => isSnapshotInScope(snapshot, fullAggregate.scope))
    : [];
  const latestSources = selectLatestSnapshotPerSource(compatibleSnapshots)
    .sort((left, right) => left.source.name.localeCompare(right.source.name, "en-US"));
  const eligibleKeys = new Set(fullAggregate?.sourceSnapshots.map((snapshot) => snapshot.source.canonicalKey) ?? []);
  const favoriteKeys = new Set(data.favoriteSourceKeys);
  const excludedKeys = new Set(data.excludedAggregateSourceKeys);
  const scopeDescription = fullAggregate
    ? `${fullAggregate.scope.leagueSize}-team · ${fullAggregate.scope.scoringFormat.toUpperCase()} · ${fullAggregate.scope.rankingType.replaceAll("_", " ")} · ${fullAggregate.scope.season} · ${fullAggregate.scope.positionScope}`
    : `${data.leagueSize}-team · no compatible agent snapshot`;

  const overview = workbook.addWorksheet(uniqueExcelSheetName("Overview", usedNames), { views: [{ showGridLines: false }] });
  addTable(
    overview,
    "Sloppy Potato Rankings Export",
    `Created ${formatDate(exportedAt)} · ${scopeDescription}`,
    ["Item", "Value"],
    [
      ["League size", data.leagueSize],
      ["Scope", scopeDescription],
      ["My Rankings players", data.rankings.length],
      ["Aggregate players", aggregate?.entries.length ?? 0],
      ["Included aggregate sources", aggregate?.sourceSnapshots.length ?? 0],
      ["Eligible aggregate sources", fullAggregate?.sourceSnapshots.length ?? 0],
      ["Latest compatible individual sources", latestSources.length],
      ["Exported at", formatDate(exportedAt)],
      ["Notes", "Every list is exported in full. Rankings-page name, position, and display filters do not limit this workbook."],
    ],
    [30, 92],
  );

  const personalPositionRanks = derivePositionRanks(data.rankings, (player) => player.id, (player) => player.position);
  const personal = workbook.addWorksheet(uniqueExcelSheetName("My Rankings", usedNames), { views: [{ showGridLines: false }] });
  addTable(
    personal,
    "My Rankings",
    `Private saved order · ${data.leagueSize}-team PPR redraft`,
    ["Overall Rank", "Position Rank", "Player", "Position", "Team", "Consensus Rank", "Difference", "Trend", "Player ID"],
    data.rankings.map((player, index) => [
      index + 1,
      personalPositionRanks.get(player.id)?.rank ?? "",
      player.name,
      player.position,
      player.team,
      player.consensusRank ?? "",
      player.consensusRank === null ? "" : player.consensusRank - index - 1,
      player.trend ?? "",
      player.id,
    ]),
    [14, 14, 28, 11, 10, 16, 13, 10, 30],
  );

  const aggregateSheet = workbook.addWorksheet(uniqueExcelSheetName("Aggregate", usedNames), { views: [{ showGridLines: false }] });
  const aggregatePositionRanks = derivePositionRanks(aggregate?.entries ?? [], (entry) => entry.id, (entry) => entry.position);
  addTable(
    aggregateSheet,
    "Aggregate Rankings",
    aggregate ? `${aggregate.label} · ${aggregate.sourceSnapshots.length}/${fullAggregate?.sourceSnapshots.length ?? 0} sources included · ${scopeDescription}` : `No sources included · ${scopeDescription}`,
    ["Overall Rank", "Position Rank", "Player", "Position", "Team", "Average Rank", "Coverage", "Eligible Sources", "Source Ranks"],
    (aggregate?.entries ?? []).map((entry) => [
      entry.rank,
      aggregatePositionRanks.get(entry.id)?.rank ?? "",
      entry.playerName,
      entry.position,
      entry.team,
      Number(entry.averageRank.toFixed(2)),
      entry.coverage,
      entry.sourceCount,
      entry.sourceRanks.map((sourceRank) => `${sourceRank.sourceName} #${sourceRank.rank}`).join("; "),
    ]),
    [14, 14, 28, 11, 10, 14, 11, 16, 58],
  );

  const details = workbook.addWorksheet(uniqueExcelSheetName("Aggregate Details", usedNames), { views: [{ showGridLines: false }] });
  addTable(
    details,
    "Aggregate Details",
    "One row per player and contributing source, including the original-source link and saved insight.",
    ["Aggregate Rank", "Player", "Position", "Team", "Average Rank", "Source", "Source Rank", "Insight", "Source Link", "Generated At", "Canonical Source Key"],
    (aggregate?.entries ?? []).flatMap((entry) => entry.sourceRanks.map((rank) => [
      entry.rank,
      entry.playerName,
      entry.position,
      entry.team,
      Number(entry.averageRank.toFixed(2)),
      rank.sourceName,
      rank.rank,
      rank.insight,
      safeHttpUrl(rank.attributionUrl) ?? "",
      formatDate(rank.generatedAt),
      rank.canonicalKey,
    ])),
    [15, 28, 11, 10, 14, 25, 13, 58, 48, 25, 34],
    [8],
  );

  const sources = workbook.addWorksheet(uniqueExcelSheetName("Sources", usedNames), { views: [{ showGridLines: false }] });
  addTable(
    sources,
    "Ranking Sources",
    `Latest individual source for the selected scope · ${scopeDescription}`,
    ["Source", "Kind", "Provider", "Favorite", "Aggregate Eligible", "Included in Aggregate", "Title", "Player Count", "Generated At", "Source Link", "Canonical Source Key", "Snapshot ID", "Summary", "Methodology"],
    latestSources.map((snapshot) => {
      const eligible = eligibleKeys.has(snapshot.source.canonicalKey);
      return [
        snapshot.source.name,
        snapshot.source.kind,
        snapshot.source.provider,
        favoriteKeys.has(snapshot.source.canonicalKey) ? "Yes" : "No",
        eligible ? "Yes" : "No",
        eligible ? (excludedKeys.has(snapshot.source.canonicalKey) ? "No" : "Yes") : "N/A",
        snapshot.title,
        snapshot.entries.length,
        formatDate(snapshot.generatedAt),
        sourceUrl(snapshot),
        snapshot.source.canonicalKey,
        snapshot.id,
        snapshot.summary,
        snapshot.methodology,
      ];
    }),
    [25, 12, 18, 11, 18, 20, 34, 13, 25, 48, 34, 28, 55, 55],
    [9],
  );

  for (const snapshot of latestSources) {
    const worksheet = workbook.addWorksheet(uniqueExcelSheetName(snapshot.source.name, usedNames), { views: [{ showGridLines: false }] });
    const positionRanks = derivePositionRanks(snapshot.entries, (entry) => entry.id, (entry) => entry.position);
    addTable(
      worksheet,
      snapshot.source.name,
      `${snapshot.title} · ${sourceSubtitle(snapshot)}`,
      ["Overall Rank", "Position Rank", "Player", "Position", "Team", "Previous Rank", "Movement", "Tier", "Insight", "Source Link", "Player ID"],
      [...snapshot.entries].sort((left, right) => left.rank - right.rank).map((entry) => [
        entry.rank,
        positionRanks.get(entry.id)?.rank ?? "",
        entry.playerName,
        entry.position,
        entry.team,
        entry.previousRank,
        entry.previousRank === null ? "New" : entry.previousRank - entry.rank,
        entry.tier,
        entry.insight,
        sourceUrl(snapshot),
        entry.playerId ?? entry.externalPlayerId ?? "",
      ]),
      [14, 14, 28, 11, 10, 15, 11, 9, 58, 48, 30],
      [9],
    );
  }

  return workbook;
}

export function rankingsExportFilename(data: Pick<RankingsExportData, "leagueSize" | "exportedAt">): string {
  const exportedAt = data.exportedAt ?? new Date();
  const date = Number.isFinite(exportedAt.getTime()) ? exportedAt.toISOString().slice(0, 10) : "rankings";
  return `sloppy-potato-rankings-${data.leagueSize}-team-${date}.xlsx`;
}

export async function exportRankingsToExcel(data: RankingsExportData): Promise<string> {
  const workbook = await buildRankingsWorkbook(data);
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const filename = rankingsExportFilename(data);
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Allow the browser to start reading the object URL before releasing it.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return filename;
}
