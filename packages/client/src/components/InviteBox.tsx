export function InviteBox({ url }: { url: string }) {
  // Phones (and the installed app, which has no address bar) can hand the link
  // straight to a messaging app. Closing the share sheet rejects: not an error.
  const share = typeof navigator.share === "function" ? () => navigator.share({ title: "SkyTeam", text: "Fly with me in SkyTeam", url }).catch(() => {}) : null;
  return (
    <div className="panel">
      <label>Invite link</label>
      <div className="row">
        <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
        <button onClick={() => navigator.clipboard?.writeText(url)}>Copy</button>
        {share && <button onClick={() => void share()}>Share</button>}
      </div>
    </div>
  );
}
