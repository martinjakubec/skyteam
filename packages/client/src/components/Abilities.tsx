import type { ReactNode } from "react";
import { ABILITY_LABELS, ABILITY_TEXT, type AbilityId } from "@skyteam/shared";

/**
 * The Special Ability cards in play, as a strip in the dice tray. Passive cards
 * (Control, Mastery, Synchronisation) are plain chips; active ones get their
 * action button from `actions` (Adaptation, Anticipation, Working Together).
 */
export function Abilities({
  abilities,
  actions = {},
}: {
  abilities: AbilityId[];
  actions?: Partial<Record<AbilityId, ReactNode>>;
}) {
  if (abilities.length === 0) return null;
  return (
    <div className="abilities" aria-label="Special Abilities">
      {abilities.map((id) => (
        <span key={id} className={`ability-chip ${actions[id] ? "active" : ""}`} title={ABILITY_TEXT[id]}>
          <span className="ability-name">{ABILITY_LABELS[id]}</span>
          {actions[id]}
        </span>
      ))}
    </div>
  );
}
