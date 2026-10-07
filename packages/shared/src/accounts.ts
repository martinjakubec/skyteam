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
