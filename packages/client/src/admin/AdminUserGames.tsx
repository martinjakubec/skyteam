import { useCallback, useEffect, useState } from "react";
import type { GameSummary } from "@skyteam/shared";
import { useSignedIn } from "../account/Account";
import { call } from "../account/authApi";
import { useAccount } from "../account/useAccount";
import { RESULT_LABELS, airportName, when } from "../history/format";
import { Link, navigate } from "../router";
import { AdminAlert, AdminCard, AdminLayout } from "./AdminLayout";

/**
 * One user's games (manage_users), as their history lists them: tick some and
 * export them as a JSON file — each game's setup, seed, crews, result and
 * moves (see the server's gameExport.ts).
 */

/** The most games one export may take (the server's EXPORT_MAX). */
const EXPORT_MAX = 200;

export default function AdminUserGames({ userId }: { userId: string }) {
  const here = `/admin/users/${encodeURIComponent(userId)}/games`;
  const me = useSignedIn(here);
  const allowed = useAccount((s) => !!s.user?.privileges.includes("manage_users"));
  const [username, setUsername] = useState<string | null>(null);
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** A refused request: signed out goes to sign in; anything else is shown. */
  const refused = useCallback(
    (r: { status: number; error: string }) => {
      if (r.status === 401) {
        useAccount.getState().setUser(null);
        navigate(`/signin?next=${encodeURIComponent(here)}`);
      } else setError(r.error);
    },
    [here],
  );

  const load = useCallback(
    async (before?: string) => {
      setBusy(true);
      const r = await call<{ user: { username: string }; games: GameSummary[]; next: string | null }>(
        "GET",
        `/admin/users/${encodeURIComponent(userId)}/games${before ? `?before=${encodeURIComponent(before)}` : ""}`,
      );
      setBusy(false);
      if (!r.ok) return refused(r);
      setUsername(r.user.username);
      setGames((g) => [...(before ? (g ?? []) : []), ...r.games]);
      setNext(r.next);
    },
    [userId, refused],
  );

  useEffect(() => {
    if (me && allowed) void load();
  }, [me?.id, allowed, load]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!me) return null;
  if (!allowed) {
    return (
      <AdminLayout title="Games">
        <p className="adm-empty">You don't have access to this.</p>
      </AdminLayout>
    );
  }

  // A user who flew both seats has a game twice in the list: it's chosen once.
  const ids = [...new Set((games ?? []).map((g) => g.id))];
  const all = ids.length > 0 && ids.every((id) => chosen.has(id));
  const toggle = (id: string) =>
    setChosen((c) => {
      const out = new Set(c);
      if (!out.delete(id)) out.add(id);
      return out;
    });
  const tooMany = chosen.size > EXPORT_MAX;

  const exportChosen = async () => {
    setError(null);
    setBusy(true);
    const r = await call<object>("POST", "/admin/games/export", { ids: [...chosen] });
    setBusy(false);
    if (!r.ok) return refused(r);
    const { ok: _ok, status: _status, ...data } = r;
    download(`skyteam-games-${username ?? userId}-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2));
  };

  return (
    <AdminLayout
      title={username ? `Games of ${username}` : "Games"}
      actions={
        <>
          <Link to="/admin/users">Back to users</Link>
          <button className="adm-primary" disabled={busy || chosen.size === 0 || tooMany} onClick={() => void exportChosen()}>
            {chosen.size ? `Export ${chosen.size} as JSON` : "Export as JSON"}
          </button>
        </>
      }
    >
      <AdminAlert error={error ?? (tooMany ? `Export at most ${EXPORT_MAX} games at a time.` : null)} />
      {games && games.length === 0 && <p className="adm-empty">No games yet.</p>}
      {games && games.length > 0 && (
        <AdminCard>
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label="Choose every game shown"
                      checked={all}
                      onChange={() => setChosen(all ? new Set() : new Set(ids))}
                    />
                  </th>
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
                    <td>
                      <input type="checkbox" aria-label={`Choose the game of ${when(g.endedAt)}`} checked={chosen.has(g.id)} onChange={() => toggle(g.id)} />
                    </td>
                    <td>{when(g.endedAt)}</td>
                    <td>
                      {airportName(g.scenario, g.modules, g.abilities)}
                      {g.seeded && <span className="adm-badge">same dice</span>}
                    </td>
                    <td title={g.lossReason ?? undefined}>{RESULT_LABELS[g.result] ?? g.result}</td>
                    <td>{g.crew === "pilot" ? "Pilot" : "Co-Pilot"}</td>
                    <td>{g.partner}</td>
                    <td className="adm-row-actions">
                      <Link to={`/games/${g.id}`} newTab>
                        Replay
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AdminCard>
      )}
      {next && (
        <button className="adm-more" disabled={busy} onClick={() => void load(next)}>
          Load more
        </button>
      )}
    </AdminLayout>
  );
}

/** Save `text` as a file the browser downloads. */
function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
