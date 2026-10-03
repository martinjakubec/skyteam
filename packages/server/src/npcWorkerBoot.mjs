// Worker entry: register tsx in this thread (the server runs TypeScript through
// tsx, and a worker doesn't inherit its loader), then load the real worker.
import { register } from "tsx/esm/api";

register();
await import("./npcWorker.ts");
