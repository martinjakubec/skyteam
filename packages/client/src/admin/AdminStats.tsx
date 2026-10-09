import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { ABILITY_LABELS, MODULE_LABELS, type AbilityId, type AdminStats as Stats, type ModuleId } from "@skyteam/shared";
import { useSignedIn } from "../account/Account";
import { call } from "../account/authApi";
import { useAccount } from "../account/useAccount";
import { RESULT_LABELS, airportName, when } from "../history/format";
import { Link, navigate } from "../router";
import { AdminAlert, AdminCard, AdminLayout } from "./AdminLayout";
import { PieChart, Swatch, sliceColor, type Slice } from "./PieChart";

/**
 * The statistics dashboard (view_stats): every query in
 * docs/game-log-queries.sql, plus totals and the latest games. Games flown on
 * an earlier game's dice are left out unless the switch counts them.
 */
export default function AdminStats() {
  const user = useSignedIn("/admin");
  const allowed = useAccount((s) => !!s.user?.privileges.includes("view_stats"));
  const [stats, setStats] = useState<Stats | null>(null);
  const [includeSeeded, setIncludeSeeded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      <AdminLayout title="Statistics">
        <p className="adm-empty">You don't have access to this.</p>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout
      title="SkyTeam statistics"
      actions={
        <>
          <label className="adm-check">
            <input type="checkbox" checked={includeSeeded} onChange={(e) => setIncludeSeeded(e.target.checked)} />
            Include same-dice games ({stats?.seededGames ?? 0})
          </label>
          <button disabled={busy} onClick={() => void load(includeSeeded)}>
            Refresh
          </button>
        </>
      }
    >
      {stats && <p className="adm-updated">Updated {when(stats.generatedAt)}</p>}
      <AdminAlert error={error} />
      {stats && <Dashboard stats={stats} />}
    </AdminLayout>
  );
}

const pct = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)} %`);
const ability = (id: string) => ABILITY_LABELS[id as AbilityId] ?? id;
const moduleName = (id: string) => MODULE_LABELS[id as ModuleId] ?? id;
const seatLabel = (seat: string) => (seat.startsWith("bot:") ? `Bot (${seat.slice(4)})` : "Human");

/** One colour per way a game ends, the same on every chart. */
const OUTCOME_COLORS: Record<string, string> = {
  won: "#16a34a",
  lost: "#dc2626",
  abandoned: "#f59e0b",
  exited: "#64748b",
  reset: "#8b5cf6",
};

function Dashboard({ stats }: { stats: Stats }) {
  const games = stats.playRate.reduce((n, r) => n + r.games, 0);
  const finished = stats.playRate.reduce((n, r) => n + r.finished, 0);
  const won = stats.winRateByAirport.reduce((n, r) => n + r.won, 0);
  const winRate = finished ? Math.round((1000 * won) / finished) / 10 : null;
  const lost = stats.winRateByAirport.reduce((n, r) => n + r.lost, 0);

  // How games end: won and lost, then the ways a game is left unfinished.
  const unfinishedBy = (result: string) => stats.unfinished.filter((r) => r.result === result).reduce((n, r) => n + r.games, 0);
  const endings: Slice[] = [
    { label: RESULT_LABELS.won, value: won, color: OUTCOME_COLORS.won },
    { label: RESULT_LABELS.lost, value: lost, color: OUTCOME_COLORS.lost },
    ...["abandoned", "exited", "reset"].map((r) => ({ label: RESULT_LABELS[r], value: unfinishedBy(r), color: OUTCOME_COLORS[r] })),
  ];
  const unfinished = endings.slice(2);
  // Every airport's losses together, by cause.
  const causes = new Map<string, number>();
  for (const r of stats.crashCauses) causes.set(r.cause, (causes.get(r.cause) ?? 0) + r.losses);
  const causeSlices = [...causes].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  const plays: Slice[] = stats.playRate.map((r) => ({ label: airportName(r.scenario), value: r.games }));

  return (
    <>
      <section className="adm-kpis" aria-label="Totals">
        <Total value={games} label="games" />
        <Total value={finished} label="finished" />
        <Total value={won} label="won" />
        <Total value={winRate === null ? "—" : `${winRate.toFixed(1)} %`} label="win rate" />
      </section>

      <Section title="Play rate per airport" empty={!stats.playRate.length}>
        <div className="adm-chart-row">
          <PieChart title="Play rate per airport" slices={plays} legend={false} />
        <Table head={["Airport", "Games", "Share", "Finished", "Finish rate", "Share of all finished"]}>
          {stats.playRate.map((r, i) => (
            <tr key={r.scenario}>
              <td>
                <Swatch color={sliceColor(i, plays.length)} />
                {airportName(r.scenario)}
              </td>
              <Num>{r.games}</Num>
              <Num>{pct(r.pct_of_all_games)}</Num>
              <Num>{r.finished}</Num>
              <Num>{pct(r.finish_pct)}</Num>
              <Num>{pct(r.pct_of_finished_games)}</Num>
            </tr>
          ))}
        </Table>
        </div>
      </Section>

      <div className="adm-grid-2">
        <Section title="How games end" note="Every game: finished (won or lost) or left before the end." empty={!games}>
          <div className="adm-chart-row">
            <PieChart title="How games end" slices={endings} />
          </div>
        </Section>
        <Section title="Unfinished games" note="Games left before the end: how, and in which round." empty={!stats.unfinished.length}>
          <div className="adm-chart-row">
            <PieChart title="Unfinished games" slices={unfinished} />
          </div>
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
      </div>

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

      <Section title="Crash causes" note="All losses by cause; then, per airport, each cause's share of that airport's losses." empty={!stats.crashCauses.length}>
        <div className="adm-chart-row">
          <PieChart title="Crash causes" slices={causeSlices} />
        </div>
        <Table head={["Airport", "Cause", "Losses", "Share"]}>
          {stats.crashCauses.map((r, i) => (
            <tr key={`${r.scenario}-${r.cause}`}>
              <td className="adm-group">{i > 0 && stats.crashCauses[i - 1].scenario === r.scenario ? "" : airportName(r.scenario)}</td>
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
              <td className="adm-group">{i > 0 && stats.failedLandings[i - 1].scenario === r.scenario ? "" : airportName(r.scenario)}</td>
              <td>{r.condition}</td>
              <Num>{r.failed_landings}</Num>
            </tr>
          ))}
        </Table>
      </Section>

      <div className="adm-grid-2">
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

      <Section title="Recent games" note="The latest 20, same-dice games included." empty={!stats.recentGames.length}>
        <Table head={["When", "Airport", "Result", "Rounds", "Pilot", "Co-Pilot"]}>
          {stats.recentGames.map((g) => (
            <tr key={g.id}>
              <td>{when(g.ended_at)}</td>
              <td>
                <Link to={`/games/${g.id}`}>{airportName(g.scenario)}</Link>
                {g.seeded && <span className="adm-badge">same dice</span>}
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
    <div className="adm-kpi">
      <strong>{value}</strong> <span>{label}</span>
    </div>
  );
}

function Section({ title, note, empty, children }: { title: string; note?: string; empty: boolean; children: ReactNode }) {
  const id = useId();
  return (
    <AdminCard title={title} note={note} labelledBy={id}>
      {empty ? <p className="adm-card-empty">No games yet.</p> : children}
    </AdminCard>
  );
}

/** Headers of columns that hold words; the others hold numbers (right-aligned). */
const TEXT_COLUMNS = new Set(["Airport", "Cause", "Condition", "Crew", "Result", "How", "Pilot", "Co-Pilot"]);

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="adm-table-wrap">
    <table className="adm-table">
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
    </div>
  );
}

const Num = ({ children }: { children: ReactNode }) => <td className="num">{children}</td>;

/** A percentage, with a bar as long as it. */
function Bar({ value }: { value: number | null }) {
  return (
    <td className="num">
      <span className="adm-pct">
        <span className="adm-pct-track" aria-hidden="true">
          <span className="adm-pct-fill" style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }} />
        </span>
        <span className="adm-pct-num">{pct(value)}</span>
      </span>
    </td>
  );
}
