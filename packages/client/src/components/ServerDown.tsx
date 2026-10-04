/**
 * The 500 page: the server answered, but it can't reach its storage (Redis),
 * so nothing can be played or saved until it's back. "Try again" reloads the
 * page, which re-enters the room through its invite link if there was one.
 */
export function ServerDown() {
  return (
    <main className="center">
      <h1 className="wordmark">SKY&middot;TEAM</h1>
      <section className="panel server-down" role="alert">
        <p className="server-down-code">500</p>
        <h2>Lost contact with the tower</h2>
        <p className="muted">
          The game server can't reach its storage right now, so nothing can be played or saved. Try again in a minute.
        </p>
        <button onClick={() => window.location.reload()}>Try again</button>
      </section>
    </main>
  );
}
