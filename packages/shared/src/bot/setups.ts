import { ABILITY_IDS, DEFAULT_MAX_ABILITIES } from "../game/abilities";
import { SCENARIOS, SCENARIO_TEMPLATES, type GameSetup } from "../game/catalog";
import { IMPLEMENTED_MODULES, type ModuleId } from "../game/scenario";
import { SetSetupPayload } from "../protocol";

const subsets = <T>(xs: readonly T[]): T[][] => xs.reduce<T[][]>((acc, x) => [...acc, ...acc.map((c) => [...c, x])], [[]]);
const valid = (s: GameSetup) => SetSetupPayload.safeParse(s).success;
/** YUL allows no Special Abilities, so ability setups fly a card that allows two (green-PRG). */
const ABILITY_BOARD = SCENARIO_TEMPLATES.find((t) => t.abilityCount === 2)!.id;

/** Every module combination the lobby accepts (exclusive groups respected). */
const moduleSets = (): ModuleId[][] => subsets(IMPLEMENTED_MODULES).filter((modules) => valid({ scenarioId: "YUL", modules, abilities: [] }));

/** Each card as printed: its implemented modules, and as many Special Abilities
 *  as its ★ allows, rotating through them card by card. */
export function cardSetups(): GameSetup[] {
  let next = 0;
  return SCENARIO_TEMPLATES.map((t) => {
    const abilities = Array.from({ length: t.abilityCount }, () => ABILITY_IDS[next++ % ABILITY_IDS.length]);
    return { scenarioId: t.id === "green-YUL" ? "YUL" : t.id, modules: t.modules.filter((m) => IMPLEMENTED_MODULES.includes(m)), abilities };
  });
}

/** Fast coverage: every card, every module combination, each ability alone and
 *  with the largest module combination. */
export function representativeSetups(): GameSetup[] {
  const sets = moduleSets();
  const richest = sets.reduce((m, c) => (c.length > m.length ? c : m), [] as ModuleId[]);
  return [
    ...cardSetups(),
    ...sets.map((modules) => ({ scenarioId: "YUL", modules, abilities: [] })),
    ...ABILITY_IDS.flatMap((a) => [
      { scenarioId: ABILITY_BOARD, modules: [], abilities: [a] },
      { scenarioId: ABILITY_BOARD, modules: richest, abilities: [a] },
    ]),
  ].filter(valid);
}

/** Every module combination × every ability set the lobby accepts, plus every
 *  card. Module-only setups fly YUL; ability setups fly ABILITY_BOARD. */
export function allSetups(): GameSetup[] {
  const max = SCENARIOS[ABILITY_BOARD].maxAbilities ?? DEFAULT_MAX_ABILITIES;
  const abilitySets = subsets(ABILITY_IDS).filter((a) => a.length > 0 && a.length <= max);
  return [
    ...cardSetups(),
    ...moduleSets().flatMap((modules) => [
      { scenarioId: "YUL", modules, abilities: [] },
      ...abilitySets.map((abilities) => ({ scenarioId: ABILITY_BOARD, modules, abilities })),
    ]),
  ].filter(valid);
}
