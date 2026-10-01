import type { CorsOptions } from "cors";
import { env } from "./env";

// CLIENT_ORIGIN controls which browser origins may talk to the server:
//   "*"                         -> reflect any origin (handy for LAN / dev)
//   "http://a:5173,http://b"    -> comma-separated allowlist
const allowlist = env.CLIENT_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean);
const allowAny = allowlist.includes("*");

export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // non-browser clients (curl, health checks) send no Origin
  return allowAny || allowlist.includes(origin);
}

// Shared by the Express middleware and Socket.IO (both use the `cors` package).
// The function form reflects the caller's origin when allowed, which is what
// makes credentialed requests work across an open (`*`) allowlist.
export const corsOptions: CorsOptions = {
  origin: (origin, cb) => cb(null, isOriginAllowed(origin)),
  credentials: true,
};
