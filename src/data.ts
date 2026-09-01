export type LineupPlayer = {
  slot: string;
  name: string;
  team: string;
  opponent: string;
  projection: number;
  rank: string;
  note?: string;
};

export const lineup: LineupPlayer[] = [
  { slot: "QB", name: "Josh Allen", team: "BUF", opponent: "vs BAL", projection: 24.3, rank: "QB 1" },
  { slot: "RB", name: "Christian McCaffrey", team: "SF", opponent: "vs NE", projection: 18.7, rank: "RB 5", note: "Q" },
  { slot: "RB", name: "Bijan Robinson", team: "ATL", opponent: "vs NO", projection: 17.9, rank: "RB 3" },
  { slot: "WR", name: "Ja'Marr Chase", team: "CIN", opponent: "at CAR", projection: 15.1, rank: "WR 4" },
  { slot: "WR", name: "Justin Jefferson", team: "MIN", opponent: "at GB", projection: 14.8, rank: "WR 6" },
  { slot: "TE", name: "Travis Kelce", team: "KC", opponent: "at LAC", projection: 12.2, rank: "TE 2" },
  { slot: "FLEX", name: "Rachaad White", team: "TB", opponent: "vs PHI", projection: 11.4, rank: "RB 22" },
  { slot: "DST", name: "Ravens D/ST", team: "BAL", opponent: "at BUF", projection: 7.5, rank: "DST 4" },
];

export const news = [
  {
    player: "Christian McCaffrey",
    source: "49ers Wire",
    time: "18 min ago",
    severity: "Watch",
    headline: "Limited in practice; Friday participation will clarify Week 4 workload.",
  },
  {
    player: "Bijan Robinson",
    source: "The Athletic",
    time: "52 min ago",
    severity: "Usage up",
    headline: "Route participation climbed again, strengthening his PPR receiving floor.",
  },
];

export const movers = [
  { name: "Malik Nabers", position: "WR", movement: "+8", rank: "WR 17" },
  { name: "Jaylen Warren", position: "RB", movement: "+6", rank: "RB 29" },
  { name: "Mark Andrews", position: "TE", movement: "−5", rank: "TE 8" },
];
