import { NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requireSession, unauthorizedResponse } from "@/lib/session";

export async function GET() {
  const session = await requireSession();
  if (!session) return unauthorizedResponse();

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, session.userId!))
    .limit(1);

  if (!user) {
    session.destroy();
    return unauthorizedResponse();
  }

  return NextResponse.json({
    id: user.id,
    blueskyHandle: user.blueskyHandle,
    displayName: user.displayName,
  });
}
