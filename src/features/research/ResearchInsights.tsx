import { Bookmark, ExternalLink, Search } from "lucide-react";
import { useId, useMemo, useState } from "react";
import type { ResearchJob, ResearchResult } from "./research-api";

export const INSIGHT_BOOKMARKS_KEY = "spff:research-report-bookmarks:v1";
const PAGE_SIZE = 6;
type Confidence = "all" | "high" | "medium" | "low" | "unrated";
type CompletedReport = ResearchJob & { result: ResearchResult };

function readBookmarks(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(INSIGHT_BOOKMARKS_KEY) ?? "[]");
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function safeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function titleFor(job: ResearchJob): string {
  return job.subject || job.sourceName || ({
    player_research: "Player research",
    rankings_research: "Rankings research",
    sleepers_research: "Sleeper research",
    source_refresh: "Source refresh",
  }[job.type]);
}

function generatedTime(report: CompletedReport): number {
  return Date.parse(report.result.generatedAt || report.completedAt || report.updatedAt) || 0;
}

function SourceLink({ url, title }: { url: string; title?: string }) {
  const href = safeUrl(url);
  if (!href) return null;
  return <a href={href} target="_blank" rel="noopener noreferrer">
    {title || new URL(href).hostname.replace(/^www\./, "")} <ExternalLink size={12} aria-hidden="true" />
  </a>;
}

function ReportCard({ report, findings, bookmarked, onBookmark, expand }: {
  report: CompletedReport;
  findings: ResearchResult["insights"];
  bookmarked: boolean;
  onBookmark: () => void;
  expand: boolean;
}) {
  const [findingLimit, setFindingLimit] = useState(5);
  const title = titleFor(report);
  const generatedAt = generatedTime(report);
  const sources = report.result.citations.filter((source, index, all) => safeUrl(source.url)
    && all.findIndex((candidate) => safeUrl(candidate.url) === safeUrl(source.url)) === index);

  return <article className="insight-report" aria-label={title}>
    <div className="insight-report-heading">
      <h3>{title}</h3>
      <button className="button insight-bookmark" type="button" aria-pressed={bookmarked}
        aria-label={`${bookmarked ? "Unsave" : "Save"} report: ${title}`} onClick={onBookmark}>
        <Bookmark size={15} fill={bookmarked ? "currentColor" : "none"} aria-hidden="true" />
        {bookmarked ? "Saved" : "Save"}
      </button>
    </div>
    <div className="insight-report-meta">
      <span>{report.leagueSize ? `${report.leagueSize}-team` : "League size unspecified"} · {report.scoringFormat.toUpperCase()} · {report.rankingType}</span>
      <span>{report.position && report.position !== "ALL" ? report.position : "All positions"}</span>
      {generatedAt > 0 && <time dateTime={new Date(generatedAt).toISOString()}>
        {new Date(generatedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
      </time>}
    </div>
    <p className="insight-report-preview">{report.result.summary.length > 220
      ? `${report.result.summary.slice(0, 220).trimEnd()}…` : report.result.summary}</p>
    <details className="insight-report-details" open={expand || undefined}>
      <summary>Report details · {findings.length} {findings.length === 1 ? "finding" : "findings"} · {sources.length} {sources.length === 1 ? "source" : "sources"}</summary>
      {report.result.summary.length > 220 && <p className="insight-report-summary">{report.result.summary}</p>}
      <ul className="insight-findings">
        {findings.slice(0, findingLimit).map((finding, index) => <li className="insight-finding" key={`${finding.subject}-${index}`}>
          <div className="insight-finding-heading">
            <h4>{finding.subject}</h4>
            <span className="insight-confidence" data-confidence={finding.confidence ?? "unrated"}>
              {finding.confidence ? `${finding.confidence} confidence` : "Confidence not rated"}
            </span>
          </div>
          <p>{finding.finding}</p>
          <div className="insight-citations">
            {[...new Set(finding.citationUrls)].map((url) => <SourceLink key={url} url={url}
              title={sources.find((source) => safeUrl(source.url) === safeUrl(url))?.title} />)}
          </div>
        </li>)}
      </ul>
      {findingLimit < findings.length && <button className="button" type="button"
        onClick={() => setFindingLimit((limit) => limit + 10)}>Show more findings ({findings.length - findingLimit} remaining)</button>}
      {sources.length > 0 && <div className="insight-sources">
        <h4>Report sources</h4>
        <ul>{sources.map((source) => <li key={source.url}>
          <SourceLink url={source.url} title={source.title} />
          {source.publisher && <span> · {source.publisher}</span>}
        </li>)}</ul>
      </div>}
      {sources.length === 0 && <p className="insight-report-meta">No valid source links were returned for this report.</p>}
    </details>
  </article>;
}

export default function ResearchInsights({ jobs, leagueSize }: { jobs: ResearchJob[]; leagueSize: number }) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [confidence, setConfidence] = useState<Confidence>("all");
  const [savedOnly, setSavedOnly] = useState(false);
  const [currentLeagueOnly, setCurrentLeagueOnly] = useState(true);
  const [bookmarks, setBookmarks] = useState(readBookmarks);
  const [storageWarning, setStorageWarning] = useState(false);
  const [reportLimit, setReportLimit] = useState(PAGE_SIZE);
  const search = query.trim().toLocaleLowerCase();
  const reports = useMemo(() => jobs.filter((job): job is CompletedReport => job.status === "completed" && !!job.result)
    .sort((a, b) => generatedTime(b) - generatedTime(a)), [jobs]);
  const matches = useMemo(() => reports.flatMap((report) => {
    // Legacy reports without league size remain visible and explicitly labeled.
    if (currentLeagueOnly && report.leagueSize && report.leagueSize !== leagueSize) return [];
    if (savedOnly && !bookmarks.includes(report.id)) return [];
    const reportMatch = [titleFor(report), report.result.summary, ...report.result.citations.flatMap((source) => [source.title, source.publisher ?? ""])]
      .some((value) => value.toLocaleLowerCase().includes(search));
    const findings = report.result.insights.filter((finding) =>
      (confidence === "all" || (finding.confidence ?? "unrated") === confidence)
      && (!search || reportMatch || `${finding.subject} ${finding.finding}`.toLocaleLowerCase().includes(search)));
    if (confidence !== "all" && findings.length === 0) return [];
    if (search && !reportMatch && findings.length === 0) return [];
    return [{ report, findings }];
  }), [reports, currentLeagueOnly, leagueSize, savedOnly, bookmarks, confidence, search]);

  function toggleBookmark(reportId: string) {
    const next = bookmarks.includes(reportId) ? bookmarks.filter((id) => id !== reportId) : [...bookmarks, reportId];
    setBookmarks(next);
    try {
      localStorage.setItem(INSIGHT_BOOKMARKS_KEY, JSON.stringify(next));
      setStorageWarning(false);
    } catch {
      setStorageWarning(true);
    }
  }

  function resetFilters() {
    setQuery(""); setConfidence("all"); setSavedOnly(false); setCurrentLeagueOnly(true); setReportLimit(PAGE_SIZE);
  }

  return <section className="panel research-insights" aria-labelledby={`${id}-heading`}>
    <div className="research-insights-header">
      <div><h2 id={`${id}-heading`}>Research insights</h2><p>Bookmarks are saved on this browser. Increase History in the Job Queue to load older reports.</p></div>
    </div>
    <div className="research-insights-toolbar">
      <label htmlFor={`${id}-search`}><span>Search insights</span><Search size={15} aria-hidden="true" />
        <input id={`${id}-search`} type="search" placeholder="Player, finding, or source" value={query}
          onChange={(event) => { setQuery(event.target.value); setReportLimit(PAGE_SIZE); }} /></label>
      <label htmlFor={`${id}-confidence`}>Confidence
        <select id={`${id}-confidence`} value={confidence} onChange={(event) => { setConfidence(event.target.value as Confidence); setReportLimit(PAGE_SIZE); }}>
          <option value="all">All confidence levels</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option><option value="unrated">Not rated</option>
        </select>
      </label>
      <label><input type="checkbox" checked={savedOnly} onChange={(event) => { setSavedOnly(event.target.checked); setReportLimit(PAGE_SIZE); }} />Saved only</label>
      <label><input type="checkbox" checked={currentLeagueOnly} onChange={(event) => { setCurrentLeagueOnly(event.target.checked); setReportLimit(PAGE_SIZE); }} />{leagueSize}-team reports</label>
      {(query || confidence !== "all" || savedOnly || !currentLeagueOnly) && <button className="button" type="button" onClick={resetFilters}>Reset insight filters</button>}
    </div>
    {storageWarning && <p className="insight-storage-warning" role="status">Browser storage is unavailable. Saves will last until this page closes.</p>}
    <p className="research-insights-status" role="status">Showing {Math.min(reportLimit, matches.length)} of {matches.length} matching {matches.length === 1 ? "report" : "reports"} from loaded research history.</p>
    <div className="research-insights-list">
      {matches.slice(0, reportLimit).map(({ report, findings }) => <ReportCard key={report.id} report={report} findings={findings}
        bookmarked={bookmarks.includes(report.id)} onBookmark={() => toggleBookmark(report.id)} expand={!!search || confidence !== "all"} />)}
    </div>
    {matches.length === 0 && <p className="research-insights-empty">{reports.length === 0
      ? "Completed research reports will appear here with findings and source links."
      : "No reports match these filters. Try a different search or include other league sizes."}</p>}
    {reportLimit < matches.length && <button className="button research-insights-more" type="button"
      onClick={() => setReportLimit((limit) => limit + PAGE_SIZE)}>Show more reports ({matches.length - reportLimit} remaining)</button>}
  </section>;
}
