import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, navigate, nextPath } from "../router";
import { authApi } from "./authApi";
import { RecoveryCode } from "./RecoveryCode";
import { useAccount } from "./useAccount";

/**
 * Signing in, registering, a forgotten password (the recovery code) and a reset
 * link a SUPERADMIN made. Each ends with the user signed in; the last three
 * first show the new recovery code.
 */

/** The frame every account page shares: the wordmark (home) and a panel. */
export function AccountFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="center">
      <Link to="/" className="wordmark home-link">
        SKY&middot;TEAM
      </Link>
      <h2 className="page-title">{title}</h2>
      {children}
    </main>
  );
}

/** A labelled input. */
export function Field({ label, ...input }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="field">
      {label}
      <input {...input} />
    </label>
  );
}

/** A form that sends once at a time and shows the server's refusal. */
function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (run: () => Promise<string | null>) => async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setError(await run());
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

export const Alert = ({ error }: { error: string | null }) =>
  error ? (
    <p role="alert" className="form-error">
      {error}
    </p>
  ) : null;

export function SignIn() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const { busy, error, submit } = useSubmit();
  const onSubmit = submit(async () => {
    const r = await authApi.login(username, password);
    if (!r.ok) {
      setPassword("");
      return r.error;
    }
    useAccount.getState().setUser(r.user);
    navigate(nextPath(), { replace: true });
    return null;
  });
  return (
    <AccountFrame title="Sign in">
      <form className="panel account-form" onSubmit={onSubmit}>
        <Field label="Username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        <Field label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <Alert error={error} />
        <button disabled={busy}>Sign in</button>
        <p className="muted form-links">
          <Link to="/forgot">Forgot your password?</Link> · <Link to="/register">Register</Link>
        </p>
      </form>
    </AccountFrame>
  );
}

export function Register() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const { busy, error, submit } = useSubmit();
  const onSubmit = submit(async () => {
    const r = await authApi.register(username, password);
    if (!r.ok) return r.error;
    useAccount.getState().setUser(r.user);
    setCode(r.recoveryCode);
    return null;
  });
  return (
    <AccountFrame title="Register">
      {code ? (
        <RecoveryCode code={code} onDone={() => navigate(nextPath(), { replace: true })} />
      ) : (
        <form className="panel account-form" onSubmit={onSubmit}>
          <p className="muted">An account keeps your games, so you can replay them. You can always play without one.</p>
          <Field label="Username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
          <Field label="Password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          <p className="muted field-hint">3–24 letters, digits, dots, dashes or underscores; a password of at least 10 characters.</p>
          <Alert error={error} />
          <button disabled={busy}>Register</button>
          <p className="muted form-links">
            Already registered? <Link to="/signin">Sign in</Link>
          </p>
        </form>
      )}
    </AccountFrame>
  );
}

export function Forgot() {
  const [username, setUsername] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const { busy, error, submit } = useSubmit();
  const onSubmit = submit(async () => {
    const r = await authApi.recover(username, recoveryCode, password);
    if (!r.ok) return r.error;
    useAccount.getState().setUser(r.user);
    setCode(r.recoveryCode);
    return null;
  });
  return (
    <AccountFrame title="Forgot your password?">
      {code ? (
        <RecoveryCode code={code} onDone={() => navigate("/", { replace: true })} />
      ) : (
        <form className="panel account-form" onSubmit={onSubmit}>
          <p className="muted">Use the recovery code you saved when you registered. Lost it too? Ask an administrator for a reset link.</p>
          <Field label="Username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
          <Field label="Recovery code" autoComplete="off" value={recoveryCode} onChange={(e) => setRecoveryCode(e.target.value)} required />
          <Field label="New password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          <Alert error={error} />
          <button disabled={busy}>Set new password</button>
        </form>
      )}
    </AccountFrame>
  );
}

export function Reset() {
  // The token leaves the address bar (and so the history) as soon as it's read.
  const [token] = useState(() => new URLSearchParams(window.location.search).get("token") ?? "");
  useEffect(() => window.history.replaceState(null, "", window.location.pathname), []);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const { busy, error, submit } = useSubmit();
  const onSubmit = submit(async () => {
    const r = await authApi.reset(token, password);
    if (!r.ok) return r.error;
    useAccount.getState().setUser(r.user);
    setCode(r.recoveryCode);
    return null;
  });
  return (
    <AccountFrame title="Set a new password">
      {code ? (
        <RecoveryCode code={code} onDone={() => navigate("/", { replace: true })} />
      ) : (
        <form className="panel account-form" onSubmit={onSubmit}>
          <Field label="New password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          <Alert error={error} />
          <button disabled={busy}>Set new password</button>
        </form>
      )}
    </AccountFrame>
  );
}
