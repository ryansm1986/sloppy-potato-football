import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema";
import { assertPublisherUrlsAllowed, getPublisherPolicy, listPublishers, publisherDomain, publisherFlags, publisherPolicyInstructions, registerPublisherEvidence, savePublisherPreferences, updatePublisher } from "./publishers";
import { claimResearchJob, completeResearchJob, completeResearchJobInput, createResearchJob, createResearchJobInput, heartbeatRunner } from "./research-bridge";
import { createRankingSnapshot, getRankingSnapshots, rankingSnapshotInput } from "./ranking-snapshots";
import { getLatestSleeperReport, getSleeperReports, persistSleeperReport, publishSleeperReport, sleeperReportInput } from "./sleeper-reports";

const db = () => drizzle(env.DB,{schema});
async function publisher(domain="example.com",kind:"rankings"|"sleepers"="rankings") {
  await registerPublisherEvidence(db(),[{url:`https://${domain}/board`,name:"Example expert",kind}]);
  return `publisher:${domain}`;
}
async function leased(type="player_research") {
  const job=await createResearchJob(db(),createResearchJobInput.parse({type,subject:"Bijan Robinson",sourceName:"Example expert"}),crypto.randomUUID());
  const runnerId=`test-${crypto.randomUUID()}`;
  await heartbeatRunner(db(),{runnerId,provider:"codex",status:"idle",capabilities:[]});
  const claim=await claimResearchJob(db(),runnerId);
  expect(claim?.id).toBe(job.job.id);
  return {runnerId,claim:claim!,jobId:job.job.id};
}
const board=(url:string)=>rankingSnapshotInput.parse({source:{slug:"example-rankings",name:"Example expert",kind:"external",attributionUrl:url},title:"September rankings",scoringFormat:"ppr",rankingType:"redraft",season:"2026",generatedAt:"2026-09-01T12:00:00Z",entries:[{playerName:"Bijan Robinson",position:"RB",rank:1}]});

describe("publisher registry and policy",()=>{
  beforeEach(async()=>{
    // The Worker pool retains this suite's database between cases. Keep saved
    // evidence intact but reset mutable policy/preferences to an explicit base.
    await env.DB.batch([
      env.DB.prepare("UPDATE publishers SET blocked=0,archived=0"),
      env.DB.prepare("DELETE FROM publisher_preferences"),
      env.DB.prepare("UPDATE publisher_policy_version SET version=version+1 WHERE id=1"),
    ]);
  });
  it("uses stable normalized host IDs, retaining independent shared-host tenants",async()=>{
    expect(publisherDomain("https://WWW.Example.com./one")).toBe("example.com");
    expect(publisherDomain("https://writer.substack.com/article")).toBe("writer.substack.com");
    expect(publisherDomain("javascript:alert(1)")).toBeNull();
    await registerPublisherEvidence(db(),[{url:"https://www.example.com/rankings",name:"First name",kind:"rankings",seenAt:1000},{url:"https://example.com/sleepers",name:"New name",kind:"sleepers",seenAt:2000}]);
    const list=await listPublishers(db());
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({id:"publisher:example.com",name:"First name",kinds:["rankings","sleepers"]});
    await updatePublisher(db(),list[0].id,{name:"My publisher label",tags:["Trusted","Trusted"],notes:"Strong injury coverage"});
    await publisher();
    expect((await listPublishers(db()))[0]).toMatchObject({name:"My publisher label",tags:["Trusted"],notes:"Strong injury coverage"});
  });
  it("isolates per-user preferences and preserves partial updates",async()=>{
    const id=await publisher();
    await savePublisherPreferences(db(),id,"owner-a",{favorite:true,excluded:true});
    await savePublisherPreferences(db(),id,"owner-a",{favorite:false});
    expect((await listPublishers(db(),"owner-a"))[0]).toMatchObject({favorite:false,excluded:true});
    expect((await listPublishers(db(),"owner-b"))[0]).toMatchObject({favorite:false,excluded:false});
    await savePublisherPreferences(db(),id,"owner-b",{favorite:true});
    expect(await listPublishers(db(),"owner-a",{status:"favorite"})).toHaveLength(0);
    expect(await listPublishers(db(),"owner-b",{status:"favorite",search:"EXAMPLE",kind:"rankings"})).toHaveLength(1);
    await expect(updatePublisher(db(),"unknown",{blocked:true})).rejects.toMatchObject({code:"not_found"});
    await expect(savePublisherPreferences(db(),id,"owner-b",{blocked:true} as never)).rejects.toBeDefined();
  });
  it("blocks host boundaries, not lookalikes or unrelated tenant sites",async()=>{
    await updatePublisher(db(),await publisher(),{blocked:true});
    await updatePublisher(db(),await publisher("writer.substack.com"),{blocked:true});
    const policy=await getPublisherPolicy(db());
    expect(()=>assertPublisherUrlsAllowed(policy,["https://news.example.com/article"])).toThrow(/blocked publishers/);
    expect(()=>assertPublisherUrlsAllowed(policy,["https://notexample.com/article","https://example.com.evil.test/","https://other.substack.com/article"])).not.toThrow();
    expect(publisherFlags(policy,"https://writer.substack.com/article").blocked).toBe(true);
  });
  it("blocks targeted refreshes before queue and after queue, without deleting history",async()=>{
    const snapshot=await createRankingSnapshot(db(),board("https://example.com/board"));
    const job=await createResearchJob(db(),createResearchJobInput.parse({type:"source_refresh",sourceName:"Example expert"}),crypto.randomUUID());
    await updatePublisher(db(),"publisher:example.com",{blocked:true});
    await expect(createResearchJob(db(),createResearchJobInput.parse({type:"source_refresh",sourceName:"Example expert"}),crypto.randomUUID())).rejects.toMatchObject({code:"source_policy_changed"});
    const runnerId=`runner-${crypto.randomUUID()}`;
    await heartbeatRunner(db(),{runnerId,provider:"codex",status:"idle",capabilities:[]});
    expect(await claimResearchJob(db(),runnerId)).toBeNull();
    expect(await env.DB.prepare("SELECT status,error_code FROM research_jobs WHERE id=?").bind(job.job.id).first()).toEqual({status:"failed",error_code:"source_policy_changed"});
    const historical=await getRankingSnapshots(db(),10);
    expect(historical[0]).toMatchObject({id:snapshot.id,source:{blocked:true},entries:[{rank:1,playerName:"Bijan Robinson"}]});
    await updatePublisher(db(),"publisher:example.com",{blocked:false,archived:true});
    expect((await listPublishers(db(),"primary-owner",{status:"archived"}))).toHaveLength(1);
    await expect(createResearchJob(db(),createResearchJobInput.parse({type:"source_refresh",sourceName:"Example expert"}),crypto.randomUUID())).rejects.toMatchObject({code:"source_policy_changed"});
    await updatePublisher(db(),"publisher:example.com",{archived:false});
    expect((await getRankingSnapshots(db(),10))[0].entries).toEqual(historical[0].entries);
  });
  it("rejects mid-run blocks in citations and insight citations before publishing",async()=>{
    const {runnerId,claim,jobId}=await leased();
    await updatePublisher(db(),await publisher(),{blocked:true});
    for(const result of [{summary:"Summary",citations:[{title:"Evidence",url:"https://example.com/article"}]},{summary:"Summary",insights:[{subject:"Player",finding:"Evidence-backed finding",citationUrls:["https://example.com/article"]}]}]) {
      const parsed=completeResearchJobInput.parse({runnerId,leaseToken:claim.leaseToken,resultId:crypto.randomUUID(),result});
      await expect(completeResearchJob(db(),jobId,parsed)).rejects.toMatchObject({code:"source_policy_changed"});
    }
    expect(await env.DB.prepare("SELECT status,result_json FROM research_jobs WHERE id=?").bind(jobId).first()).toEqual({status:"running",result_json:null});
    await updatePublisher(db(),"publisher:example.com",{blocked:false});
    const result=await completeResearchJob(db(),jobId,completeResearchJobInput.parse({runnerId,leaseToken:claim.leaseToken,resultId:crypto.randomUUID(),result:{summary:"Allowed research",citations:[{title:"Evidence",url:"https://example.com/article"}]}}));
    expect(result.job.status).toBe("completed");
  });
  it("rejects blocked ranking and sleeper evidence even when summary citations omit it",async()=>{
    await updatePublisher(db(),await publisher(),{blocked:true});
    await expect(createRankingSnapshot(db(),board("https://example.com/board"))).rejects.toMatchObject({code:"source_policy_changed"});
    const run=await leased("sleepers_research");
    const report=sleeperReportInput.parse({summary:"Sleeper summary",positionSummaries:{QB:"QB",RB:"RB",WR:"WR",TE:"TE"},candidates:["QB","RB","WR","TE"].map(position=>({playerName:`Test ${position}`,position,team:null,recommendedPickStart:100,recommendedPickEnd:120,summary:"Good value",upside:null,risk:null,sources:[{publisher:"Example",title:"Sleepers",url:"https://example.com/sleepers",publishedAt:null,recommendation:null}]}))});
    await expect(completeResearchJob(db(),run.jobId,completeResearchJobInput.parse({runnerId:run.runnerId,leaseToken:run.claim.leaseToken,resultId:crypto.randomUUID(),result:{summary:report.summary,sleeperReport:report}}))).rejects.toMatchObject({code:"source_policy_changed"});
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM sleeper_reports").first()).toEqual({count:0});
  });
  it("atomically rejects a policy change between validation and final publication",async()=>{
    const id=await publisher();
    const run=await leased();
    const actual=db();
    let changed=false;
    const client=new Proxy(actual.$client,{get(target,key){
      if(key!=="prepare") { const value=Reflect.get(target,key); return typeof value==="function" ? value.bind(target) : value; }
      return (sql:string)=>{
        const statement=target.prepare(sql);
        if(!sql.includes("UPDATE research_jobs SET status = 'completed'")) return statement;
        return {bind(...values:unknown[]) {const bound=statement.bind(...values);return {async run(){changed=true;await updatePublisher(actual,id,{blocked:true});return bound.run();}};}};
      };
    }});
    const guarded=new Proxy(actual,{get(target,key){return key==="$client" ? client : Reflect.get(target,key);}});
    await expect(completeResearchJob(guarded,run.jobId,completeResearchJobInput.parse({runnerId:run.runnerId,leaseToken:run.claim.leaseToken,resultId:crypto.randomUUID(),result:{summary:"Research validated before publisher was blocked",citations:[{title:"Evidence",url:"https://example.com/board"}]}}))).rejects.toMatchObject({code:"source_policy_changed"});
    expect(changed).toBe(true);
    expect(await env.DB.prepare("SELECT status,result_json FROM research_jobs WHERE id=?").bind(run.jobId).first()).toEqual({status:"running",result_json:null});
  });
  it("does not invalidate publication for metadata, archive, or no-op blocked edits",async()=>{
    const id=await publisher();
    const initial=(await getPublisherPolicy(db())).version;
    const run=await leased();
    const actual=db();
    let edited=false;
    const client=new Proxy(actual.$client,{get(target,key){
      if(key!=="prepare") {const value=Reflect.get(target,key);return typeof value==="function" ? value.bind(target) : value;}
      return (sql:string)=>{
        const statement=target.prepare(sql);
        if(!sql.includes("UPDATE research_jobs SET status = 'completed'")) return statement;
        return {bind(...values:unknown[]) {const bound=statement.bind(...values);return {async run(){
          edited=true;
          await updatePublisher(actual,id,{name:"Updated label",notes:"Owner notes",tags:["trusted"],archived:true,blocked:false});
          return bound.run();
        }};}};
      };
    }});
    const guarded=new Proxy(actual,{get(target,key){return key==="$client" ? client : Reflect.get(target,key);}});
    const completed=await completeResearchJob(guarded,run.jobId,completeResearchJobInput.parse({runnerId:run.runnerId,leaseToken:run.claim.leaseToken,resultId:crypto.randomUUID(),result:{summary:"Research remains valid during publisher organization",citations:[{title:"Evidence",url:"https://example.com/board"}]}}));
    expect(edited).toBe(true);
    expect(completed.job.status).toBe("completed");
    expect((await getPublisherPolicy(db())).version).toBe(initial);
    await updatePublisher(db(),id,{blocked:true});
    expect((await getPublisherPolicy(db())).version).toBe(initial+1);
    await updatePublisher(db(),id,{blocked:true,notes:"Same block remains in place"});
    expect((await getPublisherPolicy(db())).version).toBe(initial+1);
    await updatePublisher(db(),id,{blocked:false});
    expect((await getPublisherPolicy(db())).version).toBe(initial+2);
  });
  it("filters latest sleeper counts per user while historical evidence stays immutable",async()=>{
    const run=await leased("sleepers_research");
    const report=sleeperReportInput.parse({summary:"Original summary",positionSummaries:{QB:"QB",RB:"RB",WR:"WR",TE:"TE"},candidates:["QB","RB","WR","TE"].map(position=>({playerName:`Test ${position}`,position,team:null,recommendedPickStart:100,recommendedPickEnd:120,summary:"Good value",upside:null,risk:null,sources:["example.com","second.com","third.com"].map(domain=>({publisher:domain,title:"Sleepers",url:`https://${domain}/sleepers`,publishedAt:null,recommendation:null}))}))});
    const reportId=await persistSleeperReport(db(),{jobId:run.jobId,season:"2026",scoringFormat:"ppr",rankingType:"redraft",leagueSize:12,sleepersPerPosition:8,discoverNewSources:false,knownSourceDomains:[],generatedAt:"2026-09-01T12:00:00Z",report});
    await publishSleeperReport(db(),reportId);
    await updatePublisher(db(),"publisher:example.com",{blocked:true});
    await updatePublisher(db(),"publisher:third.com",{blocked:true});
    await savePublisherPreferences(db(),"publisher:second.com","reader-b",{excluded:true});
    expect((await getLatestSleeperReport(db(),12))?.positions.QB).toMatchObject([{sourceCount:1,sources:[{publisher:"second.com"}]}]);
    expect((await getLatestSleeperReport(db(),12,"reader-b"))?.positions.QB).toHaveLength(0);
    const history=await getSleeperReports(db(),50,run.jobId,12,"reader-b");
    expect(history[0].positions.QB).toMatchObject([{sourceCount:3,sources:[{publisher:"example.com",blocked:true},{publisher:"second.com",excluded:true},{publisher:"third.com",blocked:true}]}]);
    expect(history[0].summary).toBe("Original summary");
  });
  it("bounds publisher instructions and declares truncated policies honestly",async()=>{
    for(let index=0;index<20;index++) await updatePublisher(db(),await publisher(`lengthy-publisher-${index}.example.com`),{blocked:true});
    const policy=await getPublisherPolicy(db());
    expect(publisherPolicyInstructions(policy)).toContain("partial list");
    const run=await leased("rankings_research");
    expect(run.claim.executionContext.length).toBeLessThanOrEqual(2000);
    expect(run.claim.executionContext).toContain("blocked hosts");
    expect(run.claim.executionContext).toContain("partial list");
  });
});
