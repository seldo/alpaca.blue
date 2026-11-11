import { NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requireSession, unauthorizedResponse } from "@/lib/session";

// GET → the user's preferences.
export async function GET() {
  const session = await requireSession();
  if (!session) return unauthorizedResponse();

  const [user] = await db
    .select({ repostFanout: users.repostFanout })
    .from(users)
    .where(eq(users.id, session.userId!))
    .limit(1);
  if (!user) return unauthorizedResponse();

  return NextResponse.json({ repostFanout: user.repostFanout });
}

// PATCH {repostFanout?: boolean} → updates the given preferences.
export async function PATCH(request: Request) {
  const session = await requireSession();
  if (!session) return unauthorizedResponse();

  const body = await request.json().catch(() => null);
  if (typeof body?.repostFanout !== "boolean") {
    return NextResponse.json({ error: "repostFanout must be a boolean" }, { status: 400 });
  }

  await db
    .update(users)
    .set({ repostFanout: body.repostFanout })
    .where(eq(users.id, session.userId!));

  return NextResponse.json({ repostFanout: body.repostFanout });
}
