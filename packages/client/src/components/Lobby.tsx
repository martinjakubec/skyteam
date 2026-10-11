import {
  ABILITY_IDS,
  ABILITY_LABELS,
  ABILITY_TEXT,
  cardModules,
  DEFAULT_MAX_ABILITIES,
  MAX_NAME_LENGTH,
  MODULE_LABELS,
  SCENARIOS,
  SOLO_RESTRICTED_NOTE,
  soloAllowed,
  type AbilityId,
  type GameSetup,
  type ModuleId,
  type RoomSnapshot,
  type ScenarioId,
} from "@skyteam/shared";
import { useEffect, useState } from "react";
import { ScenarioPicker } from "./ScenarioPicker";
import type { TutorialId } from "../tutorials/types";
import { TutorialModal } from "./TutorialModal";
import { Info } from "./icons";

export function Lobby({
  snapshot,
  onReady,
  onName,
  onSetup,
  onStart,
  onFreshDice,
}: {
  snapshot: RoomSnapshot;
  onFreshDice?: () => void;
  onReady: (ready: boolean) => void;
  onName: (name: string) => void;
  onSetup: (setup: GameSetup) => void;
  onStart: () => void;
}) {
  const me = snapshot.seats.find((s) => s.playerId === snapshot.you.playerId);
  const isHost = snapshot.hostPlayerId === snapshot.you.playerId;
  const canStart = isHost && snapshot.status === "ready";
  return (
    <div className="panel">
      <NameField name={me?.name ?? ""} onSave={onName} />
      {snapshot.sameDice && (
        <div className="notice same-dice">
          <p>
            Same dice as{" "}
            <a href={`/games/${snapshot.sameDice.gameId}`} target="_blank" rel="noopener">
              an earlier game
            </a>
            . Its results are marked and kept out of the statistics.
          </p>
          {isHost && onFreshDice && (
            <button type="button" onClick={onFreshDice}>
              Use fresh dice
            </button>
          )}
        </div>
      )}
      <SetupPicker setup={snapshot.setup} editable={isHost && !snapshot.sameDice} solo={snapshot.seats.some((s) => !!s.bot)} onChange={onSetup} />
      <div className="row">
        <button className={me?.ready ? undefined : "primary"} onClick={() => onReady(!me?.ready)}>
          {me?.ready ? "Unready" : "Ready up"}
        </button>
        {isHost && (
          <button className="primary" disabled={!canStart} onClick={onStart}>
            Start game
          </button>
        )}
      </div>
      {isHost && !canStart && <p className="muted">Both players must be ready to start.</p>}
    </div>
  );
}

/** Your name in this room — and, kept in the browser, in every room after. */
function NameField({ name, onSave }: { name: string; onSave: (name: string) => void }) {
  const [draft, setDraft] = useState(name);
  // Follow the server's copy (e.g. the stored name arriving with the join).
  useEffect(() => setDraft(name), [name]);
  const changed = draft.trim().replace(/\s+/g, " ") !== name;
  return (
    <form
      className="name-field"
      onSubmit={(e) => {
        e.preventDefault();
        if (changed) onSave(draft);
      }}
    >
      <label className="setup-label" htmlFor="player-name">
        Your name
      </label>
      <input
        id="player-name"
        value={draft}
        maxLength={MAX_NAME_LENGTH}
        placeholder="Pick a name"
        autoComplete="nickname"
        onChange={(e) => setDraft(e.target.value)}
      />
      <button type="submit" disabled={!changed}>
        Save
      </button>
    </form>
  );
}

/** Airport (its card fixes the modules) + Special Abilities. The host edits
 *  it; the guest sees it read-only (and is un-readied by the server whenever
 *  it changes). */
function SetupPicker({
  setup,
  editable,
  solo,
  onChange,
}: {
  setup: GameSetup;
  editable: boolean;
  /** A solo room (the bot flies the other seat): red and black cards are unavailable. */
  solo: boolean;
  onChange: (setup: GameSetup) => void;
}) {
  // The scenario caps how many Special Abilities the crew may choose.
  const maxAbilities = SCENARIOS[setup.scenarioId].maxAbilities ?? DEFAULT_MAX_ABILITIES;
  const toggleAbility = (id: AbilityId, on: boolean) =>
    onChange({
      ...setup,
      // Canonical ABILITY_IDS order, like modules, so equal picks compare equal.
      abilities: ABILITY_IDS.filter((a) => (a === id ? on : setup.abilities.includes(a))),
    });

  // Picking a card brings the modules printed on it (fixed — the crew can't
  // change them) and drops abilities, whose cap comes from the new card.
  const pickAirport = (scenarioId: ScenarioId) => onChange({ scenarioId, modules: cardModules(scenarioId), abilities: [] });

  // The info button beside each module and ability opens its tutorial — for host and
  // guest alike (it runs locally; nothing is sent).
  const [tutorial, setTutorial] = useState<TutorialId | null>(null);
  const info = (id: ModuleId | AbilityId, name: string) => (
    <button type="button" className="info-btn" aria-label={`How ${name} works`} title={`How ${name} works`} onClick={() => setTutorial(id)}>
      <Info />
    </button>
  );

  return (
    <div className="setup">
      <button type="button" className="how-to-play" onClick={() => setTutorial("basics")}>
        How to play
      </button>
      <div className="setup-airport">
        <span className="setup-label">Scenario</span>
        {/* Solo play: the bot flies green and yellow cards only. */}
        <ScenarioPicker
          value={setup.scenarioId}
          disabled={!editable}
          onChange={pickAirport}
          {...(solo ? { allow: soloAllowed, restrictedNote: SOLO_RESTRICTED_NOTE } : {})}
        />
      </div>
      {/* The card's modules, fixed: shown ticked, not to be unticked. None, no list. */}
      {setup.modules.length > 0 && (
        <fieldset className="setup-modules">
          <legend className="setup-label">Modules</legend>
          {setup.modules.map((id) => (
            <span key={id} className="setup-item">
              <label>
                <input type="checkbox" checked disabled readOnly />
                {MODULE_LABELS[id]}
              </label>
              {info(id, MODULE_LABELS[id])}
            </span>
          ))}
        </fieldset>
      )}
      {/* Only a card with the ★ badge offers Special Abilities. */}
      {maxAbilities > 0 && (
        <>
          <fieldset className="setup-abilities">
            <legend className="setup-label">Special Abilities</legend>
            {ABILITY_IDS.map((id) => {
              const checked = setup.abilities.includes(id);
              return (
                <span key={id} className="setup-item">
                  <label title={ABILITY_TEXT[id]}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!editable || (!checked && setup.abilities.length >= maxAbilities)}
                      onChange={(e) => toggleAbility(id, e.target.checked)}
                    />
                    {ABILITY_LABELS[id]}
                  </label>
                  {info(id, ABILITY_LABELS[id])}
                </span>
              );
            })}
          </fieldset>
          <p className="muted setup-note">Choose up to {maxAbilities} Special Abilities.</p>
        </>
      )}
      {!editable && (
        <p className="muted">The host chooses the airport{maxAbilities > 0 ? " and Special Abilities" : ""}.</p>
      )}
      {tutorial && <TutorialModal id={tutorial} onClose={() => setTutorial(null)} />}
    </div>
  );
}
