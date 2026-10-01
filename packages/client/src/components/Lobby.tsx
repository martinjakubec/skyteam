import {
  ABILITY_IDS,
  ABILITY_LABELS,
  ABILITY_TEXT,
  DEFAULT_MAX_ABILITIES,
  EXCLUSIVE_MODULE_GROUPS,
  IMPLEMENTED_MODULES,
  conflictingModules,
  MODULE_IDS,
  MODULE_LABELS,
  SCENARIO_IDS,
  SCENARIOS,
  type AbilityId,
  type GameSetup,
  type ModuleId,
  type RoomSnapshot,
  type ScenarioId,
} from "@skyteam/shared";

export function Lobby({
  snapshot,
  onReady,
  onSetup,
  onStart,
}: {
  snapshot: RoomSnapshot;
  onReady: (ready: boolean) => void;
  onSetup: (setup: GameSetup) => void;
  onStart: () => void;
}) {
  const me = snapshot.seats.find((s) => s.playerId === snapshot.you.playerId);
  const isHost = snapshot.hostPlayerId === snapshot.you.playerId;
  const canStart = isHost && snapshot.status === "ready";
  return (
    <div className="panel">
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

  return (
    <div className="setup">
      <label className="row">
        <span className="setup-label">Airport</span>
        <select
          value={setup.scenarioId}
          disabled={!editable}
          onChange={(e) => onChange({ ...setup, scenarioId: e.target.value as ScenarioId })}
        >
          {SCENARIO_IDS.map((id) => (
            <option key={id} value={id}>
              {SCENARIOS[id].name}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="setup-modules">
        <legend className="setup-label">Modules</legend>
        {MODULE_IDS.map((id) => {
          const available = IMPLEMENTED_MODULES.includes(id);
          return (
            <label key={id} className={available ? "" : "muted"}>
              <input
                type="checkbox"
                checked={setup.modules.includes(id)}
                disabled={!editable || !available}
                onChange={(e) => toggle(id, e.target.checked)}
              />
              {MODULE_LABELS[id]}
              {!available && " (soon)"}
            </label>
          );
        })}
      </fieldset>
      <fieldset className="setup-abilities">
        <legend className="setup-label">Special Abilities</legend>
        {ABILITY_IDS.map((id) => {
          const checked = setup.abilities.includes(id);
          return (
            <label key={id} title={ABILITY_TEXT[id]}>
              <input
                type="checkbox"
                checked={checked}
                disabled={!editable || (!checked && setup.abilities.length >= maxAbilities)}
                onChange={(e) => toggleAbility(id, e.target.checked)}
              />
              {ABILITY_LABELS[id]}
            </label>
          );
        })}
      </fieldset>
      <p className="muted setup-note">Choose up to {maxAbilities} Special Abilities.</p>
      {EXCLUSIVE_MODULE_GROUPS.map((group) => (
        <p key={group.join()} className="muted setup-note">
          {group.map((m) => MODULE_LABELS[m]).join(" or ")} — one or the other, not both.
        </p>
      ))}
      {!editable && <p className="muted">The host chooses the airport and modules.</p>}
    </div>
  );
}
