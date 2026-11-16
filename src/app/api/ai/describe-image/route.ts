import { NextRequest, NextResponse } from "next/server";
import { requireSession, unauthorizedResponse } from "@/lib/session";

// POST FormData{file: image} → { description: string }
// Uses Claude Haiku vision to generate concise alt text suitable for screen readers.
export async function POST(request: NextRequest) {
  const session = await requireSession();
  if (!session) return unauthorizedResponse();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "AI is not configured" }, { status: 500 });
  }

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  if (!file) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

  if (!file.type.startsWith("image/")) {
    return NextResponse.json({ error: "file must be an image" }, { status: 400 });
  }

  const arrayBuffer = await file.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  const mediaType = file.type;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-5-5",
      max_tokens: 200,
      // Haiku 5.5 thinks by default; alt text doesn't need it, and thinking
      // would eat the small token budget.
      thinking: { type: "disabled" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: base64 },
            },
            {
              type: "text",
              text:
                "Generate concise alt text for this image, suitable for a screen reader on a social media post. " +
                "Describe what's visible factually and informatively. Maximum 250 characters. " +
                "Output only the alt text itself — no preamble, no quotes, no markdown.",
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error("[ai/describe-image] Claude API error:", response.status, errText);
    return NextResponse.json({ error: "AI request failed" }, { status: 502 });
  }

  const data = await response.json();
  if (data.stop_reason === "refusal") {
    console.error("[ai/describe-image] Claude refused:", data.stop_details);
    return NextResponse.json({ error: "AI declined to describe this image" }, { status: 502 });
  }
  const description = (data.content ?? [])
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("")
    .trim();
  return NextResponse.json({ description });
}
