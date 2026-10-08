import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { ABILITY_LABELS, MODULE_LABELS, type AbilityId, type AdminStats as Stats, type ModuleId } from "@skyteam/shared";
import { useSignedIn } from "../account/Account";
import { AccountFrame, Alert } from "../account/AccountPages";
import { call } from "../account/authApi";
import { useAccount } from "../account/useAccount";
import { RESULT_LABELS, airportName, when } from "../history/format";
import { Link, navigate } from "../router";

/**
 * The statistics dashboard (view_stats): every query in
 * docs/game-log-queries.sql, plus totals and the latest games. Games flown on
 * an earlier game's dice are left out unless the switch counts them.
 */
export default function AdminStats() {
  const user = useSignedIn("/admin");
  const allowed = useAccount((s) => !!s.user?.privileges.includes("view_stats"));
  const managesUsers = useAccount((s) => !!s.user?.privileges.includes("manage_users"));
  const [stats, setStats] = useState<Stats | null>(null);
  const [includeSeeded, setIncludeSeeded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useNoIndex();

  const load = useCallback(async (withSeeded: boolean) => {
    setBusy(true);
    const r = await call<Stats>("GET", `/admin/stats${withSeeded ? "?includeSeeded=1" : ""}`);
    setBusy(false);
    if (r.ok) {
      setStats(r);
      setError(null);
    } else if (r.status === 401) {
      useAccount.getState().setUser(null);
      navigate(`/signin?next=${encodeURIComponent("/admin")}`);
    } else setError(r.error);
  }, []);

  useEffect(() => {
    if (user && allowed) void load(includeSeeded);
  }, [user?.id, allowed, includeSeeded, load]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!user) return null;
  if (!allowed) {
    return (
      <AccountFrame title="Statistics">
        <p className="notice">You don't have access to this.</p>
      </AccountFrame>
    );
  }

  return (
    <main className="center admin-page">
      <header className="admin-head">
        <Link to="/" className="wordmark home-link">
          SKY&middot;TEAM
        </Link>
        <h1 className="page-title">SkyTeam statistics</h1>
        <div className="row admin-tools">
          <label className="switch">
            <input type="checkbox" checked={includeSeeded} onChange={(e) => setIncludeSeeded(e.target.checked)} />
            Include same-dice games ({stats?.seededGames ?? 0})
          </label>
          <button disabled={busy} onClick={() => void load(includeSeeded)}>
            Refresh
          </button>
          {managesUsers && <Link to="/admin/users">Users</Link>}
        </div>
        {stats && <p className="muted">Updated {when(stats.generatedAt)}</p>}
      </header>
      <Alert error={error} />
      {stats && <Dashboard stats={stats} />}
    </main>
  );
}

/** Keep the admin pages out of search engines. */
export function useNoIndex() {
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex";
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);
}

const pct = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)} %`);
const ability = (id: string) => ABILITY_LABELS[id as AbilityId] ?? id;
const moduleName = (id: string) => MODULE_LABELS[id as ModuleId] ?? id;
const seatLabel = (seat: string) => (seat.startsWith("bot:") ? `Bot (${seat.slice(4)})` : "Human");

function Dashboard({ stats }: { stats: Stats }) {
  const games = stats.playRate.reduce((n, r) => n + r.games, 0);
  const finished = stats.playRate.reduce((n, r) => n + r.finished, 0);
  const won = stats.winRateByAirport.reduce((n, r) => n + r.won, 0);
  const winRate = finished ? Math.round((1000 * won) / finished) / 10 : null;
  return (
    <>
      <section className="panel totals" aria-label="Totals">
        <Total value={games} label="games" />
        <Total value={finished} label="finished" />
        <Total value={won} label="won" />
        <Total value={winRate === null ? "—" : `${winRate.toFixed(1)} %`} label="win rate" />
      </section>

      <Section title="Play rate per airport" empty={!stats.playRate.length}>
        <Table head={["Airport", "Games", "Share", "Finished", "Share of finished"]}>
          {stats.playRate.map((r) => (
            <tr key={r.scenario}>
              <td>{airportName(r.scenario)}</td>
              <Num>{r.games}</Num>
              <Bar value={r.pct_of_all_games} />
              <Num>{r.finished}</Num>
              <Bar value={r.pct_of_finished_games} />
            </tr>
          ))}
        </Table>
      </Section>

      <Section title="Win rate per airport" empty={!stats.winRateByAirport.length}>
        <Table head={["Airport", "Finished", "Won", "Lost", "Win rate"]}>
          {stats.winRateByAirport.map((r) => (
            <tr key={r.scenario}>
              <td>{airportName(r.scenario)}</td>
              <Num>{r.finished}</Num>
              <Num>{r.won}</Num>
              <Num>{r.lost}</Num>
              <Bar value={r.win_pct} />
            </tr>
          ))}
        </Table>
      </Section>

      <Section title="Crash causes" note="Each cause's share of that airport's losses." empty={!stats.crashCauses.length}>
        <Table head={["Airport", "Cause", "Losses", "Share"]}>
          {stats.crashCauses.map((r, i) => (
            <tr key={`${r.scenario}-${r.cause}`} className={i > 0 && stats.crashCauses[i - 1].scenario === r.scenario ? "same-group" : undefined}>
              <td>{i > 0 && stats.crashCauses[i - 1].scenario === r.scenario ? "" : airportName(r.scenario)}</td>
              <td>{r.cause}</td>
              <Num>{r.losses}</Num>
              <Bar value={r.pct_of_airport_losses} />
            </tr>
          ))}
        </Table>
      </Section>

      <Section title="Failed landings" note="The landing conditions missed (one failed landing can miss several)." empty={!stats.failedLandings.length}>
        <Table head={["Airport", "Condition", "Times"]}>
          {stats.failedLandings.map((r, i) => (
            <tr key={`${r.scenario}-${r.condition}`}>
              <td>{i > 0 && stats.failedLandings[i - 1].scenario === r.scenario ? "" : airportName(r.scenario)}</td>
              <td>{r.condition}</td>
              <Num>{r.failed_landings}</Num>
            </tr>
          ))}
        </Table>
      </Section>

      <div className="admin-pair">
        <Section title="Special Abilities: win rate" empty={!stats.winRateByAbility.length}>
          <Table head={["Ability", "Finished", "Win rate"]}>
            {stats.winRateByAbility.map((r) => (
              <tr key={r.ability}>
                <td>{ability(r.ability)}</td>
                <Num>{r.finished}</Num>
                <Bar value={r.win_pct} />
              </tr>
            ))}
          </Table>
        </Section>
        <Section title="Modules: win rate" empty={!stats.winRateByModule.length}>
          <Table head={["Module", "Finished", "Win rate"]}>
            {stats.winRateByModule.map((r) => (
              <tr key={r.module}>
                <td>{moduleName(r.module)}</td>
                <Num>{r.finished}</Num>
                <Bar value={r.win_pct} />
              </tr>
            ))}
          </Table>
        </Section>
      </div>

      <Section title="Humans and the bot" note="Two human crews against crews with the bot, per airport." empty={!stats.humansVsBot.length}>
        <Table head={["Airport", "Crew", "Finished", "Win rate"]}>
          {stats.humansVsBot.map((r) => (
            <tr key={`${r.scenario}-${r.crew}`}>
              <td>{airportName(r.scenario)}</td>
              <td>{r.crew}</td>
              <Num>{r.finished}</Num>
              <Bar value={r.win_pct} />
            </tr>
          ))}
        </Table>
      </Section>

      <Section title="Unfinished games" note="Games left before the end: how, and in which round." empty={!stats.unfinished.length}>
        <Table head={["How", "Round", "Games"]}>
          {stats.unfinished.map((r) => (
            <tr key={`${r.result}-${r.rounds_reached}`}>
              <td>{RESULT_LABELS[r.result] ?? r.result}</td>
              <Num>{r.rounds_reached}</Num>
              <Num>{r.games}</Num>
            </tr>
          ))}
        </Table>
      </Section>

      <Section title="Recent games" note="The latest 20, same-dice games included." empty={!stats.recentGames.length}>
        <Table head={["When", "Airport", "Result", "Rounds", "Pilot", "Co-Pilot"]}>
          {stats.recentGames.map((g) => (
            <tr key={g.id}>
              <td>{when(g.ended_at)}</td>
              <td>
                <Link to={`/games/${g.id}`}>{airportName(g.scenario)}</Link>
                {g.seeded && <span className="tag">same dice</span>}
              </td>
              <td title={g.loss_reason ?? undefined}>{RESULT_LABELS[g.result] ?? g.result}</td>
              <Num>{g.rounds_reached}</Num>
              <td>{seatLabel(g.pilot)}</td>
              <td>{seatLabel(g.copilot)}</td>
            </tr>
          ))}
        </Table>
      </Section>
    </>
  );
}

function Total({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="total">
      <strong>{value}</strong> <span>{label}</span>
    </div>
  );
}

function Section({ title, note, empty, children }: { title: string; note?: string; empty: boolean; children: ReactNode }) {
  const id = useId();
  return (
    <section className="panel admin-section" aria-labelledby={id}>
      <h2 id={id} className="setup-label">
        {title}
      </h2>
      {note && <p className="muted">{note}</p>}
      {empty ? <p className="muted">No games yet.</p> : <div className="table-scroll">{children}</div>}
    </section>
  );
}

/** Headers of columns that hold words; the others hold numbers (right-aligned). */
const TEXT_COLUMNS = new Set(["Airport", "Cause", "Condition", "Crew", "Result", "How", "Pilot", "Co-Pilot"]);

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          {head.map((h, i) => (
            <th key={h} className={i > 0 && !TEXT_COLUMNS.has(h) ? "num" : undefined}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

const Num = ({ children }: { children: ReactNode }) => <td className="num">{children}</td>;

/** A percentage, with a bar as long as it. */
function Bar({ value }: { value: number | null }) {
  return (
    <td className="num">
      <span className="pct">
        <span className="bar" style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }} />
        <span className="pct-num">{pct(value)}</span>
      </span>
    </td>
  );
}
