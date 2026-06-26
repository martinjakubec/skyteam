import type { ReactNode } from "react";

export function Module({
  title,
  children,
  tone = "neutral",
  mandatory,
}: {
  title: string;
  children: ReactNode;
  tone?: "blue" | "orange" | "split" | "neutral";
  mandatory?: boolean;
}) {
  return (
    <div className={`module tone-${tone}`}>
      <span className="module-title">
        {title}
        {mandatory && <span className="req" title="Mandatory each round">⚠</span>}
      </span>
      {children}
    </div>
  );
}
