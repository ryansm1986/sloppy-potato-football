import { describe, expect, it } from "vitest";
import type { AgentRankingSnapshot } from "./agent-api";
import {
  buildRankingsWorkbook,
  rankingsExportFilename,
  safeHttpUrl,
  uniqueExcelSheetName,
} from "./rankings-export";

const externalSource = (name: string, canonicalKey: string, url: string, rank: number): AgentRankingSnapshot => ({
  id: `snapshot-${canonicalKey}`,
  source: {
    id: `source-${canonicalKey}`,
    canonicalKey,
    name,
    slug: canonicalKey.replace(/[^a-z0-9]+/gi, "-"),
    kind: "external",
    provider: null,
    attributionUrl: url,
  },
  title: `${name} PPR Rankings`,
  scoringFormat: "ppr",
  rankingType: "redraft",
  season: "2026",
  week: null,
  leagueSize: 12,
  positionScope: "ALL",
  sourceUrl: url,
  generatedAt: "2026-09-02T12:00:00.000Z",
  summary: `${name} summary`,
  methodology: `${name} methodology`,
  entries: [{
    id: `entry-${canonicalKey}`,
    playerId: "player-1",
    playerName: "Ja'Marr Chase",
    position: "WR",
    team: "CIN",
    rank,
    previousRank: rank + 1,
    tier: 1,
    insight: `${name} insight`,
  }],
});

describe("rankings Excel export", () => {
  it("sanitizes URLs and produces unique Excel-safe worksheet names", () => {
    expect(safeHttpUrl("https://example.com/ranks")).toBe("https://example.com/ranks");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    const used = new Set<string>();
    const first = uniqueExcelSheetName("Very/Long:*Expert?Name With Rankings", used);
    const second = uniqueExcelSheetName("Very/Long:*Expert?Name With Rankings", used);
    expect(first).toHaveLength(31);
    expect(first).not.toMatch(/[\\/*?:[\]]/);
    expect(second).toMatch(/\(2\)$/);
    expect(second).not.toBe(first);
  });

  it("exports full personal, aggregate, source metadata, detail, and individual boards", async () => {
    const sourceA = externalSource("Expert/A", "external:a", "https://example.com/a", 1);
    const sourceB = externalSource("Expert:A", "external:b", "javascript:alert(1)", 3);
    const workbook = await buildRankingsWorkbook({
      rankings: [{ id: "player-1", name: "Ja'Marr Chase", position: "WR", team: "CIN", consensusRank: 2, trend: 1 }],
      snapshots: [sourceA, sourceB],
      leagueSize: 12,
      favoriteSourceKeys: ["external:b"],
      excludedAggregateSourceKeys: ["external:b"],
      exportedAt: new Date("2026-09-02T15:30:00.000Z"),
    });

    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      "Overview",
      "My Rankings",
      "Aggregate",
      "Aggregate Details",
      "Sources",
      "Expert A",
      "Expert A (2)",
    ]);
    expect(workbook.getWorksheet("My Rankings")?.getCell("C5").value).toBe("Ja'Marr Chase");
    expect(workbook.getWorksheet("Aggregate")?.getCell("F5").value).toBe(1);
    expect(workbook.getWorksheet("Aggregate Details")?.getCell("F5").value).toBe("Expert/A");

    const sources = workbook.getWorksheet("Sources")!;
    expect(sources.rowCount).toBe(6);
    const sourceRows = [sources.getRow(5), sources.getRow(6)];
    const rowA = sourceRows.find((row) => row.getCell(11).value === "external:a")!;
    const rowB = sourceRows.find((row) => row.getCell(11).value === "external:b")!;
    expect(rowA.getCell(4).value).toBe("No");
    expect(rowB.getCell(4).value).toBe("Yes");
    expect(rowB.getCell(6).value).toBe("No");
    expect(rowA.getCell(10).value).toEqual(expect.objectContaining({ hyperlink: "https://example.com/a" }));
    expect(rowB.getCell(10).value).toBe("");

    const excludedSourceSheet = workbook.getWorksheet("Expert A (2)")!;
    expect(excludedSourceSheet.getCell("C5").value).toBe("Ja'Marr Chase");
    expect(excludedSourceSheet.views[0]).toMatchObject({ state: "frozen", ySplit: 4 });
    expect(excludedSourceSheet.autoFilter).toEqual({ from: { row: 4, column: 1 }, to: { row: 4, column: 11 } });
    expect((await workbook.xlsx.writeBuffer()).byteLength).toBeGreaterThan(1_000);
  });

  it("creates a descriptive filename", () => {
    expect(rankingsExportFilename({ leagueSize: 14, exportedAt: new Date("2026-09-02T23:00:00.000Z") }))
      .toBe("sloppy-potato-rankings-14-team-2026-09-02.xlsx");
  });
});
