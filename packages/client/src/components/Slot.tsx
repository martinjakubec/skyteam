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
