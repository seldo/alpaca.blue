// alpaca.blue streaming sync worker.
//
// A single always-on process (deployed to Fly) that keeps users' timelines warm
// in the DB/Redis in real time, so the Next.js app stays serverless and just
// reads. Phase 1 covers Bluesky via Jetstream; Mastodon streaming lands next.
//
// Env: loads .env.local for local dev; in production Fly injects the same
// DATABASE_*, UPSTASH_REDIS_*, and REDIS_KEY_PREFIX secrets, and .env.local is
// simply absent (dotenv no-ops). @/db and @/lib/redis read env at import time,
// so the heavy modules are pulled in via dynamic import *after* dotenv runs.

import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

async function main(): Promise<void> {
  console.log("[worker] starting alpaca.blue sync worker");
  const [{ startBlueskySync }, { startMastodonSync }, { startSseServer }] = await Promise.all([
    import("./bluesky-sync"),
    import("./mastodon-sync"),
    import("./sse-server"),
  ]);
  startSseServer();
  await Promise.all([startBlueskySync(), startMastodonSync()]);
  console.log("[worker] running");
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[worker] ${sig} received, shutting down`);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
