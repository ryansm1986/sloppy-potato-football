import { z } from "zod";

const stringRecord = z.record(z.string(), z.unknown());
const numericRecord = z.record(z.string(), z.number());

export const sleeperLeagueSchema = z.object({
  league_id: z.string(),
  name: z.string(),
  sport: z.string(),
  season: z.string(),
  season_type: z.string(),
  status: z.string(),
  avatar: z.string().nullish(),
  draft_id: z.string().nullish(),
  previous_league_id: z.string().nullish(),
  total_rosters: z.number().optional(),
  roster_positions: z.array(z.string()).default([]),
  scoring_settings: numericRecord.default({}),
  settings: stringRecord.default({}),
}).passthrough();

export const sleeperRosterSchema = z.object({
  roster_id: z.number(),
  league_id: z.string(),
  owner_id: z.string().nullish(),
  co_owners: z.array(z.string()).nullish(),
  players: z.array(z.string()).nullish(),
  starters: z.array(z.string()).nullish(),
  reserve: z.array(z.string()).nullish(),
  taxi: z.array(z.string()).nullish(),
  settings: stringRecord.default({}),
  metadata: stringRecord.nullish(),
}).passthrough();

export const sleeperLeagueMemberSchema = z.object({
  user_id: z.string(),
  username: z.string().nullish(),
  display_name: z.string(),
  avatar: z.string().nullish(),
  metadata: stringRecord.nullish(),
  is_owner: z.boolean().optional().default(false),
}).passthrough();

export const sleeperDraftSchema = z.object({
  draft_id: z.string(),
  league_id: z.string(),
  type: z.string(),
  status: z.string(),
  season: z.string(),
  season_type: z.string(),
  start_time: z.number().nullish(),
  settings: stringRecord.default({}),
  metadata: stringRecord.default({}),
  draft_order: z.record(z.string(), z.number()).nullish(),
  slot_to_roster_id: z.record(z.string(), z.number()).nullish(),
}).passthrough();

export const sleeperDraftPickSchema = z.object({
  draft_id: z.string(),
  player_id: z.string().nullish(),
  picked_by: z.string().nullish(),
  roster_id: z.union([z.number(), z.string()]).nullish(),
  round: z.number(),
  draft_slot: z.number(),
  pick_no: z.number(),
  metadata: stringRecord.default({}),
  is_keeper: z.boolean().nullish(),
}).passthrough();

export const sleeperPlayerSchema = z.object({
  player_id: z.string().optional(),
  active: z.boolean().nullish(),
  sport: z.string().optional(),
  first_name: z.string().nullish(),
  last_name: z.string().nullish(),
  full_name: z.string().nullish(),
  search_full_name: z.string().nullish(),
  position: z.string().nullish(),
  fantasy_positions: z.array(z.string()).nullish(),
  team: z.string().nullish(),
  number: z.union([z.number(), z.string()]).nullish(),
  status: z.string().nullish(),
  injury_status: z.string().nullish(),
  injury_body_part: z.string().nullish(),
  injury_notes: z.string().nullish(),
  age: z.union([z.number(), z.string()]).nullish(),
  height: z.string().nullish(),
  weight: z.union([z.number(), z.string()]).nullish(),
  college: z.string().nullish(),
  years_exp: z.union([z.number(), z.string()]).nullish(),
  depth_chart_position: z.union([z.number(), z.string()]).nullish(),
  depth_chart_order: z.union([z.number(), z.string()]).nullish(),
  news_updated: z.union([z.number(), z.string()]).nullish(),
  espn_id: z.union([z.number(), z.string()]).nullish(),
  yahoo_id: z.union([z.number(), z.string()]).nullish(),
  fantasy_data_id: z.union([z.number(), z.string()]).nullish(),
  sportradar_id: z.union([z.number(), z.string()]).nullish(),
}).passthrough();

export const sleeperPlayerMapSchema = z.record(z.string(), sleeperPlayerSchema);

export type SleeperLeague = z.infer<typeof sleeperLeagueSchema>;
export type SleeperRoster = z.infer<typeof sleeperRosterSchema>;
export type SleeperLeagueMember = z.infer<typeof sleeperLeagueMemberSchema>;
export type SleeperDraft = z.infer<typeof sleeperDraftSchema>;
export type SleeperDraftPick = z.infer<typeof sleeperDraftPickSchema>;
export type SleeperPlayer = z.infer<typeof sleeperPlayerSchema>;
export type SleeperPlayerMap = z.infer<typeof sleeperPlayerMapSchema>;
