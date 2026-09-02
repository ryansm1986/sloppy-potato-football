import {
  AlertCircle,
  Bot,
  CheckCircle2,
  ChevronRight,
  Clock3,
  ExternalLink,
  KeyRound,
  Lightbulb,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Target,
  Telescope,
  TrendingUp,
} from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import {
  isLocalDevelopment,
  RESEARCH_OWNER_TOKEN_KEY,
} from "../research/research-api";
import {
  fetchLatestSleeperReport,
  requestSleeperResearch,
  SLEEPER_POSITIONS,
  type SleeperCandidate,
  type SleeperPosition,
  type SleeperReport,
} from "./sleepers-api";

function loadOwnerToken(): string {
  return window.localStorage.getItem(RESEARCH_OWNER_TOKEN_KEY) ?? "";
}

function formatFreshness(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Date unavailable";
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return "Updated just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  return `Updated ${new Date(timestamp).toLocaleDateString()}`;
}

function roundLabel(candidate: SleeperCandidate): string {
  const { recommendedRoundStart: start, recommendedRoundEnd: end } = candidate;
  return start === end ? `Round ${start}` : `Rounds ${start}\u2013${end}`;
}

function pickLabel(candidate: SleeperCandidate): string {
  const { recommendedPickStart: start, recommendedPickEnd: end } = candidate;
  return start === end ? `Pick ${start}` : `Picks ${start}\u2013${end}`;
}

function CandidateCard({ candidate, rank }: { candidate: SleeperCandidate; rank: number }) {
  const sourceWord = candidate.sourceCount === 1 ? "source" : "sources";
  return (
    <article className="sleeper-card">
      <div className="sleeper-card__rank" aria-label={`Rank ${rank}`}>
        <span>#</span>{rank}
      </div>
      <div className="sleeper-card__body">
        <header className="sleeper-card__header">
          <div className="sleeper-card__identity">
            <span className="position-orb">{candidate.position}</span>
            <div>
              <h3>{candidate.playerName}</h3>
              <span>{candidate.team ?? "Team TBD"}</span>
            </div>
          </div>
          <div className="sleeper-consensus" title="Independent recommending sources">
            <strong>{candidate.sourceCount}</strong>
            <span>{sourceWord}<br />recommend</span>
          </div>
        </header>

        <div className="sleeper-draft-window" aria-label={`${roundLabel(candidate)}, ${pickLabel(candidate)}`}>
          <Target size={16} />
          <div><span>Draft window</span><strong>{roundLabel(candidate)}</strong></div>
          <i />
          <div><span>Overall range</span><strong>{pickLabel(candidate)}</strong></div>
        </div>

        <p className="sleeper-card__summary">{candidate.summary}</p>

        <details className="sleeper-details">
          <summary>Scouting notes and {candidate.sources.length} source {candidate.sources.length === 1 ? "link" : "links"}<ChevronRight size={14} /></summary>
          <div className="sleeper-details__content">
            {(candidate.upside || candidate.risk) && (
              <div className="sleeper-notes">
                {candidate.upside && <p><TrendingUp size={14} /><span><strong>Upside</strong>{candidate.upside}</span></p>}
                {candidate.risk && <p><AlertCircle size={14} /><span><strong>Risk</strong>{candidate.risk}</span></p>}
              </div>
            )}
            <div className="sleeper-sources">
              <h4>Recommendation evidence</h4>
              {candidate.sources.map((source) => (
                <a href={source.url} target="_blank" rel="noreferrer" key={`${source.url}-${source.title}`}>
                  <ExternalLink size={13} />
                  <span>
                    <strong>{source.publisher}</strong>
                    <small>{source.title}{source.publishedAt ? ` \u00b7 ${new Date(source.publishedAt).toLocaleDateString()}` : ""}</small>
                    {source.recommendation && <em>{source.recommendation}</em>}
                  </span>
                </a>
              ))}
            </div>
          </div>
        </details>
      </div>
    </article>
  );
}

export default function SleepersPage({ localDevelopmentOverride }: { localDevelopmentOverride?: boolean } = {}) {
  const localDevelopment = localDevelopmentOverride ?? isLocalDevelopment();
  const [activePosition, setActivePosition] = useState<SleeperPosition>("QB");
  const [report, setReport] = useState<SleeperReport | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [leagueSize, setLeagueSize] = useState(12);
  const [sleepersPerPosition, setSleepersPerPosition] = useState(8);
  const [pollBaseline, setPollBaseline] = useState<{ id: string | null; generatedAt: number } | null>(null);
  const tabRefs = useRef<Partial<Record<SleeperPosition, HTMLButtonElement | null>>>({});
  const ownerToken = loadOwnerToken();
  const ownerReady = localDevelopment || Boolean(ownerToken);

  const loadReport = useCallback(async (signal?: AbortSignal) => {
    setIsLoading(true);
    try {
      setReport(await fetchLatestSleeperReport(signal));
      setLoadError(null);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setLoadError(error instanceof Error ? error.message : "Could not load sleeper research.");
    } finally {
      if (!signal?.aborted) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadReport(controller.signal);
    return () => controller.abort();
  }, [loadReport]);

  useEffect(() => {
    if (!pollBaseline) return;
    const controller = new AbortController();
    let attempts = 0;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      attempts += 1;
      try {
        const latest = await fetchLatestSleeperReport(controller.signal);
        const latestTime = latest ? Date.parse(latest.generatedAt) : Number.NaN;
        const isNewer = Boolean(latest) && (
          latest!.id !== pollBaseline.id
          || (Number.isFinite(latestTime) && latestTime > pollBaseline.generatedAt)
        );
        if (isNewer) {
          setReport(latest);
          setLoadError(null);
          setPollBaseline(null);
          setNotice("Sleeper board updated with the completed research report.");
        } else if (attempts >= 24) {
          setPollBaseline(null);
          setNotice("Research is still running. The current board remains available; refresh this page later for the new report.");
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError") && attempts >= 24) {
          setPollBaseline(null);
          setNotice("Automatic report checking ended. Refresh the page later to check for completed research.");
        }
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 5_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [pollBaseline]);

  const candidates = useMemo(
    () => [...(report?.positions[activePosition] ?? [])].sort((left, right) =>
      right.sourceCount - left.sourceCount
      || left.recommendedPickStart - right.recommendedPickStart
      || left.playerName.localeCompare(right.playerName),
    ),
    [activePosition, report],
  );

  function movePositionTab(event: KeyboardEvent<HTMLButtonElement>, position: SleeperPosition) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const currentIndex = SLEEPER_POSITIONS.indexOf(position);
    const offset = event.key === "ArrowRight" ? 1 : -1;
    const nextPosition = SLEEPER_POSITIONS[(currentIndex + offset + SLEEPER_POSITIONS.length) % SLEEPER_POSITIONS.length];
    setActivePosition(nextPosition);
    tabRefs.current[nextPosition]?.focus();
  }

  async function refreshResearch() {
    if (!ownerReady || isSubmitting) return;
    setIsSubmitting(true);
    setNotice(null);
    try {
      await requestSleeperResearch(ownerToken, leagueSize, sleepersPerPosition);
      setNotice("Sleeper research queued. Results will publish here when your runner finishes.");
      setPollBaseline({
        id: report?.id ?? null,
        generatedAt: report && Number.isFinite(Date.parse(report.generatedAt)) ? Date.parse(report.generatedAt) : 0,
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not queue sleeper research.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="page sleepers-page">
      <header className="page-header sleepers-hero">
        <div>
          <p className="eyebrow">Consensus opportunity finder</p>
          <h1>Sleeper Lab</h1>
          <p className="page-header__copy">Independent recommendations, draft cost, and source evidence&mdash;ranked by how often trusted analysts make the case.</p>
        </div>
        {report && <span className="badge badge--amber">{report.scoringFormat.toUpperCase()} {report.rankingType} &middot; {report.leagueSize} teams</span>}
      </header>

      <section className="panel sleeper-research-status">
        <div className="sleeper-research-status__summary">
          <div className="research-callout__icon"><Telescope size={19} /></div>
          <div>
            <p className="eyebrow">Latest agent report</p>
            <h2>{report ? `${report.season} sleeper board` : "Build the first sleeper board"}</h2>
            <p>{report?.summary ?? "Queue a sourced scan across QB, RB, WR, and TE. Completed reports are readable by everyone you share the app with."}</p>
          </div>
        </div>
        <div className="sleeper-research-status__meta">
          <span><Clock3 size={13} /> {report ? formatFreshness(report.createdAt ?? report.generatedAt) : "No report yet"}</span>
          <span><ShieldCheck size={13} /> Refresh is owner-controlled</span>
        </div>
      </section>

      <div className="sleepers-layout">
        <main className="panel sleeper-board">
          <div className="sleeper-tabs" role="tablist" aria-label="Sleeper positions">
            {SLEEPER_POSITIONS.map((position) => (
              <button
                aria-label={`${position} ${report?.positions[position]?.length ?? 0} sleepers`}
                aria-controls="sleeper-position-panel"
                aria-selected={activePosition === position}
                className={activePosition === position ? "is-active" : ""}
                id={`sleeper-tab-${position}`}
                key={position}
                onClick={() => setActivePosition(position)}
                onKeyDown={(event) => movePositionTab(event, position)}
                ref={(element) => { tabRefs.current[position] = element; }}
                role="tab"
                tabIndex={activePosition === position ? 0 : -1}
                type="button"
              >
                <span>{position}</span>
                <small>{report?.positions[position]?.length ?? 0}</small>
              </button>
            ))}
          </div>

          <section className="sleeper-tabpanel" id="sleeper-position-panel" role="tabpanel" aria-labelledby={`sleeper-tab-${activePosition}`} tabIndex={0}>
            <div className="sleeper-board__heading">
              <div><p className="eyebrow">Ranked by source recommendations</p><h2>{activePosition} sleepers</h2></div>
              {report && <span>{candidates.length} researched players</span>}
            </div>
            {report?.positionSummaries?.[activePosition] && <p className="sleeper-position-summary">{report.positionSummaries[activePosition]}</p>}

            {isLoading ? (
              <div className="sleeper-state"><LoaderCircle className="spin" size={24} /><h3>Loading sleeper board</h3><p>Checking the latest published research.</p></div>
            ) : loadError ? (
              <div className="sleeper-state sleeper-state--error"><AlertCircle size={24} /><h3>Research unavailable</h3><p>{loadError}</p><button className="button button--secondary" onClick={() => void loadReport()}><RefreshCw size={14} /> Try again</button></div>
            ) : candidates.length === 0 ? (
              <div className="sleeper-state"><Lightbulb size={25} /><h3>No {activePosition} sleepers yet</h3><p>{report ? "This report did not return a player at this position." : "The owner can queue the first multi-source sleeper scan from the research controls."}</p></div>
            ) : (
              <div className="sleeper-list">
                {candidates.map((candidate, index) => <CandidateCard candidate={candidate} rank={index + 1} key={candidate.id} />)}
              </div>
            )}
          </section>
        </main>

        <aside className="sleepers-side">
          <section className="panel sleeper-refresh-card">
            <header><div className="research-callout__icon"><Bot size={18} /></div><div><p className="eyebrow">Owner research control</p><h2>Refresh the board</h2></div></header>
            <p>Send one bounded assignment to your runner for current PPR redraft recommendations and direct source evidence.</p>
            <div className="sleeper-refresh-fields">
              <label><span>League size</span><select aria-label="League size" value={leagueSize} onChange={(event) => setLeagueSize(Number(event.target.value))}><option value={10}>10 teams</option><option value={12}>12 teams</option><option value={14}>14 teams</option></select></label>
              <label><span>Per position</span><select aria-label="Sleepers per position" value={sleepersPerPosition} onChange={(event) => setSleepersPerPosition(Number(event.target.value))}><option value={5}>5 players</option><option value={8}>8 players</option><option value={10}>10 players</option><option value={12}>12 players</option></select></label>
            </div>
            <button className="button button--primary" type="button" disabled={!ownerReady || isSubmitting} onClick={() => void refreshResearch()}>
              {isSubmitting ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} Research sleepers
            </button>
            {!ownerReady && <p className="sleeper-owner-lock"><KeyRound size={13} /> Only the owner can dispatch the local runner. <Link to="/research">Add owner access</Link>.</p>}
            {ownerReady && <small><CheckCircle2 size={12} /> Owner access found on this browser</small>}
            {notice && <p className="research-notice" role="status">{notice}</p>}
          </section>

          <section className="panel sleeper-method-card">
            <p className="eyebrow">How to read this</p>
            <h2>Consensus, not hype</h2>
            <ol>
              <li><strong>Source count</strong><span>Unique publishers recommending the player.</span></li>
              <li><strong>Draft window</strong><span>A practical round and overall-pick target.</span></li>
              <li><strong>Evidence</strong><span>Open every article used by the research agent.</span></li>
            </ol>
          </section>
        </aside>
      </div>
    </div>
  );
}
