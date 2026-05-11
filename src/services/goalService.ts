// =============================================================================
// src/services/goalService.ts
// Irminsul — Tiered Retrieval Engine
//
// Architecture Overview:
//   Tier 1a │ Text retrieval  — slug exact match, then ilike on title.
//            │                  Zero LLM cost. Hits a btree index first.
//   Tier 1b │ Semantic search — pgvector cosine similarity via match_goals RPC.
//            │                  Zero LLM cost. Embedding generation is STUBBED.
//   Tier 2   │ LLM generation — Claude Haiku 4.5 via AI SDK + Zod validation.
//            │                  Only reached on a confirmed Tier 1 double-miss.
//   Tier 3   │ Write-back     — Persist Tier 2 output (+ embedding) to `goals`
//            │                  so future identical requests are served free
//            │                  from Tier 1a. Non-fatal on failure.
//
// Operational rules:
//   - Never expose raw Supabase errors or stack traces to callers.
//   - Never call Tier 2 without exhausting Tier 1a and 1b first.
//   - All LLM output is Zod-validated inside llmService before arriving here.
//   - Tier 3 write failure is non-fatal: the validated goal is still returned.
//     A failed write means the next identical request pays Tier 2 again —
//     acceptable until a retry queue is introduced in a future phase.
//   - Tier 2 failure IS fatal within the waterfall and surfaces as
//     'error_fallback' via the top-level catch boundary.
// =============================================================================

import { createClient } from '@/utils/supabase/server';
import { generateGoalFromLLM, type GeneratedGoal } from '@/services/llmService';
import type { GoalSummary } from '@/types/database.types';
import { embed } from 'ai';
import { openai } from '@ai-sdk/openai';

// ---------------------------------------------------------------------------
// Embedding model
//
// text-embedding-3-small produces 1536-dimensional vectors. This must match
// the vector(N) column dimension in the `goals` table migration. If you ever
// switch models, update both the migration and the `match_goals` SQL function.
//
// The OPENAI_API_KEY environment variable is read automatically by the
// @ai-sdk/openai provider — no explicit key passing required in this file.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Public return type
// ---------------------------------------------------------------------------

/**
 * Discriminated result envelope returned by `getOrGenerateGoal`.
 *
 *   `'db_retrieved'`   — Tier 1a hit  (slug or ilike — zero cost)
 *   `'db_semantic'`    — Tier 1b hit  (pgvector RPC — zero cost)
 *   `'llm_generated'`  — Tier 2 live  (Claude Haiku 4.5 — paid, written to DB)
 *   `'llm_mock'`       — retired stub; retained so page.tsx badge map compiles
 *   `'error_fallback'` — top-level catch (DB + LLM both failed)
 */
export type GoalResultSource =
  | 'db_retrieved'
  | 'db_semantic'
  | 'llm_generated'
  | 'llm_mock'
  | 'error_fallback';

export interface GoalResult {
  goal: GoalSummary;
  source: GoalResultSource;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Derives a URL-safe slug from a raw user input string.
 *
 * ⚠️  Keep in sync with the slug regex in `generatedGoalSchema` (llmService.ts).
 * Phase 3 gate: extract both to `@/utils/slug.ts` and import from there.
 *
 * @example
 *   toSlug("Learn Python!") // → "learn-python"
 *   toSlug("  Next.js 14 ") // → "next-js-14"
 */
function toSlug(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '') // strip non-alphanumeric (keep spaces + hyphens)
    .replace(/\s+/g, '-')          // collapse whitespace to hyphens
    .replace(/-+/g, '-');          // collapse consecutive hyphens
}

/** Columns selected on every `goals` query — excludes the `embedding` vector. */
const GOAL_SUMMARY_COLUMNS =
  'id, title, slug, description, last_verified_at, access_count, created_at, updated_at' as const;

// ---------------------------------------------------------------------------
// Shared utility — Embedding generation (LIVE)
//
// Called once per request in getOrGenerateGoal and the result is passed into
// both findGoalBySemantic (Tier 1b) and writeGoalToDb (Tier 3). This avoids
// calling the embedding API twice for the same topic on a Tier 2 path.
// ---------------------------------------------------------------------------

/**
 * Converts a text string into a 1536-dimensional vector using OpenAI's
 * `text-embedding-3-small` model via the Vercel AI SDK `embed` function.
 *
 * Called once per request and the result is shared between Tier 1b (RPC query)
 * and Tier 3 (DB write-back) — no duplicate API calls on a Tier 2 path.
 *
 * Error handling: any failure (network error, rate limit, invalid key) is
 * caught here and returns `[]`. The caller guards on `length > 0` before
 * running Tier 1b and skips that tier gracefully, falling through to Tier 2.
 * Tier 3 will store an empty embedding in this case — a no-op for future
 * semantic retrieval until a back-fill job populates it.
 */
async function generateEmbedding(text: string): Promise<number[]> {
  try {
    const { embedding } = await embed({
      model: openai.embedding('text-embedding-3-small'),
      value: text,
    });
    return embedding;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Irminsul Engine] generateEmbedding failed (non-fatal): ${message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tier 1a — Text retrieval (slug + ilike)
// ---------------------------------------------------------------------------

/**
 * **Tier 1a — Exact slug match.**
 *
 * Btree index lookup — constant time at any table size.
 * Returns `null` on miss; throws on Supabase transport error (fatal, caught
 * by the top-level boundary in `getOrGenerateGoal`).
 *
 * @internal
 */
async function findGoalBySlug(
  supabase: Awaited<ReturnType<typeof createClient>>,
  slug: string,
): Promise<GoalSummary | null> {
  const { data, error } = await supabase
    .from('goals')
    .select(GOAL_SUMMARY_COLUMNS)
    .eq('slug', slug)
    .maybeSingle();

  if (error) {
    throw new Error(`[Irminsul/Tier1a-slug] Supabase error: ${error.message}`);
  }

  return data ?? null;
}

/**
 * **Tier 1a — Partial title match (ilike fallback).**
 *
 * Case-insensitive LIKE on the `title` column. Non-fatal on transport error —
 * logs and returns `null` so the waterfall escalates to Tier 1b.
 *
 * @internal
 */
async function findGoalByTitle(
  supabase: Awaited<ReturnType<typeof createClient>>,
  topic: string,
): Promise<GoalSummary | null> {
  const { data, error } = await supabase
    .from('goals')
    .select(GOAL_SUMMARY_COLUMNS)
    .ilike('title', `%${topic}%`)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error(
      `[Irminsul/Tier1a-ilike] Supabase error (non-fatal, escalating): ${error.message}`,
    );
    return null;
  }

  return data ?? null;
}

// ---------------------------------------------------------------------------
// Tier 1b — Semantic vector search
// ---------------------------------------------------------------------------

/**
 * **Tier 1b — Semantic similarity search via `match_goals` RPC.**
 *
 * Accepts a pre-computed embedding so the caller can reuse the same vector
 * in Tier 3 write-back without a second API round-trip.
 *
 * Calls the `match_goals` Postgres function via PostgREST RPC using cosine
 * distance (`<=>`). Returns at most 1 row — the closest match above the
 * 0.80 similarity threshold.
 *
 * Non-fatal on RPC error — logs and returns `null` to escalate to Tier 2.
 *
 * WHY .limit(1) INSTEAD OF .maybeSingle():
 *   `match_goals` is declared `RETURNS TABLE (...)` in Postgres, so PostgREST
 *   always returns a JSON array — even when only one row matches. `.maybeSingle()`
 *   sets `Accept: application/vnd.pgrst.object+json` which requests a singular
 *   JSON object. PostgREST cannot satisfy this for a set-returning function and
 *   returns an error (or a mismatched shape), causing the client to silently
 *   return `null` and fall through to Tier 2 even on a valid match.
 *   The correct pattern is: chain `.limit(1)` on the RPC call to receive a
 *   one-element array from PostgREST, then return `data[0] ?? null` in code.
 *   This is consistent with Supabase's own semantic search documentation which
 *   chains `.limit()` directly on RPC calls rather than using `.maybeSingle()`.
 *
 * @param embedding - Pre-computed vector from `generateEmbedding`.
 * @internal
 */
async function findGoalBySemantic(
  supabase: Awaited<ReturnType<typeof createClient>>,
  embedding: number[],
): Promise<GoalSummary | null> {
  const MATCH_THRESHOLD = 0.75;

  // ── 1. Input audit ─────────────────────────────────────────────────────────
  // A valid text-embedding-3-small vector is always 1536 dimensions.
  // If this logs 0 or any other value, generateEmbedding failed silently.
  console.log(`[Irminsul/Tier1b] embedding length: ${embedding.length}`);
  console.log(`[Irminsul/Tier1b] embedding[0..2]: ${JSON.stringify(embedding.slice(0, 3))}`);

  // ── 2. Execution log ───────────────────────────────────────────────────────
  console.log(`[Irminsul/Tier1b] calling match_goals RPC — threshold: ${MATCH_THRESHOLD}`);

  // TODO: remove `as any` cast once local types are regenerated:
  //   npx supabase gen types typescript --project-id <project-id> > src/types/database.types.ts
  // match_goals was created in the cloud SQL Editor after the last type generation
  // run, so the local Database type map does not yet include this function.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error, status, statusText } = await (supabase.rpc as any)('match_goals', {
    query_embedding: embedding,
    match_threshold: MATCH_THRESHOLD,
  }).limit(1);

  // ── 3. Raw output audit ────────────────────────────────────────────────────
  // Log everything PostgREST returned — code, message, details, hint — so RLS
  // errors, schema cache misses, and dimension mismatches are all visible.
  console.log(`[Irminsul/Tier1b] RPC status: ${status} ${statusText}`);
  console.log(`[Irminsul/Tier1b] RPC raw error: ${JSON.stringify(error)}`);
  console.log(`[Irminsul/Tier1b] RPC raw data:  ${JSON.stringify(data)}`);

  if (error) {
    console.error(
      `[Irminsul/Tier1b] match_goals failed — code: ${error.code} | message: ${error.message} | details: ${error.details} | hint: ${error.hint}`,
    );
    return null;
  }

  // ── 4. Array inspection ────────────────────────────────────────────────────
  if (!Array.isArray(data)) {
    // Unexpected shape — PostgREST should always return an array for RETURNS TABLE.
    // If this fires it means the response format changed or the function signature
    // was altered (e.g., changed to RETURNS SETOF or RETURNS json).
    console.warn(`[Irminsul/Tier1b] data is not an array — typeof: ${typeof data} — value: ${JSON.stringify(data)}`);
    return null;
  }

  console.log(`[Irminsul/Tier1b] data array length: ${data.length}`);

  if (data.length === 0) {
    console.log(`[Irminsul/Tier1b] no rows above threshold ${MATCH_THRESHOLD} — escalating to Tier 2`);
    return null;
  }

  console.log(`[Irminsul/Tier1b] HIT — returning: ${JSON.stringify(data[0])}`);
  return data[0] as GoalSummary;
}

// ---------------------------------------------------------------------------
// Tier 3 — Write-back
// ---------------------------------------------------------------------------

/**
 * **Tier 3 — Persist a Tier 2-generated goal to the `goals` table.**
 *
 * This is the "Centralized Hub" flywheel: every paid Tier 2 generation
 * is stored so future identical requests are served from Tier 1a at zero cost.
 *
 * The `embedding` written here is currently the zero-vector stub. Once the
 * real embedding model is wired into `generateEmbedding`, Tier 3 write-back
 * will automatically begin populating meaningful vectors — enabling Tier 1b
 * semantic hits on future requests with no further changes to this function.
 *
 * Returns the full persisted `GoalSummary` row (with DB-generated `id`,
 * `created_at`, `updated_at`) so the caller can return the real UUID rather
 * than a placeholder.
 *
 * Non-fatal: if the INSERT fails, the caller logs the error and falls back to
 * returning the in-memory validated goal. The only consequence is that the next
 * identical request will pay Tier 2 cost again.
 *
 * Handles slug conflicts (Postgres error code `23505`) gracefully: a concurrent
 * request may have already written the same goal. This is logged as a warning,
 * not an error, and returns `null` so the caller uses the in-memory goal.
 *
 * @param generated - Zod-validated output from `generateGoalFromLLM`.
 * @param embedding - Pre-computed vector to store alongside the goal.
 * @returns The persisted `GoalSummary` row, or `null` on any write failure.
 * @internal
 */
async function writeGoalToDb(
  supabase: Awaited<ReturnType<typeof createClient>>,
  generated: GeneratedGoal,
  embedding: number[],
): Promise<GoalSummary | null> {
  // TODO: remove `as any` cast once local types are regenerated:
  //   npx supabase gen types typescript --project-id <project-id> > src/types/database.types.ts
  // The stale Insert type for `goals` does not include the `embedding` column
  // (added after the last type generation run). The Supabase client silently
  // strips keys that are absent from the Insert type, so without this cast
  // the embedding is never sent to PostgREST — the column stays null and
  // match_goals's `IS NOT NULL` guard excludes every Tier 3-written row.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase.from('goals') as any)
    .insert({
      title: generated.title,
      slug: generated.slug,
      description: generated.description,
      last_verified_at: null,
      embedding,
    })
    .select(GOAL_SUMMARY_COLUMNS)
    .single();

  if (error) {
    if (error.code === '23505') {
      // Unique constraint violation on `slug` — a concurrent request already
      // wrote this goal. This is a success state for the system, not a bug.
      console.warn(
        `[Irminsul/Tier3] Slug conflict on '${generated.slug}' — concurrent write detected, skipping.`,
      );
    } else {
      console.error(
        `[Irminsul/Tier3] Write-back failed (non-fatal): ${error.message}`,
      );
    }
    return null;
  }

  console.log(`[Irminsul/Tier3] Write-back succeeded: '${data.title}' (id: ${data.id})`);
  return data;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * **`getOrGenerateGoal` — The Tiered Retrieval Engine entry point.**
 *
 * Orchestrates the full retrieval waterfall for a given learning topic:
 *
 * ```
 * Tier 1a (slug) → Tier 1a (ilike) → Tier 1b (pgvector) → Tier 2 (LLM) → Tier 3 (write-back)
 * ```
 *
 * Only escalates to the next tier on a confirmed miss from the previous one.
 * This preserves the TCO contract: the vast majority of requests resolve at
 * Tier 1a with zero API cost.
 *
 * Embedding lifecycle:
 *   The topic embedding is generated once (currently stubbed) before Tier 1b.
 *   If Tier 1b misses and Tier 2 runs, the same embedding vector is reused in
 *   Tier 3 write-back — no second API call is made.
 *
 * @param topic - The raw user input string (e.g., "Learn Python").
 * @returns A `GoalResult` with an explicit `source` field.
 * @throws Never. All errors are caught and surfaced as `'error_fallback'`.
 */
export async function getOrGenerateGoal(topic: string): Promise<GoalResult> {
  const supabase = await createClient();

  try {
    // -----------------------------------------------------------------------
    // Tier 1a — Exact slug match (fastest, index-backed, zero LLM cost)
    // -----------------------------------------------------------------------
    const slug = toSlug(topic);
    console.log(`[Irminsul Engine] Tier 1a slug lookup: '${slug}'`);

    const slugMatch = await findGoalBySlug(supabase, slug);
    if (slugMatch) {
      console.log(`[Irminsul Engine] Tier 1a HIT (slug): '${slugMatch.title}'`);
      return { goal: slugMatch, source: 'db_retrieved' };
    }

    // -----------------------------------------------------------------------
    // Tier 1a — Partial title match (ilike fallback, still zero LLM cost)
    // -----------------------------------------------------------------------
    console.log(`[Irminsul Engine] Tier 1a slug miss. Falling back to ilike on title...`);

    const titleMatch = await findGoalByTitle(supabase, topic);
    if (titleMatch) {
      console.log(`[Irminsul Engine] Tier 1a HIT (ilike): '${titleMatch.title}'`);
      return { goal: titleMatch, source: 'db_retrieved' };
    }

    // -----------------------------------------------------------------------
    // Pre-compute embedding once.
    // Shared by Tier 1b (RPC query) and Tier 3 (DB write) to avoid calling
    // the embedding API twice on a Tier 2 path.
    // -----------------------------------------------------------------------
    console.log(`[Irminsul Engine] Tier 1a miss. Generating embedding for Tier 1b...`);

    let queryEmbedding: number[];
    try {
      queryEmbedding = await generateEmbedding(topic);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Embedding failure is non-fatal for Tier 1b but means we must skip
      // Tier 1b entirely. Tier 3 will store a null embedding instead.
      console.error(`[Irminsul Engine] Embedding failed (non-fatal, skipping Tier 1b): ${message}`);
      queryEmbedding = [];
    }

    // -----------------------------------------------------------------------
    // Tier 1b — Semantic vector search via match_goals RPC
    // -----------------------------------------------------------------------
    if (queryEmbedding.length > 0) {
      console.log(`[Irminsul Engine] Escalating to Tier 1b (semantic search)...`);

      const semanticMatch = await findGoalBySemantic(supabase, queryEmbedding);
      if (semanticMatch) {
        console.log(`[Irminsul Engine] Tier 1b HIT (semantic): '${semanticMatch.title}'`);
        return { goal: semanticMatch, source: 'db_semantic' };
      }

      console.log(`[Irminsul Engine] Tier 1b miss. Escalating to Tier 2 (LLM generation)...`);
    } else {
      console.log(`[Irminsul Engine] Skipping Tier 1b (no embedding). Escalating to Tier 2...`);
    }

    // -----------------------------------------------------------------------
    // Tier 2 — LLM generation via Claude Haiku 4.5 (llmService.ts)
    //
    // generateGoalFromLLM throws on:
    //   - Network failure / rate limit  (AISDKError)
    //   - Zod validation failure        (ZodError)
    // Both are caught by the top-level boundary and surface as 'error_fallback'.
    // -----------------------------------------------------------------------
    console.log(`[Irminsul Engine] Calling Tier 2 LLM generation...`);

    const generated: GeneratedGoal = await generateGoalFromLLM(topic);

    console.log(`[Irminsul Engine] Tier 2 succeeded: '${generated.title}'. Running Tier 3 write-back...`);

    // -----------------------------------------------------------------------
    // Tier 3 — Write-back to `goals` table (non-fatal)
    //
    // Attempt to persist the validated goal. If the write succeeds, return the
    // real DB row (with the actual UUID and timestamps) as the canonical result.
    // If the write fails, fall back to an in-memory GoalSummary constructed from
    // the validated LLM output — the UI still gets a usable result either way.
    // -----------------------------------------------------------------------
    const persisted = await writeGoalToDb(supabase, generated, queryEmbedding);

    if (persisted) {
      // Return the authoritative row from the DB — real UUID, real timestamps.
      return { goal: persisted, source: 'llm_generated' };
    }

    // Tier 3 failed (logged inside writeGoalToDb). Return the in-memory goal.
    // id is marked as a placeholder so any downstream code that attempts a FK
    // reference fails loudly rather than silently writing bad data.
    const inMemoryGoal: GoalSummary = {
      ...generated,
      id: 'tier3-write-failed',
      access_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    return { goal: inMemoryGoal, source: 'llm_generated' };

  } catch (err: unknown) {
    // -----------------------------------------------------------------------
    // Top-level error boundary.
    // Catches fatal errors from Tier 1a (Supabase transport) and Tier 2
    // (AISDKError, ZodError). Logs server-side; returns a safe UI fallback.
    // Never exposes stack traces or raw error messages to the client.
    // -----------------------------------------------------------------------
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Irminsul Engine] Unhandled error in getOrGenerateGoal: ${message}`);

    const fallback: GoalSummary = {
      id: 'error-fallback',
      title: topic,
      slug: toSlug(topic),
      description: 'Recalculating path... Please try again in a moment.',
      last_verified_at: null,
      access_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    return { goal: fallback, source: 'error_fallback' };
  }
}