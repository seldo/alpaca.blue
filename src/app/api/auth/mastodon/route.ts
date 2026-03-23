import { NextRequest, NextResponse } from "next/server";
import { registerMastodonApp, getMastodonAuthUrl } from "@/lib/mastodon";
import { cookies } from "next/headers";
import { requireSession, unauthorizedResponse } from "@/lib/session";

function getAppOrigin(request: NextRequest): string {
  const proto = request.headers.get("x-forwarded-proto") || "http";
  const host = request.headers.get("host") || "localhost:3000";
  return `${proto}://${host}`;
}

export async function POST(request: NextRequest) {
  try {
    const session = await requireSession();
    if (!session) return unauthorizedResponse();

    const { instanceUrl } = await request.json();

    if (!instanceUrl) {
      return NextResponse.json(
        { error: "Instance URL is required" },
        { status: 400 }
      );
    }

    // Normalize the instance URL
    let normalizedUrl = instanceUrl.trim();
    if (!normalizedUrl.startsWith("https://")) {
      normalizedUrl = `https://${normalizedUrl}`;
    }
    // Remove trailing slash
    normalizedUrl = normalizedUrl.replace(/\/+$/, "");

    const appOrigin = getAppOrigin(request);
    const app = await registerMastodonApp(normalizedUrl, appOrigin);
    const authUrl = getMastodonAuthUrl(normalizedUrl, app.client_id, appOrigin);

    // Store client credentials in cookies for the callback
    const cookieStore = await cookies();
    cookieStore.set("mastodon_instance", normalizedUrl, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 600, // 10 minutes
    });
    cookieStore.set("mastodon_client_id", app.client_id, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 600,
    });
    cookieStore.set("mastodon_client_secret", app.client_secret, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 600,
    });

    return NextResponse.json({ authUrl });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to start OAuth flow";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
