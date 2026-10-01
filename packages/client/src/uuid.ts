/**
 * A v4 UUID that also works in non-secure contexts.
 *
 * `crypto.randomUUID()` is only exposed on HTTPS or `localhost`, so it is
 * `undefined` when the app is opened over plain HTTP on the LAN (e.g.
 * `http://192.168.1.50:5173`). `crypto.getRandomValues()` *is* available there,
 * so we fall back to building the UUID from it.
 */
export function uuid(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}
