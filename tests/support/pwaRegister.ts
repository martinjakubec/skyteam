// Stands in for vite-plugin-pwa's virtual:pwa-register/react (only the Vite
// build can produce it; vitest.config.mjs points the import here). A test sets
// `pwa.needRefresh` before rendering and reads `pwa.updated`.
import { useState } from "react";

export const pwa = { needRefresh: false, updated: 0 };

export function useRegisterSW(_options?: unknown) {
  const needRefresh = useState(pwa.needRefresh);
  const offlineReady = useState(false);
  return {
    needRefresh,
    offlineReady,
    updateServiceWorker: async (_reload?: boolean) => {
      pwa.updated++;
    },
  };
}
