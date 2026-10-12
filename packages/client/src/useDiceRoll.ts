import { useEffect, useRef, useState } from "react";
import type { RerollNote } from "@skyteam/shared";
import { useMediaQuery } from "./useMediaQuery";

/** How long a rerolled die tumbles before it shows its new face. */
export const ROLL_MS = 600;
const FLICKER_MS = 70;

/**
 * The dice of my newest reroll, while they roll: their ids, and each one's
 * flickering face (none with reduced motion — the die only flashes). Rerolls
 * already made when the cockpit opens (a reload, a reconnect) don't roll again.
 */
export function useDiceRoll(rerolls: RerollNote[]): { ids: number[]; faces: Record<number, number> } {
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const seen = useRef(rerolls.length);
  const timers = useRef<{ tick?: ReturnType<typeof setInterval>; stop?: ReturnType<typeof setTimeout> }>({});
  const [ids, setIds] = useState<number[]>([]);
  const [faces, setFaces] = useState<Record<number, number>>({});

  const stopTimers = () => {
    clearInterval(timers.current.tick);
    clearTimeout(timers.current.stop);
  };

  useEffect(() => {
    const grew = rerolls.length > seen.current;
    seen.current = rerolls.length; // a new game starts its list over
    if (!grew) return;
    const rolled = rerolls[rerolls.length - 1].dieIds;
    const flicker = () => setFaces(Object.fromEntries(rolled.map((id) => [id, 1 + Math.floor(Math.random() * 6)])));
    stopTimers();
    setIds(rolled);
    if (reduced) setFaces({});
    else {
      flicker();
      timers.current.tick = setInterval(flicker, FLICKER_MS);
    }
    timers.current.stop = setTimeout(() => {
      stopTimers();
      setIds([]);
      setFaces({});
    }, ROLL_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rerolls.length]);

  useEffect(() => stopTimers, []);

  return { ids, faces };
}

/** A reroll for the log, old face → new: "Your dice: 6 → 6, 5 → 2". */
export function rerollText(note: RerollNote): string {
  const pairs = note.from.map((was, i) => `${was} → ${note.to[i]}`).join(", ");
  return `${note.dieIds.length === 1 ? "Your die" : "Your dice"}: ${pairs}`;
}
