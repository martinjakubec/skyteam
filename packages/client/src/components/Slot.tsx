import type { Target } from "../types";

export function Slot({
  taken,
  green,
  tone,
  label,
  onClick,
  enabled,
  noSwitch,
  dice,
  held,
  target,
  mandatory,
}: {
  taken: boolean;
  green?: boolean;
  tone: "blue" | "orange" | "neutral";
  label: string;
  onClick: () => void;
  enabled: boolean;
  noSwitch?: boolean;
  dice?: boolean;
  held?: number | null;
  target?: Target;
  mandatory?: boolean;
}) {
  // `held` is the die value placed on this space this round (Gear/Flaps): show it
  // until the round resets so it's clear where the dice went. Otherwise show the
  // requirement label, or nothing once the section is deployed (green).
  const faceText = held != null ? held : green ? "" : label;
  const button = (
    <button
      className={`slot ${tone} ${green ? "green" : ""} ${taken ? "taken" : ""} ${enabled ? "open" : ""} ${dice ? "dice" : ""} ${held != null ? "held" : ""}`}
      disabled={!enabled}
      onClick={onClick}
      data-open={enabled ? "1" : "0"}
      data-target={target ? JSON.stringify(target) : undefined}
    >
      {/* Mandatory spots (Axis, Engines) flag themselves with a caution triangle
         while still empty, so it's clear a die must go here this round. */}
      {mandatory && !taken && (
        <span className="slot-warn" title="Mandatory — a die must be placed here" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M12 3.6 L21.8 20.4 H2.2 Z" fill="#ffce47" stroke="#6d4f00" strokeWidth="1.4" strokeLinejoin="round" />
            <rect x="10.9" y="9" width="2.2" height="6.2" rx="1.1" fill="#3a2c00" />
            <circle cx="12" cy="18" r="1.25" fill="#3a2c00" />
          </svg>
        </span>
      )}
      <span className="slot-face">{faceText}</span>
    </button>
  );
  // Switch modules (Gear/Flaps/Brakes) carry their deploy switch *under* the slot.
  if (noSwitch) return button;
  return (
    <div className="slot-stack">
      {button}
      <span className={`switch ${green ? "on" : ""}`} aria-hidden="true" />
    </div>
  );
}
