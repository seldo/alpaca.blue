import { NextResponse } from "next/server";
import { runResolutionPipeline } from "@/lib/identity-resolution";

export async function POST() {
  try {
    const stats = await runResolutionPipeline();
    return NextResponse.json(stats);
  } catch (err) {
    console.error("Resolution pipeline error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Resolution failed" },
      { status: 500 }
    );
  }
}
