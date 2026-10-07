import type { AccountWithCode, PublicUser } from "@skyteam/shared";
import { SERVER_URL } from "../config";

/**
 * The server's JSON API (/api). Every call sends the sign-in cookie
 * (credentials: include) and answers either the body with `ok: true`, or the
 * server's error text — never throws.
 */

export type ApiResult<T> = ({ ok: true; status: number } & T) | { ok: false; status: number; error: string };

export async function call<T extends object = object>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(`${SERVER_URL}/api${path}`, {
      method,
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    });
  } catch {
    return { ok: false, status: 0, error: "Can't reach the server — check your connection and try again." };
  }
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, status: res.status, ...(data as T) };
  return { ok: false, status: res.status, error: (data as { error?: string }).error ?? `The server answered ${res.status}.` };
}

export const authApi = {
  me: () => call<{ user: PublicUser | null }>("GET", "/auth/me"),
  register: (username: string, password: string) => call<AccountWithCode>("POST", "/auth/register", { username, password }),
  login: (username: string, password: string) => call<{ user: PublicUser }>("POST", "/auth/login", { username, password }),
  logout: () => call("POST", "/auth/logout"),
  recover: (username: string, recoveryCode: string, newPassword: string) =>
    call<AccountWithCode>("POST", "/auth/recover", { username, recoveryCode, newPassword }),
  reset: (token: string, newPassword: string) => call<AccountWithCode>("POST", "/auth/reset", { token, newPassword }),
  changePassword: (currentPassword: string, newPassword: string) => call<{ user: PublicUser }>("POST", "/account/password", { currentPassword, newPassword }),
  newRecoveryCode: (password: string) => call<{ recoveryCode: string }>("POST", "/account/recovery-code", { password }),
  signOutEverywhere: () => call("POST", "/account/sign-out-everywhere"),
  deleteAccount: (password: string) => call("DELETE", "/account", { password }),
};
