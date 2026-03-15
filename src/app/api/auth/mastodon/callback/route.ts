import { NextRequest, NextResponse } from "next/server";
import { exchangeMastodonToken, saveMastodonAccount } from "@/lib/mastodon";
import { cookies } from "next/headers";

export async function GET(request: NextRequest) {
  try {
    const code = request.nextUrl.searchParams.get("code");

    if (!code) {
      return NextResponse.redirect(
        new URL("/?error=mastodon_auth_failed", request.url)
      );
    }

    const cookieStore = await cookies();
    const instanceUrl = cookieStore.get("mastodon_instance")?.value;
    const clientId = cookieStore.get("mastodon_client_id")?.value;
    const clientSecret = cookieStore.get("mastodon_client_secret")?.value;

    if (!instanceUrl || !clientId || !clientSecret) {
      return NextResponse.redirect(
        new URL("/?error=mastodon_session_expired", request.url)
      );
    }

    const proto = request.headers.get("x-forwarded-proto") || "http";
    const host = request.headers.get("host") || "localhost:3000";
    const appOrigin = `${proto}://${host}`;

    const accessToken = await exchangeMastodonToken(
      instanceUrl,
      clientId,
      clientSecret,
      code,
      appOrigin
    );

    await saveMastodonAccount(instanceUrl, accessToken);

    // Clean up cookies
    cookieStore.delete("mastodon_instance");
    cookieStore.delete("mastodon_client_id");
    cookieStore.delete("mastodon_client_secret");

    return NextResponse.redirect(new URL("/?connected=mastodon", request.url));
  } catch (error) {
    console.error("Mastodon callback error:", error);
    return NextResponse.redirect(
      new URL("/?error=mastodon_auth_failed", request.url)
    );
  }
}
