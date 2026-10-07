import { useState } from "react";

/** A new recovery code, shown once: the user saves it before going on. */
export function RecoveryCode({ code, onDone }: { code: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(code).then(() => setCopied(true), () => {});
  };
  return (
    <section className="panel account-form recovery">
      <h2 className="setup-label">Your recovery code</h2>
      <p className="recovery-code">{code}</p>
      <p className="muted">
        Save this code. It's the only way to reset your password yourself. We can't show it again.
      </p>
      <div className="row">
        <button type="button" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" onClick={onDone}>
          I've saved it
        </button>
      </div>
    </section>
  );
}
