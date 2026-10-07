import { useEffect, useState } from "react";
import type { GameSummary } from "@skyteam/shared";
import { useSignedIn } from "../account/Account";
import { AccountFrame, Alert } from "../account/AccountPages";
import { call } from "../account/authApi";
import { Link } from "../router";
import { RESULT_LABELS, airportName, when } from "./format";

/** My games, newest first; each opens its replay. */
export function History() {
  const user = useSignedIn("/history");
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (before?: string) => {
    setBusy(true);
    const r = await call<{ games: GameSummary[]; next: string | null }>("GET", `/me/games${before ? `?before=${encodeURIComponent(before)}` : ""}`);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setGames((g) => [...(before ? (g ?? []) : []), ...r.games]);
    setNext(r.next);
  };

  useEffect(() => {
    if (user) void load();
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!user) return null;
  return (
    <AccountFrame title="My games">
      <Alert error={error} />
      {games && games.length === 0 && <p className="notice">No games yet. Games you play while signed in show up here.</p>}
      {games && games.length > 0 && (
        <div className="panel table-panel">
          <table className="data-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Airport</th>
                <th>Result</th>
                <th>Seat</th>
                <th>With</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {games.map((g) => (
                <tr key={`${g.id}-${g.crew}`}>
                  <td>{when(g.endedAt)}</td>
                  <td>
                    {airportName(g.scenario, g.modules, g.abilities)}
                    {g.seeded && <span className="tag">same dice</span>}
                  </td>
                  <td title={g.lossReason ?? undefined}>{RESULT_LABELS[g.result] ?? g.result}</td>
                  <td>{g.crew === "pilot" ? "Pilot" : "Co-Pilot"}</td>
                  <td>{g.partner}</td>
                  <td>
                    <Link to={`/games/${g.id}`}>Replay</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && (
        <button disabled={busy} onClick={() => void load(next)}>
          Load more
        </button>
      )}
    </AccountFrame>
  );
}
