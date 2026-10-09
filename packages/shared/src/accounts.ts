import { z } from "zod";

/**
 * Accounts: what the server and the client agree on. Guests play without one;
 * an account adds a game history. Roles and the privileges they grant live in
 * the database — these are the defaults it starts with.
 */

export type Role = "USER" | "ADMIN" | "SUPERADMIN";
export type Privilege = "history" | "view_stats" | "manage_users";

/** The signed-in user, as the client sees them. */
export interface PublicUser {
  id: string;
  username: string;
  role: string;
  privileges: string[];
}

export const USERNAME_RULE = "Use 3–24 letters, digits, dots, dashes or underscores.";
export const MIN_PASSWORD_LENGTH = 10;

export const Username = z.string().trim().toLowerCase().regex(/^[a-z0-9_.-]{3,24}$/, USERNAME_RULE);
export const NewPassword = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters for the password.`)
  .max(200, "Use at most 200 characters for the password.");
/** An existing password: whatever was set, even a short one from before the rules. */
const AnyPassword = z.string().min(1, "Enter your password.").max(200);
const AnyUsername = z.string().trim().toLowerCase().min(1, "Enter your username.").max(24);

export const RegisterPayload = z.object({ username: Username, password: NewPassword });
export const LoginPayload = z.object({ username: AnyUsername, password: AnyPassword });
export const RecoverPayload = z.object({ username: AnyUsername, recoveryCode: z.string().min(1, "Enter your recovery code.").max(40), newPassword: NewPassword });
export const ResetPayload = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "This reset link is not valid."), newPassword: NewPassword });
export const ChangePasswordPayload = z.object({ currentPassword: AnyPassword, newPassword: NewPassword });
export const PasswordPayload = z.object({ password: AnyPassword });

/** What registering, recovering and resetting answer: the user, and their new
 *  recovery code (shown once). */
export interface AccountWithCode {
  user: PublicUser;
  recoveryCode: string;
}

/** One of my games, in my history. */
export interface GameSummary {
  id: string;
  scenario: string;
  modules: string[];
  abilities: string[];
  result: string;
  lossReason: string | null;
  roundsReached: number;
  /** The seat I flew. */
  crew: "pilot" | "copilot";
  /** Who flew the other seat: a username, "Guest", or "Bot (<level>)". */
  partner: string;
  endedAt: string;
  /** Flown on an earlier game's dice ("Fly the same dice"). */
  seeded: boolean;
}

/** A logged game as its page shows it — anyone with its link may see it. Never
 *  its seed, nor the room it was played in. */
export interface GameRecord {
  id: string;
  format: number;
  setup: { scenarioId: string; modules: string[]; abilities: string[] };
  internTokens: number[];
  moves: string;
  result: string;
  lossReason: string | null;
  roundsReached: number;
  /** Who flew each seat: a username, "Guest", or "Bot (<level>)". */
  crews: { pilot: string; copilot: string };
  startedAt: string;
  endedAt: string;
  /** It has a seed: a new game can be flown on the same dice. */
  sameDiceAvailable: boolean;
  /** The game whose dice this one was flown on, if any. */
  seededFrom: string | null;
}

/** The statistics dashboard (docs/game-log-queries.sql, queries 1–7, and the
 *  latest games). Rates are percentages with one decimal. */
export interface AdminStats {
  generatedAt: string;
  /** Games flown on an earlier game's dice are counted too. */
  includeSeeded: boolean;
  /** How many games were flown on an earlier game's dice. */
  seededGames: number;
  playRate: { scenario: string; games: number; pct_of_all_games: number; finished: number; finish_pct: number; pct_of_finished_games: number | null }[];
  crashCauses: { scenario: string; cause: string; losses: number; pct_of_airport_losses: number }[];
  failedLandings: { scenario: string; condition: string; failed_landings: number }[];
  winRateByAirport: { scenario: string; finished: number; won: number; lost: number; win_pct: number }[];
  winRateByAbility: { ability: string; finished: number; win_pct: number }[];
  winRateByModule: { module: string; finished: number; win_pct: number }[];
  humansVsBot: { scenario: string; crew: string; finished: number; win_pct: number }[];
  unfinished: { result: string; rounds_reached: number; games: number }[];
  recentGames: {
    id: string;
    scenario: string;
    result: string;
    loss_reason: string | null;
    rounds_reached: number;
    pilot: string;
    copilot: string;
    ended_at: string;
    seeded: boolean;
  }[];
}
