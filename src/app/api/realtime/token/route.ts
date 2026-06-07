import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { requireSession, unauthorizedResponse } from "@/lib/session";
import { redis, keys, TTL } from "@/lib/redis";

// Mints a short-lived token the browser uses to authenticate its EventSource to
// the streaming worker. The worker validates it against the shared Redis. We
// return the worker URL too so the client doesn't need a build-time public env.
export async function GET() {
  const session = await requireSession();
  if (!session) return unauthorizedResponse();

  const workerUrl = process.env.WORKER_URL;
  if (!workerUrl) {
    // Realtime not configured (e.g. worker not deployed in this environment).
    return NextResponse.json({ token: null, workerUrl: null });
  }

  const token = randomBytes(24).toString("hex");
  await redis
    .set(keys.realtimeToken(token), session.userId, { ex: TTL.realtimeToken })
    .catch(() => {});

  return NextResponse.json({ token, workerUrl });
}
