/**
 * The game log's move-string format, and what each of its codes means (the
 * "pairing table"). A logged game stores its format; a new format gets a new
 * number and keeps the old one decodable. The server mirrors this list into
 * the `move_codes` table.
 */
export const LOG_FORMAT = 1;

export interface MoveCode {
  code: string;
  meaning: string;
}

export const MOVE_CODES: readonly MoveCode[] = [
  // Tokens: each starts with one of these capitals (and none appears elsewhere).
  { code: "D", meaning: "Deal: the pilot's 4 dice, the co-pilot's 4, then one digit per Traffic die (starts every round)" },
  { code: "S", meaning: "Synchronisation: the Traffic die the server rolled" },
  { code: "T", meaning: "Real-Time: the round's time ran out" },
  { code: "P", meaning: "The Pilot acts (a die value, or one of ! ? ~ ^ * #, follows)" },
  { code: "C", meaning: "The Co-Pilot acts (a die value, or one of ! ? ~ ^ * #, follows)" },
  // Actions after P / C (a die value 1-6 alone means: place that die).
  { code: "!", meaning: "Reroll: the dice of these values [: their new values]; a bare ! declines" },
  { code: "?", meaning: "Anticipation: the die of this value : rerolled to this value" },
  { code: "~", meaning: "Adaptation: the die of this value turned over" },
  { code: "^", meaning: "Working Together: offer, or answer with, the die of this value" },
  { code: "*", meaning: "Place the Intern token on the space that follows" },
  { code: "#", meaning: "Place the Traffic die (Synchronisation) on the space that follows" },
  { code: "+", meaning: "Coffee spent raising the die by the digit that follows" },
  { code: "-", meaning: "Coffee spent lowering the die by the digit that follows" },
  { code: ":", meaning: "Separates a die's old value(s) from the new" },
  // Spaces (a digit after the letter is its slot, counted from 0).
  { code: "a", meaning: "Axis" },
  { code: "e", meaning: "Engine" },
  { code: "r", meaning: "Radio (slot)" },
  { code: "g", meaning: "Landing Gear (slot)" },
  { code: "f", meaning: "Flaps (slot)" },
  { code: "b", meaning: "Brakes (slot)" },
  { code: "c", meaning: "Concentration (slot)" },
  { code: "k", meaning: "Kerosene" },
  { code: "i", meaning: "Ice Brakes, top space (slot)" },
  { code: "j", meaning: "Ice Brakes, bottom space (slot)" },
  { code: "t", meaning: "Intern training" },
  { code: "'", meaning: "The other crew's side of a per-crew space (the Traffic die only)" },
];
