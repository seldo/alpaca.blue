export async function GET() {
  const origin = (process.env.APP_URL || "https://alpaca.blue").replace(/\/$/, "");
  const clientId = `${origin}/api/client-metadata`;

  return Response.json({
    client_id: clientId,
    client_name: "alpaca.blue",
    client_uri: origin,
    redirect_uris: [`${origin}/api/auth/bluesky/callback`],
    scope: "atproto transition:generic",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "web",
    dpop_bound_access_tokens: true,
  });
}
