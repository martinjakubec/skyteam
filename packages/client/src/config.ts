/**
 * Base URL the browser uses to reach the server.
 *
 * By default we derive it from the address the page itself was loaded from, so
 * the app works whether you open it on `localhost` or over the LAN (e.g.
 * `http://192.168.1.50:5173`) without any per-machine configuration. Set
 * `VITE_SERVER_URL` to pin an explicit URL (production, reverse proxy, etc.).
 * `VITE_SERVER_PORT` overrides just the port when deriving (default `3001`).
 */
function resolveServerUrl(): string {
  const override = import.meta.env.VITE_SERVER_URL;
  if (override) return override;

  const port = import.meta.env.VITE_SERVER_PORT ?? "3001";
  const { protocol, hostname } = window.location;
  return `${protocol}//${hostname}:${port}`;
}

export const SERVER_URL = resolveServerUrl();
