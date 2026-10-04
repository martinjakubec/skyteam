/**
 * Share one in-flight load per key: callers that ask for the same key while it
 * is loading get the same promise, so the same object. Without it, two
 * requests for a room that isn't cached yet (right after a restart) would each
 * parse their own copy from Redis, change their own copy, and the later save
 * would silently drop the other's change. Once a load settles, the next call
 * loads afresh (a failure isn't remembered).
 */
export function singleFlight<T>(load: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const inFlight = new Map<string, Promise<T>>();
  return (key) => {
    let p = inFlight.get(key);
    if (!p) {
      p = load(key).finally(() => inFlight.delete(key));
      inFlight.set(key, p);
    }
    return p;
  };
}
