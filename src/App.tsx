import {
  Bot,
  ChevronRight,
  ClipboardList,
  Clock3,
  Cloud,
  ExternalLink,
  LayoutDashboard,
  Newspaper,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Telescope,
  TableProperties,
  TrendingUp,
  Trophy,
  Users,
} from "lucide-react";
import type { ComponentType } from "react";
import { NavLink, Route, Routes } from "react-router";
import { lineup, movers, news } from "./data";
import RankingsPage from "./features/rankings/RankingsPage";
import ResearchDeskPage from "./features/research/ResearchDeskPage";
import SleepersPage from "./features/sleepers/SleepersPage";

type Icon = ComponentType<{ size?: number; strokeWidth?: number }>;

const navigation: Array<{ label: string; path: string; icon: Icon }> = [
  { label: "Huddle", path: "/", icon: LayoutDashboard },
  { label: "My Team", path: "/team", icon: Users },
  { label: "Players", path: "/players", icon: Search },
  { label: "Rankings", path: "/rankings", icon: Trophy },
  { label: "Sleepers", path: "/sleepers", icon: Telescope },
  { label: "Draft Board", path: "/draft", icon: ClipboardList },
  { label: "Research Desk", path: "/research", icon: Bot },
];

function PotatoMark() {
  return (
    <div className="potato-mark" aria-hidden="true">
      <span className="potato-mark__helmet" />
      <span className="potato-mark__eye potato-mark__eye--left" />
      <span className="potato-mark__eye potato-mark__eye--right" />
    </div>
  );
}

function Brand() {
  return (
    <div className="brand">
      <PotatoMark />
      <div>
        <strong>Sloppy Potato</strong>
        <span>Fantasy Football</span>
        <small>Potato Bowl After Dark</small>
      </div>
    </div>
  );
}

function NavItems({ mobile = false }: { mobile?: boolean }) {
  return navigation.map(({ label, path, icon: NavIcon }) => (
    <NavLink
      aria-label={label}
      className={({ isActive }) =>
        `${mobile ? "mobile-nav__item" : "sidebar__link"}${isActive ? " is-active" : ""}`
      }
      end={path === "/"}
      key={path}
      to={path}
    >
      <NavIcon size={mobile ? 17 : 18} strokeWidth={1.8} />
      <span>{label}</span>
    </NavLink>
  ));
}

function Sidebar() {
  return (
    <aside className="sidebar">
      <Brand />
      <nav aria-label="Primary navigation">
        <NavItems />
      </nav>
      <div className="sidebar__footer">
        <div className="avatar">RS</div>
        <div>
          <strong>Ryan S.</strong>
          <span>Commissioner</span>
        </div>
      </div>
    </aside>
  );
}

function MobileHeader() {
  return (
    <header className="mobile-header">
      <div className="mobile-brand">
        <PotatoMark />
        <div>
          <strong>SPFF</strong>
          <span>After Dark</span>
        </div>
      </div>
      <button className="icon-button" aria-label="Sync league">
        <RefreshCw size={17} />
      </button>
    </header>
  );
}

function AppShell() {
  return (
    <div className="app-shell">
      <Sidebar />
      <MobileHeader />
      <main className="main-content">
        <Routes>
          <Route index element={<Huddle />} />
          <Route path="team" element={<ComingSoon title="My Team" icon={Users} />} />
          <Route path="players" element={<ComingSoon title="Players" icon={Search} />} />
          <Route path="rankings" element={<RankingsPage />} />
          <Route path="sleepers" element={<SleepersPage />} />
          <Route path="draft" element={<ComingSoon title="Draft Board" icon={ClipboardList} />} />
          <Route path="research" element={<ResearchDeskPage />} />
        </Routes>
      </main>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        <NavItems mobile />
      </nav>
    </div>
  );
}

function Huddle() {
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Tuesday, September 1 · Week 1</p>
          <h1>Welcome back, Coach.</h1>
          <p className="page-header__copy">Your lineup is strong. One injury needs attention before kickoff.</p>
        </div>
        <div className="page-header__actions">
          <span className="badge badge--amber">PPR Redraft</span>
          <button className="button button--secondary">
            <RefreshCw size={16} /> Sync Sleeper
          </button>
        </div>
      </header>

      <section className="status-strip" aria-label="League status">
        <StatusItem icon={Cloud} label="Sleeper" value="Synced 6 min ago" tone="good" />
        <StatusItem icon={ShieldCheck} label="Lineup" value="1 player to watch" tone="warning" />
        <StatusItem icon={TrendingUp} label="Projection" value="118.4 points" />
        <StatusItem icon={Bot} label="Research runner" value="Local runner ready" tone="good" />
      </section>

      <div className="dashboard-grid">
        <section className="panel lineup-panel">
          <PanelHeader
            eyebrow="Mash Potato Mafia"
            title="My Starting Lineup"
            action="Open team"
          />
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Slot</th>
                  <th>Player</th>
                  <th>Matchup</th>
                  <th>Proj.</th>
                  <th>Consensus</th>
                </tr>
              </thead>
              <tbody>
                {lineup.map((player) => (
                  <tr key={`${player.slot}-${player.name}`}>
                    <td><span className="position-chip">{player.slot}</span></td>
                    <td>
                      <div className="player-cell">
                        <strong>{player.name}</strong>
                        <span>{player.team} {player.note && <em>{player.note}</em>}</span>
                      </div>
                    </td>
                    <td>{player.opponent}</td>
                    <td className="number-cell">{player.projection.toFixed(1)}</td>
                    <td><span className="rank-chip">{player.rank}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="projection-bar">
            <div>
              <span>Projected total</span>
              <strong>118.4</strong>
            </div>
            <div className="meter" aria-label="Projected total: 118.4 points">
              <span style={{ width: "72%" }} />
            </div>
            <small>+6.8 vs opponent</small>
          </div>
        </section>

        <aside className="side-stack">
          <section className="panel compact-panel">
            <PanelHeader eyebrow="Consensus" title="Rank Movers" action="All rankings" />
            <div className="movers-list">
              {movers.map((mover) => (
                <div className="mover" key={mover.name}>
                  <div className="player-dot">{mover.position}</div>
                  <div>
                    <strong>{mover.name}</strong>
                    <span>{mover.rank}</span>
                  </div>
                  <b className={mover.movement.startsWith("+") ? "positive" : "negative"}>
                    {mover.movement}
                  </b>
                </div>
              ))}
            </div>
          </section>

          <section className="panel compact-panel research-callout">
            <div className="research-callout__icon"><Sparkles size={20} /></div>
            <p className="eyebrow">Research Desk</p>
            <h2>Resolve the CMC risk.</h2>
            <p>Compare credible practice reports and explain the best pivot from your bench.</p>
            <button className="button button--primary">Research this <ChevronRight size={16} /></button>
            <small>Uses your local subscription runner · confirmation required</small>
          </section>
        </aside>

        <section className="panel news-panel">
          <PanelHeader eyebrow="Prioritized for your roster" title="Tater Wire" action="Open all news" />
          <div className="news-list">
            {news.map((item) => (
              <article className="news-card" key={item.player}>
                <div className="news-card__meta">
                  <span className="badge badge--dark">{item.severity}</span>
                  <span><Clock3 size={13} /> {item.time}</span>
                </div>
                <h3>{item.player}</h3>
                <p>{item.headline}</p>
                <footer>
                  <span>{item.source}</span>
                  <button aria-label={`Open ${item.player} source`} className="text-button">
                    Open source <ExternalLink size={13} />
                  </button>
                </footer>
              </article>
            ))}
          </div>
        </section>

        <section className="panel quick-actions">
          <PanelHeader eyebrow="Get moving" title="Quick Actions" />
          <div className="action-grid">
            <QuickAction icon={Search} title="Scout a player" copy="News, ranks, usage, and schedule" />
            <QuickAction icon={TableProperties} title="Build cheat sheet" copy="Consensus tiers shaped to your roster" />
            <QuickAction icon={Newspaper} title="Roster news" copy="Only updates that affect your team" />
          </div>
        </section>
      </div>

      <footer className="data-footer">
        <span><Cloud size={14} /> Sleeper data: 6 min ago</span>
        <span>Rankings: 14 sources · 41 min ago</span>
        <span>News checked: 9:34 AM CT</span>
      </footer>
    </div>
  );
}

function StatusItem({ icon: StatusIcon, label, value, tone }: {
  icon: Icon;
  label: string;
  value: string;
  tone?: "good" | "warning";
}) {
  return (
    <div className="status-item">
      <StatusIcon size={18} />
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
      <i className={`status-dot${tone ? ` status-dot--${tone}` : ""}`} />
    </div>
  );
}

function PanelHeader({ eyebrow, title, action }: { eyebrow: string; title: string; action?: string }) {
  return (
    <header className="panel-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
      </div>
      {action && <button className="text-button">{action} <ChevronRight size={14} /></button>}
    </header>
  );
}

function QuickAction({ icon: ActionIcon, title, copy }: { icon: Icon; title: string; copy: string }) {
  return (
    <button className="quick-action">
      <ActionIcon size={19} />
      <span><strong>{title}</strong><small>{copy}</small></span>
      <ChevronRight size={16} />
    </button>
  );
}

function ComingSoon({ title, icon: PageIcon }: { title: string; icon: Icon }) {
  return (
    <div className="page placeholder-page">
      <p className="eyebrow">Dark Draft product system</p>
      <div className="placeholder-page__icon"><PageIcon size={28} /></div>
      <h1>{title}</h1>
      <p>The route and responsive shell are ready. This screen is the next implementation slice from the approved pen.dev system.</p>
      <NavLink className="button button--primary" to="/">Return to Huddle</NavLink>
    </div>
  );
}

export default function App() {
  return <AppShell />;
}
