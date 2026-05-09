import { IANA_TLDS } from "./iana-tlds";

// Right-edge punctuation users commonly type immediately after a URL. Stripped
// from the URL itself but preserved in the surrounding text.
const TRAILING_PUNCT = /[.,!?;:)\]}>"']+$/;

function looksLikeDomain(host: string): boolean {
  const lower = host.toLowerCase();
  const lastDot = lower.lastIndexOf(".");
  if (lastDot < 1 || lastDot === lower.length - 1) return false;
  return IANA_TLDS.has(lower.slice(lastDot + 1));
}

// Replaces bare-domain tokens in `text` with their `https://` URL equivalent
// so platforms can linkify them server-side. The token's TLD is validated
// against the official IANA list (regenerate via scripts/regenerate-tlds.sh).
//
// Boundary rules:
// - Left side must be start-of-string, whitespace, or one of `(` `[` `<` so
//   `@user@instance.com` (Mastodon handle) and `user@example.com` (email) are
//   skipped — the `@` isn't a candidate-start boundary, so the regex won't
//   even attempt to match the right-of-`@` portion as a domain.
// - URLs already prefixed with `://` are skipped because the boundary char
//   ends up being `/`, which isn't in the boundary class.
// - Trailing punctuation is stripped from the URL but preserved in the text.
export function expandBareDomains(text: string): string {
  if (!text) return text;
  return text.replace(
    /(^|[\s(\[<])([a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+(?:\/[^\s)\]>"']*)?)/gi,
    (match, before: string, candidate: string) => {
      const trailingMatch = candidate.match(TRAILING_PUNCT);
      const trailing = trailingMatch ? trailingMatch[0] : "";
      const core = trailing ? candidate.slice(0, -trailing.length) : candidate;
      const host = core.split("/")[0];
      if (!looksLikeDomain(host)) return match;
      return `${before}https://${core}${trailing}`;
    },
  );
}
