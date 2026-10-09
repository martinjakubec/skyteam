/**
 * Base URL the browser uses to reach the server.
 *
 * - `VITE_SERVER_URL`, when set, pins it (e.g. `docker-compose.yml` sends the
 *   browser straight to `:3001`).
 * - A production build otherwise uses the page's own origin: the site's
 *   proxy (the client's nginx) forwards the API and the WebSocket to the
 *   server, so there's no CORS and nothing to configure per deployment.
 * - Development derives it from the address the page was loaded from, so the
 *   app works on `localhost` or over the LAN (e.g. `http://192.168.1.50:5173`)
 *   without per-machine configuration. `VITE_SERVER_PORT` overrides the port
 *   (default `3001`).
 */
export function resolveServerUrl(): string {
  const override = import.meta.env.VITE_SERVER_URL;
  if (override) return override;
  if (import.meta.env.PROD) return window.location.origin;

  const port = import.meta.env.VITE_SERVER_PORT ?? "3001";
  const { protocol, hostname } = window.location;
  return `${protocol}//${hostname}:${port}`;
}

export const SERVER_URL = resolveServerUrl();
