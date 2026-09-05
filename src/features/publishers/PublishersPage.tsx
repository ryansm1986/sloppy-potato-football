import { useEffect, useState } from "react";
import { Archive, Ban, ExternalLink, RefreshCw, Star } from "lucide-react";
import { useResearchOwnerAccess } from "../research/useResearchOwnerAccess";
import { isLocalDevelopment } from "../research/research-api";
import { fetchPublishers, savePublisherPreferences, updatePublisher, type Publisher } from "./publishers-api";
import "./publishers.css";

export default function PublishersPage() {
  const { ownerToken, google, isOwner, canRead } = useResearchOwnerAccess();
  const owner = google ? isOwner : isOwner || isLocalDevelopment();
  const personal = google ? canRead : owner;
  const [publishers, setPublishers] = useState<Publisher[]>([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("active");
  const [kind, setKind] = useState("all");
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Publisher | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(() => {
      void fetchPublishers(ownerToken, new URLSearchParams({ search, status, kind }), controller.signal)
        .then((data) => { if (!controller.signal.aborted) { setPublishers(data.publishers); setError(null); } })
        .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load publishers."); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 180);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [ownerToken, search, status, kind, reload]);
  async function change(publisher: Publisher, patch: Partial<Publisher>, global = false) {
    if (busy) return;
    setBusy(publisher.id); setError(null);
    try {
      if (global) await updatePublisher(ownerToken, publisher.id, patch);
      else await savePublisherPreferences(ownerToken, publisher.id, patch);
      setConfirm(null); setReload((value) => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save publisher preferences."); }
    finally { setBusy(null); }
  }
  return <div className="page publishers-page"><header className="page-header"><div><p className="eyebrow">Sources worth following</p><h1>Publishers</h1><p className="page-header__copy">Manage discovered publishers across rankings and sleepers. Favorites and exclusions follow your account.</p></div><button className="button button--secondary" onClick={() => setReload((value) => value + 1)} disabled={loading}><RefreshCw size={16} /> Refresh</button></header>
    <section className="panel publisher-guide"><strong>Your preferences, shared guardrails</strong><p>Favorites help organize sources. Exclude removes a publisher from your current aggregate and sleeper evidence. Owner blocks reject that publisher in future research results; archives hide it from the active catalog. Neither action deletes saved research.</p><small>Research blocks are evidence rules, not a guarantee that an agent will never visit the website. Old reports preserve original provenance.</small></section>
    <section className="panel publisher-library"><div className="publisher-filters"><label>Find a publisher<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name or domain" /></label><label>Status<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="active">Active</option><option value="all">All publishers</option><option value="favorite">Favorites</option><option value="blocked">Blocked</option><option value="archived">Archived</option></select></label><label>Research type<select value={kind} onChange={(event) => setKind(event.target.value)}><option value="all">Rankings & sleepers</option><option value="rankings">Rankings</option><option value="sleepers">Sleepers</option></select></label></div>
      {error && <p className="research-error" role="alert">{error}</p>}{loading && <p className="publisher-empty" role="status">Loading publisher library…</p>}
      {!loading && !publishers.length && !error && <p className="publisher-empty">No publishers match. Complete research to discover publishers, or change the filters.</p>}
      <div className="publisher-list">{publishers.map((publisher) => <article className={`publisher-card${publisher.blocked ? " is-blocked" : ""}`} key={publisher.id}>
        <header><div><h2>{publisher.name}</h2><a href={publisher.url} target="_blank" rel="noreferrer">{publisher.domain} <ExternalLink size={13} /></a></div><div className="publisher-badges">{publisher.blocked && <span>Blocked</span>}{publisher.archived && <span>Archived</span>}{publisher.kinds.map((value) => <span key={value}>{value}</span>)}</div></header>
        <p className="publisher-meta">Last found {new Date(publisher.lastSeenAt).toLocaleDateString()} · {publisher.rankingSourceIds.length} ranking source{publisher.rankingSourceIds.length === 1 ? "" : "s"}</p>
        <div className="publisher-actions"><button className={`button ${publisher.favorite ? "button--primary" : "button--secondary"}`} disabled={!personal || busy !== null} aria-pressed={publisher.favorite} onClick={() => void change(publisher, { favorite: !publisher.favorite })}><Star size={14} />{publisher.favorite ? "Favorited" : "Favorite"}</button><label><input type="checkbox" checked={publisher.excluded} disabled={!personal || busy !== null} onChange={(event) => void change(publisher, { excluded: event.target.checked })} />Exclude from my current results</label>{owner && <><button className="button button--secondary" disabled={busy !== null} onClick={() => publisher.blocked ? void change(publisher, { blocked: false }, true) : setConfirm(publisher)}><Ban size={14} />{publisher.blocked ? "Unblock" : "Block research"}</button><button className="button button--secondary" disabled={busy !== null} onClick={() => void change(publisher, { archived: !publisher.archived }, true)}><Archive size={14} />{publisher.archived ? "Restore" : "Archive"}</button></>}</div>
        {confirm?.id === publisher.id && <div className="publisher-confirm" role="group" aria-label={`Block ${publisher.name}`}><p>Block {publisher.domain} for everyone’s future research? Running jobs returning this publisher may need to be retried. Historical reports remain intact.</p><button className="button button--primary" disabled={busy !== null} onClick={() => void change(publisher, { blocked: true }, true)}>Confirm block</button><button className="button" onClick={() => setConfirm(null)}>Cancel</button></div>}
        <PublisherNotes key={`${publisher.id}:${publisher.notes}:${publisher.tags.join(",")}`} publisher={publisher} owner={owner} busy={busy !== null} onSave={(notes, tags) => void change(publisher, { notes, tags }, true)} />
      </article>)}</div>
    </section>
  </div>;
}
function PublisherNotes({ publisher, owner, busy, onSave }: { publisher: Publisher; owner: boolean; busy: boolean; onSave: (notes: string, tags: string[]) => void }) {
  const [notes, setNotes] = useState(publisher.notes);
  const [tags, setTags] = useState(publisher.tags.join(", "));
  return <details className="publisher-notes"><summary>Notes & tags{publisher.tags.length ? ` · ${publisher.tags.join(", ")}` : ""}</summary>{owner ? <><label>Publisher notes<textarea maxLength={2000} value={notes} onChange={(event) => setNotes(event.target.value)} /></label><label>Tags (comma-separated)<input maxLength={250} value={tags} onChange={(event) => setTags(event.target.value)} /></label><button className="button button--secondary" disabled={busy} onClick={() => onSave(notes, tags.split(",").map((tag) => tag.trim()).filter(Boolean))}>Save notes & tags</button></> : <p>{publisher.notes || "No notes yet."}</p>}</details>;
}
