// Server-side fetch for user-supplied URLs (link-card previews, the Mastodon
// instance a user connects). Any signed-in
// user can make the server fetch a URL, and anyone with a Bluesky account can
// sign in, so this must not reach internal services:
//  • only http/https on the default ports;
//  • every address the hostname resolves to must be public, checked at
//    connect time (the undici `lookup` hook), so DNS rebinding can't swap in a
//    private address after a check;
//  • IP-literal hosts (which skip DNS) are checked directly;
//  • redirects are followed by hand, re-checking each hop;
//  • the timeout covers the whole exchange including the body, and bodies are
//    read with a byte cap instead of buffering whatever the server sends.

import { lookup as dnsLookup } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent, fetch } from "undici";

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["100::", 64], ["2001:db8::", 32],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(net, prefix, "ipv6");

// IPv6 forms that embed an IPv4 address (::ffff:a.b.c.d, NAT64 64:ff9b::/96)
// are judged by the embedded address.
function embeddedIpv4(addr: string): string | null {
  const m = addr.toLowerCase().match(/^(?:::ffff:|64:ff9b::)(?:0:)?([0-9.]+)$/);
  if (m && isIP(m[1]) === 4) return m[1];
  const hex = addr.toLowerCase().match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

export function isPublicAddress(addr: string): boolean {
  const family = isIP(addr);
  if (family === 4) return !blocked.check(addr, "ipv4");
  if (family === 6) {
    const v4 = embeddedIpv4(addr);
    if (v4) return !blocked.check(v4, "ipv4");
    return !blocked.check(addr, "ipv6");
  }
  return false;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | { address: string; family: number }[],
  family?: number,
) => void;

// net.connect lookup hook: resolve, refuse if *any* address is non-public.
function guardedLookup(hostname: string, options: { all?: boolean }, cb: LookupCallback) {
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) return cb(err, []);
    const list = addresses as { address: string; family: number }[];
    const bad = list.find((a) => !isPublicAddress(a.address));
    if (list.length === 0 || bad) {
      const e: NodeJS.ErrnoException = new Error(`Refusing to connect to non-public address for ${hostname}`);
      e.code = "EADDRNOTPUBLIC";
      return cb(e, []);
    }
    if (options?.all) return cb(null, list);
    return cb(null, list[0].address, list[0].family);
  });
}

const agent = new Agent({
  connect: { lookup: guardedLookup as unknown as never },
});

export class UnsafeUrlError extends Error {}

export function checkUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UnsafeUrlError("Invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new UnsafeUrlError("Only http(s) URLs");
  if (u.port && u.port !== "80" && u.port !== "443") throw new UnsafeUrlError("Non-default port");
  if (u.username || u.password) throw new UnsafeUrlError("Credentials in URL");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new UnsafeUrlError("Non-public address");
  } else if (host === "localhost" || host.endsWith(".localhost") || !host.includes(".")) {
    throw new UnsafeUrlError("Non-public host");
  }
  return u;
}

export interface SafeResponse {
  url: string; // final URL after redirects
  status: number;
  headers: Headers;
  body: Buffer;
}

// Fetches `url` with the guards above. Reads at most `maxBytes` of body; when
// `stopAt` is given, stops early once that (lowercase) marker has been read.
// Bodies larger than maxBytes are truncated unless `rejectOversize`, in which
// case null is returned. Redirects are followed (re-checked per hop) only for
// GET; any other method returns the 3xx response as-is rather than re-sending
// its body somewhere else.
export async function safeFetch(
  url: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs: number;
    maxBytes: number;
    maxRedirects?: number;
    stopAt?: string;
    rejectOversize?: boolean;
  },
): Promise<SafeResponse | null> {
  const method = (opts.method ?? "GET").toUpperCase();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    let current = checkUrl(url);
    for (let hop = 0; ; hop++) {
      const res = await fetch(current, {
        method,
        headers: opts.headers,
        body: opts.body,
        redirect: "manual",
        signal: controller.signal,
        dispatcher: agent,
      });
      if (method === "GET" && res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        await res.body?.cancel().catch(() => {});
        if (hop >= (opts.maxRedirects ?? 5)) return null;
        current = checkUrl(new URL(res.headers.get("location")!, current).href);
        continue;
      }

      const chunks: Buffer[] = [];
      let total = 0;
      let oversize = false;
      if (res.body) {
        const reader = res.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          if (total + chunk.length > opts.maxBytes) {
            oversize = true;
            chunks.push(chunk.subarray(0, opts.maxBytes - total));
            total = opts.maxBytes;
            break;
          }
          chunks.push(chunk);
          total += chunk.length;
          if (opts.stopAt && chunk.toString("latin1").toLowerCase().includes(opts.stopAt)) break;
        }
        await reader.cancel().catch(() => {});
      }
      if (oversize && opts.rejectOversize) return null;
      return {
        url: current.href,
        status: res.status,
        headers: res.headers as unknown as Headers,
        body: Buffer.concat(chunks),
      };
    }
  } finally {
    clearTimeout(timer);
  }
}

// fetch-shaped wrapper: same guards, returns a standard Response (with the
// capped body) so API callers can keep using res.ok / res.json() / headers.
// Throws (like fetch) when the URL is refused or the connection fails.
export async function safeRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  limits: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<Response> {
  const res = await safeFetch(url, {
    ...init,
    timeoutMs: limits.timeoutMs ?? 10_000,
    maxBytes: limits.maxBytes ?? 5 * 1024 * 1024,
    rejectOversize: true,
  });
  if (!res) throw new Error(`Request to ${new URL(url).host} failed (too many redirects or response too large)`);
  const nullBody = res.status === 204 || res.status === 304 || (res.status >= 300 && res.status < 400);
  return new Response(nullBody ? null : new Uint8Array(res.body), {
    status: res.status,
    headers: res.headers,
  });
}
