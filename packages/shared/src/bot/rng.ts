import type { Rand } from "../game/entropy";

/** Small, fast, seedable PRNG (mulberry32) as a Rand — reproducible self-play. */
export function mulberry32(seed: number): Rand {
  let a = seed >>> 0;
  return (n: number) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}
