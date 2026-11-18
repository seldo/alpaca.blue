// Wipes everything this browser holds for the signed-in user: the IndexedDB
// post cache and the module-level caches (identity map, settings, shared
// platform clients, resolved mirrors). Call before logout and after an
// account disconnect/reset so nothing from the old account lingers.

import { clearLocalPosts } from "./store";
import { resetSharedClients } from "./clients";
import { resetIdentityMap } from "./identities";
import { resetSettings } from "./settings";
import { resetMirrorCache } from "./mirrors";

export async function clearLocalData(): Promise<void> {
  resetSharedClients();
  resetIdentityMap();
  resetSettings();
  resetMirrorCache();
  try {
    sessionStorage.clear();
  } catch { /* ignore */ }
  await clearLocalPosts().catch((err) => console.error("[local-data] clear failed:", err));
}
