import { INTERN_TOKEN_COUNT } from "@skyteam/shared";
import type { Crew } from "../types";
import { face } from "../util";
import { Module } from "./Module";
import { Slot } from "./Slot";

/**
 * Intern module (advanced) — sits under Concentration. A row of face-up Intern
 * tokens between the Pilot's (blue, left) and the Co-Pilot's (orange, right)
 * training spaces. To train, a crew places any die — of a different value than
 * its next token — on its own space, then takes the token nearest its side and
 * uses it like a die of that number (not on Concentration, no Coffee). Every
 * token must be trained by landing.
 */
export function Intern({
  tokens,
  trainers,
  canTrain,
  onTrain,
}: {
  /** Token values left to right; null = already taken. */
  tokens: (number | null)[];
  /** The die each crew placed on its training space this round, if any. */
  trainers: Record<Crew, number | null>;
  canTrain: (crew: Crew) => boolean;
  onTrain: (crew: Crew) => void;
}) {
  // Each crew takes the token nearest its own end.
  const pilotNext = tokens.findIndex((v) => v !== null);
  const copilotNext = tokens.reduce((last, v, i) => (v !== null ? i : last), -1);
  const trained = tokens.filter((v) => v === null).length;

  const trainer = (crew: Crew) => (
    <Slot
      tone={crew === "pilot" ? "blue" : "orange"}
      noSwitch
      dice
      taken={trainers[crew] !== null}
      target={{ kind: "intern" }}
      label={trainers[crew] !== null ? face(trainers[crew]) : "🎓"}
      onClick={() => onTrain(crew)}
      enabled={canTrain(crew)}
    />
  );

  return (
    <Module title="Intern" tone="split" className="mod-intern">
      <div className="intern">
        {trainer("pilot")}
        <div className="intern-tokens" aria-label={`Intern tokens: ${tokens.map((v) => v ?? "taken").join(", ")}`}>
          {tokens.map((v, i) => {
            const next = [i === pilotNext && "next-pilot", i === copilotNext && "next-copilot"].filter(Boolean).join(" ");
            return (
              <span key={i} className={`intern-token ${v === null ? "gone" : ""} ${next}`}>
                {v ?? ""}
              </span>
            );
          })}
        </div>
        {trainer("copilot")}
      </div>
      <div className="intern-foot">
        <span className="intern-rule" title="The training die must differ from the token you'd take">
          die ≠ next token
        </span>
        <span className="intern-progress">
          trained {trained}/{INTERN_TOKEN_COUNT}
        </span>
      </div>
    </Module>
  );
}
