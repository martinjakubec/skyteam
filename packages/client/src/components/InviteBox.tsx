export function InviteBox({ url }: { url: string }) {
  return (
    <div className="panel">
      <label>Invite link</label>
      <div className="row">
        <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
        <button onClick={() => navigator.clipboard?.writeText(url)}>Copy</button>
      </div>
    </div>
  );
}
