import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";
import type * as schema from "../db/schema";

type Database = DrizzleD1Database<typeof schema> & { $client: D1Database };
type PublisherRow = { id: string; domain: string; name: string; url: string; blocked: number; archived: number; notes: string; tags_json: string; rankings: number; sleepers: number; first_seen_at: number; last_seen_at: number; favorite?: number; excluded?: number };
export const publisherQueryInput = z.object({ search: z.string().trim().max(100).optional(), status: z.enum(["all", "active", "blocked", "archived", "favorite"]).default("all"), kind: z.enum(["all", "rankings", "sleepers"]).default("all") });
export const updatePublisherInput = z.object({ blocked: z.boolean().optional(), archived: z.boolean().optional(), name: z.string().trim().min(1).max(120).optional(), notes: z.string().trim().max(2000).optional(), tags: z.array(z.string().trim().min(1).max(40)).max(12).optional() }).strict().refine(value => Object.keys(value).length > 0, "Supply a publisher change");
export const publisherPreferencesInput = z.object({ favorite: z.boolean().optional(), excluded: z.boolean().optional() }).strict().refine(value => Object.keys(value).length > 0, "Supply a preference change");
export class PublisherError extends Error {
  constructor(readonly code: "not_found" | "source_policy_changed", message: string) { super(message); this.name = "PublisherError"; }
}

// Keep tenant subdomains independent (e.g. author.substack.com). Do not merge
// existing ranking-source IDs, which may identify different experts at one host.
export function publisherDomain(url: string) {
  try { const parsed = new URL(url); return ["https:", "http:"].includes(parsed.protocol) ? parsed.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "") : null; } catch { return null; }
}
function publicPublisher(row: PublisherRow, rankingSourceIds: string[] = []) {
  return { id: row.id, domain: row.domain, name: row.name, url: row.url, blocked: row.blocked === 1, archived: row.archived === 1, notes: row.notes, tags: JSON.parse(row.tags_json) as string[], favorite: row.favorite === 1, excluded: row.excluded === 1, kinds: [...(row.rankings ? ["rankings"] : []), ...(row.sleepers ? ["sleepers"] : [])], firstSeenAt: new Date(row.first_seen_at).toISOString(), lastSeenAt: new Date(row.last_seen_at).toISOString(), rankingSourceIds };
}
export async function registerPublisherEvidence(db: Database, evidence: Array<{url: string; name: string; kind: "rankings" | "sleepers"; seenAt?: number}>) {
  const grouped = new Map<string, {url: string; name: string; rankings: number; sleepers: number; first: number; last: number}>();
  for (const item of evidence) {
    const domain = publisherDomain(item.url); if (!domain) continue;
    const time = item.seenAt ?? Date.now();
    const value = grouped.get(domain) ?? { url: item.url, name: item.name.slice(0,120), rankings: 0, sleepers: 0, first: time, last: time };
    value[item.kind] = 1; value.first = Math.min(value.first,time); value.last = Math.max(value.last,time); grouped.set(domain,value);
  }
  const statements = [...grouped].map(([domain,value]) => db.$client.prepare(`INSERT INTO publishers(id,domain,name,url,rankings,sleepers,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(domain) DO UPDATE SET rankings=MAX(rankings,excluded.rankings), sleepers=MAX(sleepers,excluded.sleepers), first_seen_at=MIN(first_seen_at,excluded.first_seen_at), last_seen_at=MAX(last_seen_at,excluded.last_seen_at) WHERE excluded.first_seen_at < first_seen_at OR excluded.last_seen_at > last_seen_at OR excluded.rankings > rankings OR excluded.sleepers > sleepers`).bind(`publisher:${domain}`,domain,value.name,value.url,value.rankings,value.sleepers,value.first,value.last));
  for (let i=0;i<statements.length;i+=80) await db.$client.batch(statements.slice(i,i+80));
}
// Backfill from immutable history. Names/domains never overwrite owner edits.
export async function syncPublisherRegistry(db: Database) {
  const [rankings,sleepers] = await Promise.all([
    db.$client.prepare("SELECT rs.id,rs.name,COALESCE(sn.source_url,rs.attribution_url) AS url,MIN(sn.created_at) AS first_seen,MAX(sn.created_at) AS last_seen FROM ranking_sources rs JOIN ranking_snapshots sn ON sn.source_id=rs.id AND sn.status='completed' GROUP BY rs.id,url").all<{id:string;name:string;url:string|null;first_seen:number;last_seen:number}>(),
    db.$client.prepare("SELECT ss.publisher AS name,ss.url,MIN(sr.created_at) AS first_seen,MAX(sr.created_at) AS last_seen FROM sleeper_candidate_sources ss JOIN sleeper_candidates sc ON sc.id=ss.candidate_id JOIN sleeper_reports sr ON sr.id=sc.report_id WHERE sr.published_at IS NOT NULL GROUP BY ss.publisher,ss.url").all<{name:string;url:string;first_seen:number;last_seen:number}>(),
  ]);
  await registerPublisherEvidence(db,[...rankings.results.filter(row=>row.url).flatMap(row=>[{url:row.url!,name:row.name,kind:"rankings" as const,seenAt:row.first_seen},{url:row.url!,name:row.name,kind:"rankings" as const,seenAt:row.last_seen}]),...sleepers.results.flatMap(row=>[{url:row.url,name:row.name,kind:"sleepers" as const,seenAt:row.first_seen},{url:row.url,name:row.name,kind:"sleepers" as const,seenAt:row.last_seen}])]);
  return rankings.results;
}
export async function listPublishers(db: Database, identity = "primary-owner", input: z.input<typeof publisherQueryInput> = {}) {
  const query = publisherQueryInput.parse(input);
  const rankingRows = await syncPublisherRegistry(db);
  const rows = await db.$client.prepare("SELECT p.*,pref.favorite,pref.excluded FROM publishers p LEFT JOIN publisher_preferences pref ON pref.publisher_id=p.id AND pref.owner_identity=? ORDER BY p.last_seen_at DESC,p.domain").bind(identity).all<PublisherRow>();
  return rows.results.filter(row => (!query.search || `${row.name} ${row.domain} ${row.notes} ${row.tags_json}`.toLowerCase().includes(query.search.toLowerCase())) && (query.kind === "all" || row[query.kind] === 1) && (query.status === "all" || query.status === "active" && !row.blocked && !row.archived || query.status === "blocked" && row.blocked === 1 || query.status === "archived" && row.archived === 1 || query.status === "favorite" && row.favorite === 1)).slice(0,1000).map(row=>publicPublisher(row,[...new Set(rankingRows.filter(source=>source.url && publisherDomain(source.url)===row.domain).map(source=>source.id))]));
}
async function requirePublisher(db: Database,id:string,identity="primary-owner") {
  const row = await db.$client.prepare("SELECT p.*,pref.favorite,pref.excluded FROM publishers p LEFT JOIN publisher_preferences pref ON pref.publisher_id=p.id AND pref.owner_identity=? WHERE p.id=?").bind(identity,id).first<PublisherRow>();
  if (!row) throw new PublisherError("not_found","Publisher not found"); return row;
}
export async function updatePublisher(db: Database,id:string,value:z.input<typeof updatePublisherInput>) {
  const input = updatePublisherInput.parse(value); await requirePublisher(db,id);
  const fields = Object.entries(input).map(([key,val])=>[key === "tags" ? "tags_json" : key,key === "tags" ? JSON.stringify([...new Set(val as string[])]) : typeof val === "boolean" ? Number(val) : val]);
  // Check the actual previous blocked state inside the same transaction as the
  // edit. Metadata, archive changes, and repeated identical blocks must not
  // invalidate an otherwise valid research result being published.
  await db.$client.batch([
    ...(input.blocked === undefined ? [] : [db.$client.prepare("UPDATE publisher_policy_version SET version=version+1 WHERE id=1 AND EXISTS (SELECT 1 FROM publishers WHERE id=? AND blocked<>?)").bind(id,Number(input.blocked))]),
    db.$client.prepare(`UPDATE publishers SET ${fields.map(([key])=>`${key}=?`).join(",")} WHERE id=?`).bind(...fields.map(([,val])=>val),id),
  ]);
  return publicPublisher(await requirePublisher(db,id));
}
export async function savePublisherPreferences(db: Database,id:string,identity:string,value:z.input<typeof publisherPreferencesInput>) {
  const input = publisherPreferencesInput.parse(value); await requirePublisher(db,id,identity);
  await db.$client.prepare("INSERT INTO publisher_preferences(publisher_id,owner_identity,favorite,excluded,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(publisher_id,owner_identity) DO UPDATE SET favorite=COALESCE(?,favorite),excluded=COALESCE(?,excluded),updated_at=excluded.updated_at").bind(id,identity,Number(input.favorite ?? false),Number(input.excluded ?? false),Date.now(),input.favorite === undefined ? null : Number(input.favorite),input.excluded === undefined ? null : Number(input.excluded)).run();
  return publicPublisher(await requirePublisher(db,id,identity));
}
export async function getPublisherPolicy(db:Database, identity="primary-owner") {
  // One SQL snapshot prevents reading an old policy with a newer revision.
  const rows = await db.$client.prepare("SELECT p.*,pref.favorite,pref.excluded,v.version AS policy_version FROM publisher_policy_version v LEFT JOIN publishers p ON 1=1 LEFT JOIN publisher_preferences pref ON pref.publisher_id=p.id AND pref.owner_identity=? WHERE v.id=1").bind(identity).all<PublisherRow & {policy_version:number}>();
  return { rows: rows.results.filter(row=>row.id !== null), version: rows.results[0]?.policy_version ?? 0 };
}
export function publisherFlags(policy:Awaited<ReturnType<typeof getPublisherPolicy>>,url:string|null) {
  const domain = url ? publisherDomain(url) : null;
  const exact = policy.rows.find(row=>row.domain===domain);
  const blocked = !!domain && policy.rows.some(row=>row.blocked===1 && (domain===row.domain || domain.endsWith(`.${row.domain}`)));
  return { publisherId: exact?.id ?? null, blocked, archived: exact?.archived===1, favorite: exact?.favorite===1, excluded: exact?.excluded===1 };
}
export function assertPublisherUrlsAllowed(policy:Awaited<ReturnType<typeof getPublisherPolicy>>,urls:string[]) {
  const blocked = [...new Set(urls.filter(url=>publisherFlags(policy,url).blocked).map(url=>publisherDomain(url)))];
  if (blocked.length) throw new PublisherError("source_policy_changed",`Research includes blocked publishers: ${blocked.slice(0,5).join(", ")}. Remove blocked evidence and retry research with the current publisher policy.`);
}
export async function assertRefreshPublisherAllowed(db:Database,name:string|undefined,policy?:Awaited<ReturnType<typeof getPublisherPolicy>>) {
  if (!name) return;
  const current = policy ?? await getPublisherPolicy(db);
  const sources = await db.$client.prepare("SELECT name,attribution_url FROM ranking_sources WHERE LOWER(name)=LOWER(?) OR LOWER(slug)=LOWER(?) OR LOWER(canonical_key)=LOWER(?)").bind(name,name,name).all<{name:string;attribution_url:string|null}>();
  const normalized=name.trim().toLowerCase();
  if (current.rows.some(row=>(row.blocked || row.archived) && [row.name.toLowerCase(),row.domain,row.id.toLowerCase()].includes(normalized))) throw new PublisherError("source_policy_changed","This publisher is blocked or archived. Restore it before scheduling a refresh.");
  for(const source of sources.results) { const flags=publisherFlags(current,source.attribution_url); if(flags.blocked || flags.archived) throw new PublisherError("source_policy_changed","This ranking publisher is blocked or archived. Restore it before scheduling a refresh."); }
}
export function publisherPolicyInstructions(policy:Awaited<ReturnType<typeof getPublisherPolicy>>) {
  const blocked=policy.rows.filter(row=>row.blocked).map(row=>row.domain);
  if(!blocked.length) return "";
  let names=""; let count=0;
  for(const domain of blocked) { if(names.length+domain.length+2>350) break; names+=(names ? ", " : "")+domain; count++; }
  return ` Publisher policy: do not use evidence from blocked hosts or their subdomains: ${names}.${count<blocked.length ? ` This is a partial list (${count} of ${blocked.length}); the server validates the full blocklist and rejects disallowed results.` : " The server rejects blocked evidence."}`;
}
