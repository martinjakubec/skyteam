import type { ModuleId } from "@skyteam/shared";
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

/**
 * Dev-only: force a module's UI on with `?preview=kerosene` (comma-separated
 * for several), so a module can be laid out before the server implements it.
 * Read once at load — creating a room rewrites the URL to `?join=…`. Always
 * empty in production builds.
 */
const PREVIEW_MODULES: string[] = import.meta.env.DEV
  ? (new URLSearchParams(window.location.search).get("preview")?.split(",") ?? [])
  : [];

export function previewModule(id: ModuleId): boolean {
  return PREVIEW_MODULES.includes(id);
}
