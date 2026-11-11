// User preferences, fetched from /api/settings once per page load and cached.
// If the fetch fails, the defaults apply (which match the pre-settings behavior).

export interface Settings {
  repostFanout: boolean; // repost to both networks, not just the post's own
}

const DEFAULTS: Settings = { repostFanout: true };

let settingsPromise: Promise<Settings> | null = null;

export function getSettings(): Promise<Settings> {
  if (!settingsPromise) {
    settingsPromise = fetch("/api/settings")
      .then((res) => (res.ok ? res.json() : DEFAULTS))
      .then((data) => ({ ...DEFAULTS, ...data }))
      .catch(() => {
        settingsPromise = null; // don't cache a failure; retry next time
        return DEFAULTS;
      });
  }
  return settingsPromise;
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const res = await fetch("/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Saving settings failed: ${res.status}`);
  const next = { ...(await getSettings()), ...(await res.json()) };
  settingsPromise = Promise.resolve(next);
  return next;
}
