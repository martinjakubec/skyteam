import type { Crew } from "./types";

export function label(crew: Crew): string {
  return crew === "pilot" ? "Pilot" : "Co-Pilot";
}
export function face(v: number | null): string {
  return v === null ? "" : String(v);
}
export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
