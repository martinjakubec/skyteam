import { useEffect, useState, type FormEvent } from "react";
import { navigate } from "../router";
import { AccountFrame, Alert, Field } from "./AccountPages";
import { authApi } from "./authApi";
import { RecoveryCode } from "./RecoveryCode";
import { useAccount } from "./useAccount";

/** Send a guest to sign in first, then back here. */
export function useSignedIn(path: string) {
  const user = useAccount((s) => s.user);
  useEffect(() => {
    if (user === null) navigate(`/signin?next=${encodeURIComponent(path)}`, { replace: true });
  }, [user, path]);
  return user;
}

/** The signed-in user's own account: password, recovery code, sessions, deletion. */
export function Account() {
  const user = useSignedIn("/account");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [codePassword, setCodePassword] = useState("");
  const [deletePassword, setDeletePassword] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!user) return null;

  const run = (task: () => Promise<void>) => async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await task();
    } finally {
      setBusy(false);
    }
  };

  const changePassword = run(async () => {
    const r = await authApi.changePassword(current, next);
    if (!r.ok) return setError(r.error);
    setCurrent("");
    setNext("");
    setMessage("Password changed. You're signed out everywhere else.");
  });
  const newCode = run(async () => {
    const r = await authApi.newRecoveryCode(codePassword);
    if (!r.ok) return setError(r.error);
    setCodePassword("");
    setCode(r.recoveryCode);
  });
  const signOutEverywhere = run(async () => {
    const r = await authApi.signOutEverywhere();
    if (!r.ok) return setError(r.error);
    useAccount.getState().setUser(null);
    navigate("/signin");
  });
  const removeAccount = run(async () => {
    const r = await authApi.deleteAccount(deletePassword);
    if (!r.ok) return setError(r.error);
    useAccount.getState().setUser(null);
    navigate("/");
  });

  // Asked before anything is sent (and before the form counts as busy).
  const deleteAccount = (e: FormEvent) => {
    e.preventDefault();
    if (window.confirm("Delete your account? Your game history goes with it. This can't be undone.")) void removeAccount();
  };

  if (code) {
    return (
      <AccountFrame title="Account">
        <RecoveryCode code={code} onDone={() => setCode(null)} />
      </AccountFrame>
    );
  }

  return (
    <AccountFrame title="Account">
      <p className="muted">
        Signed in as <strong>{user.username}</strong> ({user.role})
      </p>
      {message && <p className="notice">{message}</p>}
      <Alert error={error} />

      <form className="panel account-form" onSubmit={changePassword}>
        <h3 className="setup-label">Change password</h3>
        <Field label="Current password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        <Field label="New password" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
        <button disabled={busy}>Change password</button>
      </form>

      <form className="panel account-form" onSubmit={newCode}>
        <h3 className="setup-label">Recovery code</h3>
        <p className="muted">Lost your recovery code? Make a new one; the old one stops working.</p>
        <Field label="Password for a new code" type="password" autoComplete="current-password" value={codePassword} onChange={(e) => setCodePassword(e.target.value)} required />
        <button disabled={busy}>New recovery code</button>
      </form>

      <section className="panel account-form">
        <h3 className="setup-label">Sessions</h3>
        <p className="muted">Signs you out on every device, this one too.</p>
        <button type="button" disabled={busy} onClick={() => void signOutEverywhere()}>
          Sign out everywhere
        </button>
      </section>

      <form className="panel account-form danger" onSubmit={deleteAccount}>
        <h3 className="setup-label">Delete my account</h3>
        <p className="muted">Your games stay in the anonymous statistics, but nobody can tell they were yours.</p>
        <Field label="Password to delete" type="password" autoComplete="current-password" value={deletePassword} onChange={(e) => setDeletePassword(e.target.value)} required />
        <button disabled={busy} className="reset-btn">
          Delete my account
        </button>
      </form>
    </AccountFrame>
  );
}
