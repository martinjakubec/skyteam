import {
  ABILITY_IDS,
  ABILITY_LABELS,
  ABILITY_TEXT,
  DEFAULT_MAX_ABILITIES,
  MAX_NAME_LENGTH,
  EXCLUSIVE_MODULE_GROUPS,
  IMPLEMENTED_MODULES,
  conflictingModules,
  MODULE_IDS,
  MODULE_LABELS,
  SCENARIOS,
  templateFor,
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

export function Lobby({
  snapshot,
  onReady,
  onName,
  onSetup,
  onStart,
}: {
  snapshot: RoomSnapshot;
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
      <SetupPicker setup={snapshot.setup} editable={isHost} onChange={onSetup} />
      <div className="row">
        <button onClick={() => onReady(!me?.ready)}>{me?.ready ? "Unready" : "Ready up"}</button>
        {isHost && (
          <button disabled={!canStart} onClick={onStart}>
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

/** Airport + module selection. The host edits it; the guest sees it read-only
 *  (and is un-readied by the server whenever it changes). */
function SetupPicker({
  setup,
  editable,
  onChange,
}: {
  setup: GameSetup;
  editable: boolean;
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

  // Ticking a module unticks any it can't be played with (e.g. Kerosene vs
  // Kerosene Leak — one or the other).
  const toggle = (id: ModuleId, on: boolean) => {
    const drop = on ? conflictingModules(id) : [];
    onChange({
      ...setup,
      // Keep the canonical MODULE_IDS order so equal selections compare equal.
      modules: MODULE_IDS.filter((m) => (m === id ? on : setup.modules.includes(m) && !drop.includes(m))),
    });
  };

  // Picking a card switches on the modules printed on it (the host can still
  // change them) and drops abilities, whose cap comes from the new card.
  const pickAirport = (scenarioId: ScenarioId) =>
    onChange({
      scenarioId,
      modules: MODULE_IDS.filter((m) => templateFor(scenarioId)?.modules.includes(m) && IMPLEMENTED_MODULES.includes(m)),
      abilities: [],
    });

  // The ℹ️ beside each module and ability opens its tutorial — for host and
  // guest alike (it runs locally; nothing is sent).
  const [tutorial, setTutorial] = useState<TutorialId | null>(null);
  const info = (id: ModuleId | AbilityId, name: string) => (
    <button type="button" className="info-btn" aria-label={`How ${name} works`} title={`How ${name} works`} onClick={() => setTutorial(id)}>
      ℹ️
    </button>
  );

  return (
    <div className="setup">
      <button type="button" className="how-to-play" onClick={() => setTutorial("basics")}>
        How to play
      </button>
      <div className="setup-airport">
        <span className="setup-label">Scenario</span>
        <ScenarioPicker value={setup.scenarioId} disabled={!editable} onChange={pickAirport} />
      </div>
      <fieldset className="setup-modules">
        <legend className="setup-label">Modules</legend>
        {MODULE_IDS.map((id) => {
          const available = IMPLEMENTED_MODULES.includes(id);
          return (
            <span key={id} className="setup-item">
              <label className={available ? "" : "muted"}>
                <input
                  type="checkbox"
                  checked={setup.modules.includes(id)}
                  disabled={!editable || !available}
                  onChange={(e) => toggle(id, e.target.checked)}
                />
                {MODULE_LABELS[id]}
                {!available && " (soon)"}
              </label>
              {info(id, MODULE_LABELS[id])}
            </span>
          );
        })}
      </fieldset>
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
      <p className="muted setup-note">
        {maxAbilities === 0
          ? "This airport has no Special Abilities."
          : `Choose up to ${maxAbilities} Special Abilities.`}
      </p>
      {EXCLUSIVE_MODULE_GROUPS.map((group) => (
        <p key={group.join()} className="muted setup-note">
          {group.map((m) => MODULE_LABELS[m]).join(" or ")} — one or the other, not both.
        </p>
      ))}
      {!editable && <p className="muted">The host chooses the airport and modules.</p>}
      {tutorial && <TutorialModal id={tutorial} onClose={() => setTutorial(null)} />}
    </div>
  );
}
