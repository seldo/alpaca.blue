import { db } from "@/db";
import {
  persons,
  platformIdentities,
  matchSuggestions,
} from "@/db/schema";
import { eq, and, isNull, inArray } from "drizzle-orm";

// ── Types ──────────────────────────────────────────────────

interface PlatformIdentityRow {
  id: number;
  platform: string;
  handle: string;
  did: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  profileUrl: string | null;
  verifiedDomain: string | null;
  personId: number | null;
}

interface CandidatePair {
  bluesky: PlatformIdentityRow;
  mastodon: PlatformIdentityRow;
  heuristicScore: number;
  reasons: string[];
}

interface LLMMatchResult {
  pairIndex: number;
  isSamePerson: boolean;
  confidence: number;
  reasoning: string;
}

export interface ResolutionStats {
  candidatesFound: number;
  llmEvaluated: number;
  autoConfirmed: number;
  suggestionsCreated: number;
}

// ── Helpers ────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractUsername(platform: string, handle: string): string {
  if (platform === "bluesky") {
    // "seldo.com" → "seldo", "seldo.bsky.social" → "seldo"
    return handle.split(".")[0].toLowerCase();
  }
  // "@seldo@mastodon.social" → "seldo"
  const match = handle.match(/^@?([^@]+)@/);
  return match ? match[1].toLowerCase() : handle.toLowerCase();
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0)
  );
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// ── Heuristic matching ─────────────────────────────────────

function findBioCrossLinks(
  bluesky: PlatformIdentityRow,
  mastodon: PlatformIdentityRow
): number {
  let score = 0;
  const bsBio = (bluesky.bio || "").toLowerCase();
  const msBio = stripHtml(mastodon.bio || "").toLowerCase();

  const bsUsername = extractUsername("bluesky", bluesky.handle);
  const msUsername = extractUsername("mastodon", mastodon.handle);
  const msInstance = mastodon.handle.match(/@([^@]+)$/)?.[1] || "";

  // Bluesky bio mentions Mastodon handle or instance
  const bsHasMastodon =
    bsBio.includes(msUsername + "@" + msInstance) ||
    bsBio.includes(msInstance + "/@" + msUsername) ||
    bsBio.includes(msInstance + "/" + msUsername) ||
    bsBio.includes("mastodon") && bsBio.includes(msUsername);

  // Mastodon bio mentions Bluesky handle
  const msHasBluesky =
    msBio.includes(bluesky.handle.toLowerCase()) ||
    msBio.includes("bsky.app/profile/" + bluesky.handle.toLowerCase()) ||
    msBio.includes("bluesky") && msBio.includes(bsUsername);

  if (bsHasMastodon && msHasBluesky) score = 0.6;
  else if (bsHasMastodon || msHasBluesky) score = 0.4;

  return score;
}

function scoreHandleSimilarity(
  bluesky: PlatformIdentityRow,
  mastodon: PlatformIdentityRow
): number {
  const bsUser = extractUsername("bluesky", bluesky.handle);
  const msUser = extractUsername("mastodon", mastodon.handle);

  if (bsUser === msUser) return 0.3;
  if (bsUser.length > 2 && msUser.length > 2 && levenshtein(bsUser, msUser) <= 2)
    return 0.15;
  return 0;
}

function scoreDisplayName(
  bluesky: PlatformIdentityRow,
  mastodon: PlatformIdentityRow
): number {
  const bsName = (bluesky.displayName || "").trim().toLowerCase();
  const msName = (mastodon.displayName || "").trim().toLowerCase();

  if (!bsName || !msName) return 0;
  if (bsName === msName) return 0.2;
  if (
    bsName.length > 3 &&
    msName.length > 3 &&
    (bsName.includes(msName) || msName.includes(bsName))
  )
    return 0.1;
  return 0;
}

function scoreVerifiedDomain(
  bluesky: PlatformIdentityRow,
  mastodon: PlatformIdentityRow
): number {
  // For Bluesky, a non-bsky.social handle IS the verified domain
  const bsDomain = bluesky.handle.endsWith(".bsky.social")
    ? null
    : bluesky.handle.toLowerCase();
  const msDomain = (mastodon.verifiedDomain || "").toLowerCase() || null;

  if (bsDomain && msDomain && bsDomain === msDomain) return 0.4;
  return 0;
}

export function generateCandidatePairs(
  blueskyList: PlatformIdentityRow[],
  mastodonList: PlatformIdentityRow[]
): CandidatePair[] {
  const candidates: CandidatePair[] = [];

  for (const bs of blueskyList) {
    for (const ms of mastodonList) {
      const reasons: string[] = [];
      let score = 0;

      const crossLink = findBioCrossLinks(bs, ms);
      if (crossLink > 0) {
        score += crossLink;
        reasons.push("bio_crosslink");
      }

      const handleSim = scoreHandleSimilarity(bs, ms);
      if (handleSim > 0) {
        score += handleSim;
        reasons.push("handle_match");
      }

      const nameSim = scoreDisplayName(bs, ms);
      if (nameSim > 0) {
        score += nameSim;
        reasons.push("display_name_match");
      }

      const domainSim = scoreVerifiedDomain(bs, ms);
      if (domainSim > 0) {
        score += domainSim;
        reasons.push("verified_domain");
      }

      score = Math.min(score, 1.0);

      if (score > 0.2) {
        candidates.push({
          bluesky: bs,
          mastodon: ms,
          heuristicScore: score,
          reasons,
        });
      }
    }
  }

  candidates.sort((a, b) => b.heuristicScore - a.heuristicScore);
  return candidates;
}

// ── LLM evaluation ─────────────────────────────────────────

const LLM_SYSTEM_PROMPT = `You are an identity resolution expert. You will be given pairs of social media profiles from Bluesky and Mastodon. For each pair, determine if they are the same person.

Consider:
- Cross-references in bios (links or mentions of other platform accounts)
- Username/handle similarity
- Display name similarity
- Bio content similarity (topics, writing style, self-description)
- Profile photos cannot be compared (text only)

Be conservative: only return high confidence if there is strong evidence. A matching username alone is NOT sufficient for high confidence — many people use the same common username. Look for corroborating evidence like matching bios, cross-links, or matching display names combined with matching handles.

Respond with ONLY a JSON array. For each pair, return:
{"pair_index": <number>, "is_same_person": <boolean>, "confidence": <number 0-1>, "reasoning": "<brief explanation>"}`;

function buildUserPrompt(candidates: CandidatePair[]): string {
  const pairs = candidates.map((c, i) => {
    const bsBio = c.bluesky.bio || "(no bio)";
    const msBio = stripHtml(c.mastodon.bio || "(no bio)");
    return `Pair ${i}:
  Bluesky: handle="${c.bluesky.handle}", displayName="${c.bluesky.displayName || ""}", bio="${bsBio}"
  Mastodon: handle="${c.mastodon.handle}", displayName="${c.mastodon.displayName || ""}", bio="${msBio}"`;
  });

  return `Evaluate these profile pairs:\n\n${pairs.join("\n\n")}`;
}

async function evaluateBatchWithLLM(
  candidates: CandidatePair[]
): Promise<LLMMatchResult[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: LLM_SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(candidates) }],
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude API error: ${response.status} ${error}`);
  }

  const data = await response.json();
  const text =
    data.content?.[0]?.text || "";

  // Extract JSON array from response (may be wrapped in markdown code fences)
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.error("Failed to parse LLM response:", text);
    return [];
  }

  try {
    const results: Array<{
      pair_index: number;
      is_same_person: boolean;
      confidence: number;
      reasoning: string;
    }> = JSON.parse(jsonMatch[0]);

    return results.map((r) => ({
      pairIndex: r.pair_index,
      isSamePerson: r.is_same_person,
      confidence: r.confidence,
      reasoning: r.reasoning,
    }));
  } catch {
    console.error("Failed to parse LLM JSON:", jsonMatch[0]);
    return [];
  }
}

// ── Person creation ────────────────────────────────────────

async function createPersonFromMatch(
  userId: number,
  blueskyId: number,
  mastodonId: number,
  confidence: number,
  blueskyName: string | null,
  mastodonName: string | null
): Promise<number> {
  const displayName = blueskyName || mastodonName || "Unknown";

  const [result] = await db.insert(persons).values({
    userId,
    displayName,
    autoMatched: true,
    matchConfidence: confidence,
  });

  const personId = result.insertId;

  await db
    .update(platformIdentities)
    .set({ personId })
    .where(
      inArray(platformIdentities.id, [blueskyId, mastodonId])
    );

  return personId;
}

// ── Pipeline orchestrator ──────────────────────────────────

export async function runResolutionPipeline(userId: number): Promise<ResolutionStats> {
  const stats: ResolutionStats = {
    candidatesFound: 0,
    llmEvaluated: 0,
    autoConfirmed: 0,
    suggestionsCreated: 0,
  };

  // 1. Fetch all identities
  const blueskyIdentities = await db
    .select()
    .from(platformIdentities)
    .where(
      and(
        eq(platformIdentities.userId, userId),
        eq(platformIdentities.platform, "bluesky"),
        eq(platformIdentities.isFollowed, true)
      )
    );

  const mastodonIdentities = await db
    .select()
    .from(platformIdentities)
    .where(
      and(
        eq(platformIdentities.userId, userId),
        eq(platformIdentities.platform, "mastodon"),
        eq(platformIdentities.isFollowed, true)
      )
    );

  if (blueskyIdentities.length === 0 || mastodonIdentities.length === 0) {
    return stats;
  }

  // 2. Generate candidate pairs
  const candidates = generateCandidatePairs(blueskyIdentities, mastodonIdentities);
  stats.candidatesFound = candidates.length;

  if (candidates.length === 0) return stats;

  // 3. Filter out already-evaluated pairs
  const existingSuggestions = await db
    .select({
      bsId: matchSuggestions.blueskyIdentityId,
      msId: matchSuggestions.mastodonIdentityId,
    })
    .from(matchSuggestions);

  const existingPairKeys = new Set(
    existingSuggestions.map((s) => `${s.bsId}-${s.msId}`)
  );

  const newCandidates = candidates.filter(
    (c) => !existingPairKeys.has(`${c.bluesky.id}-${c.mastodon.id}`)
  );

  if (newCandidates.length === 0) return stats;

  // 4. Batch LLM evaluation
  const batchSize = 10;
  for (let i = 0; i < newCandidates.length; i += batchSize) {
    const batch = newCandidates.slice(i, i + batchSize);

    let results: LLMMatchResult[];
    try {
      results = await evaluateBatchWithLLM(batch);
    } catch (err) {
      console.error("LLM batch failed:", err);
      continue;
    }

    stats.llmEvaluated += batch.length;

    // 5. Process results
    for (const result of results) {
      const candidate = batch[result.pairIndex];
      if (!candidate) continue;

      let status: string;
      let personId: number | null = null;

      if (result.isSamePerson && result.confidence >= 0.9) {
        status = "auto_confirmed";
        personId = await createPersonFromMatch(
          userId,
          candidate.bluesky.id,
          candidate.mastodon.id,
          result.confidence,
          candidate.bluesky.displayName,
          candidate.mastodon.displayName
        );
        stats.autoConfirmed++;
      } else if (result.isSamePerson && result.confidence >= 0.5) {
        status = "pending";
        stats.suggestionsCreated++;
      } else {
        status = "rejected";
      }

      try {
        await db.insert(matchSuggestions).values({
          userId,
          blueskyIdentityId: candidate.bluesky.id,
          mastodonIdentityId: candidate.mastodon.id,
          heuristicScore: candidate.heuristicScore,
          llmConfidence: result.confidence,
          llmReasoning: result.reasoning,
          status,
          personId,
        });
      } catch (err) {
        // Unique constraint violation — pair already exists, skip
        console.error("Failed to insert suggestion:", err);
      }
    }

    // Rate limit between batches
    if (i + batchSize < newCandidates.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return stats;
}
