import type { ReactNode } from "react";
import { Warning } from "./icons";

export function Module({
  title,
  children,
  tone = "neutral",
  mandatory,
  className,
}: {
  title: string;
  children: ReactNode;
  tone?: "blue" | "orange" | "split" | "neutral";
  mandatory?: boolean;
  /** Extra class, used by the board grid to place individual modules. */
  className?: string;
}) {
  return (
    <div className={`module tone-${tone}${className ? ` ${className}` : ""}`}>
      <span className="module-title">
        {title}
        {mandatory && <span className="req" title="Mandatory each round"><Warning /></span>}
      </span>
      {children}
    </div>
  );
}
