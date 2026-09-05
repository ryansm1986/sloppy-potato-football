import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";
import type * as schema from "../db/schema";

type Database = DrizzleD1Database<typeof schema> & { $client: D1Database };

export const researchSettingsInput = z.object({
  focus: z.enum(["balanced", "injuries", "usage", "draft_value"]),
  detail: z.enum(["concise", "standard", "thorough"]),
  recencyDays: z.union([z.literal(7), z.literal(30), z.literal(90)]),
  sourceTarget: z.number().int().min(3).max(10),
}).strict();

export type ResearchSettings = z.infer<typeof researchSettingsInput>;
export const defaultResearchSettings: ResearchSettings = {
  focus: "balanced", detail: "standard", recencyDays: 30, sourceTarget: 3,
};

export async function getResearchSettings(db: Database, ownerIdentity = "primary-owner"): Promise<ResearchSettings> {
  const row = await db.$client.prepare("SELECT settings_json FROM research_agent_settings WHERE owner_identity = ?")
    .bind(ownerIdentity).first<{ settings_json: string }>();
  if (!row) return { ...defaultResearchSettings };
  try { return researchSettingsInput.parse(JSON.parse(row.settings_json)); }
  catch { return { ...defaultResearchSettings }; }
}

export async function saveResearchSettings(db: Database, settings: ResearchSettings, ownerIdentity = "primary-owner") {
  const validated = researchSettingsInput.parse(settings);
  await db.$client.prepare(
    `INSERT INTO research_agent_settings (owner_identity, settings_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(owner_identity) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`,
  ).bind(ownerIdentity, JSON.stringify(validated), Date.now()).run();
  return validated;
}

export function researchSettingsInstructions(settings: ResearchSettings, namedSourceOnly = false) {
  const focus = {
    balanced: "Balance current role, news, risk, and fantasy value",
    injuries: "Emphasize injury status, recovery evidence, and availability risk",
    usage: "Emphasize snaps, routes, touches, targets, and role changes",
    draft_value: "Emphasize draft cost, ADP comparisons, upside, and value by pick",
  }[settings.focus];
  const detail = {
    concise: "Keep the narrative concise and prioritize actionable findings",
    standard: "Give a clear summary with supporting evidence and actionable findings",
    thorough: "Explain supporting evidence, conflicting reports, uncertainty, and actionable implications thoroughly",
  }[settings.detail];
  const sourceInstructions = namedSourceOnly
    ? "Refresh only the named publisher; do not expand this assignment to other publishers."
    : `Target ${settings.sourceTarget} independent reputable publishers for this research; if fewer can be verified, report the shortfall honestly. Never fabricate evidence to meet a source target.`;
  return ` Research preferences: ${focus}. ${detail}; narrative detail must not reduce requested ranking or sleeper coverage. Prefer evidence published in the last ${settings.recencyDays} days; label older evidence and never invent publication dates. ${sourceInstructions} Stay within the required result schema and output limits.`;
}
