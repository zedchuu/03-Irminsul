// =============================================================================
// src/services/goalService.ts
// Irminsul — Tiered Retrieval Engine
//
// Architecture Overview:
//   Tier 1a │ Text retrieval  — slug exact match, then ilike on title.
//            │                  Zero LLM cost. Hits a btree index first.
//   Tier 1b │ Semantic search — pgvector cosine similarity via match_goals RPC.
//            │                  Zero LLM cost. Embedding generation is LIVE.
//   Tier 2   │ LLM generation — Claude Haiku 4.5 via AI SDK + Zod validation.
//            │                  Only reached on a confirmed Tier 1 double-miss.
//   Tier 3   │ Write-back     — Persist Tier 2 output (+ embedding) to `goals`,
//            │                  `nodes`, `node_prerequisites`, and
//            │                  `goals.milestone_graph` so future identical
//            │                  requests are served free from Tier 1a.
//            │                  Non-fatal on milestone_graph update failure.
//
// Operational rules (unchanged from Phase 2):
//   - Never expose raw Supabase errors or stack traces to callers.
//   - Never call Tier 2 without exhausting Tier 1a and 1b first.
//   - All LLM output is Zod-validated inside llmService before arriving here.
//   - Tier 2 failure IS fatal within the waterfall and surfaces as
//     'error_fallback' via the top-level catch boundary.
//
// Phase 3.2 additions to Tier 3:
//   - generateAndPersist() replaces writeGoalToDb().
//   - Nodes are inserted with sequence_order = array index (temp_id bridge).
//   - Translation map: temp_id → sequence_order → real_uuid.
//   - node_prerequisites inserted using resolved UUIDs.
//   - Milestones resolved through the map; orphaned temp_ids filtered + warned.
//   - goals.milestone_graph updated in final step. Non-fatal on failure.
//   - goals.description written as null (soft-deprecated; dropped in Phase 4).
// =============================================================================

import { createClient } from '@/utils/supabase/server';
import {
  generateGoalFromLLM,
  type GoalGenerationPayload,
  type GeneratedMilestone,
  type ResolvedMilestone,
} from '@/services/llmService';
import type { GoalSummary } from '@/types/database.types';
import { embed } from 'ai';
import { openai } from '@ai-sdk/openai';

// ---------------------------------------------------------------------------
// Embedding model (unchanged from Phase 2)
//
// text-embedding-3-small produces 1536-dimensional vectors. This must match
// the vector(N) column dimension in the `goals` table migration. If you ever
// switch models, update both the migration and the `match_goals` SQL function.
//
// The OPENAI_API_KEY environment variable is read automatically by the
// @ai-sdk/openai provider — no explicit key passing required in this file.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Public return type (unchanged from Phase 2)
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
// Internal helpers (unchanged from Phase 2)
// ---------------------------------------------------------------------------

/**
 * Derives a URL-safe slug from a raw user input string.
 *
 * ⚠️  Keep in sync with the slug logic previously in llmService.ts (sanitizeSlug).
 * Phase 3 gate: extract to `@/utils/slug.ts` and import from there.
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
// Shared utility — Embedding generation (unchanged from Phase 2)
// ---------------------------------------------------------------------------

/**
 * Converts a text string into a 1536-dimensional vector using OpenAI's
 * `text-embedding-3-small` model via the Vercel AI SDK `embed` function.
 *
 * Called once per request and the result is shared between Tier 1b (RPC query)
 * and Tier 3 (DB write-back) — no duplicate API calls on a Tier 2 path.
 *
 * Error handling: any failure is caught here and returns `[]`. The caller
 * guards on `length > 0` before running Tier 1b and skips that tier
 * gracefully, falling through to Tier 2. Tier 3 will store an empty embedding
 * in this case — a no-op for future semantic retrieval until a back-fill job
 * populates it.
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
// Tier 1a — Text retrieval (slug + ilike) — unchanged from Phase 2
// ---------------------------------------------------------------------------

/**
 * **Tier 1a — Exact slug match.**
 *
 * Btree index lookup — constant time at any table size.
 * Returns `null` on miss; throws on Supabase transport error (fatal, caught
 * by the top-level boundary in `getOrGenerateGoal`).
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
// Tier 1b — Semantic vector search — unchanged from Phase 2
// ---------------------------------------------------------------------------

/**
 * **Tier 1b — Semantic similarity search via `match_goals` RPC.**
 *
 * WHY .limit(1) INSTEAD OF .maybeSingle():
 *   `match_goals` is declared `RETURNS TABLE (...)` in Postgres, so PostgREST
 *   always returns a JSON array. `.maybeSingle()` requests a singular JSON
 *   object which PostgREST cannot satisfy for a set-returning function — it
 *   returns null even on a valid match. Chain `.limit(1)` instead and return
 *   `data[0] ?? null`.
 */
async function findGoalBySemantic(
  supabase: Awaited<ReturnType<typeof createClient>>,
  embedding: number[],
): Promise<GoalSummary | null> {
  const MATCH_THRESHOLD = 0.75;

  console.log(`[Irminsul/Tier1b] embedding length: ${embedding.length}`);
  console.log(`[Irminsul/Tier1b] embedding[0..2]: ${JSON.stringify(embedding.slice(0, 3))}`);
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

  console.log(`[Irminsul/Tier1b] RPC status: ${status} ${statusText}`);
  console.log(`[Irminsul/Tier1b] RPC raw error: ${JSON.stringify(error)}`);
  console.log(`[Irminsul/Tier1b] RPC raw data:  ${JSON.stringify(data)}`);

  if (error) {
    console.error(
      `[Irminsul/Tier1b] match_goals failed — code: ${error.code} | message: ${error.message} | details: ${error.details} | hint: ${error.hint}`,
    );
    return null;
  }

  if (!Array.isArray(data)) {
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
// Tier 3 — Write-back (Phase 3.2: replaces writeGoalToDb)
// ---------------------------------------------------------------------------

/**
 * **Tier 3 — Persist a fully-generated curriculum to Supabase.**
 *
 * This is the "Centralized Hub" flywheel: every paid Tier 2 generation is
 * stored atomically so future identical requests are served from Tier 1a for free.
 *
 * Write sequence:
 *   1. Insert Goal row (milestone_graph = null, description = null).
 *      Get the returned goal_id.
 *   2. Prepare nodes: strip temp_id, assign sequence_order = array index.
 *      The array index IS the temp_id bridge — it is the only stable link
 *      between the LLM payload and the Supabase insert response.
 *   3. Insert nodes. SELECT id + sequence_order from the response.
 *   4. Build the translation map:
 *        Map A: temp_id → sequence_order  (from original LLM payload)
 *        Map B: sequence_order → real_uuid (from Supabase insert response)
 *        Master: temp_id → real_uuid       (composed via sequence_order bridge)
 *   5. Insert node_prerequisites using resolved UUIDs. Non-fatal on failure —
 *      tree renders flat rather than crashing.
 *   6. Resolve milestone node_ids through the master map.
 *      Orphaned temp_ids (no resolved UUID) are filtered with a server warning.
 *   7. UPDATE goals.milestone_graph with resolved milestones. Non-fatal on
 *      failure — goal and nodes are intact. Refresh Protocol recovers this.
 *
 * Non-fatal on milestone_graph write failure: the goal row exists but has
 * milestone_graph = null. This is a detectable, recoverable state that the
 * Refresh Protocol can re-trigger. A null milestone_graph is never served to
 * the client as a valid tech tree.
 *
 * Handles slug conflicts (Postgres error code `23505`) gracefully: a concurrent
 * request may have already written the same goal. Logged as a warning, not an
 * error; returns null so the caller falls back to the in-memory goal.
 *
 * @param generated - Zod-validated payload from `generateGoalFromLLM`.
 * @param embedding - Pre-computed vector to store alongside the goal.
 * @returns The persisted `GoalSummary` row, or `null` on any fatal write failure.
 * @internal
 */
async function generateAndPersist(
  supabase: Awaited<ReturnType<typeof createClient>>,
  generated: GoalGenerationPayload,
  embedding: number[],
): Promise<GoalSummary | null> {
  const slug = toSlug(generated.title);

  // ── Step 1: Insert Goal ──────────────────────────────────────────────────
  // milestone_graph: null — populated in Step 7 after node UUIDs are resolved.
  // description: null — soft-deprecated in Phase 3; column dropped in Phase 4.

  // TODO: remove `as any` cast once local types are regenerated.
  // The stale Insert type for `goals` does not yet include `embedding` or
  // `milestone_graph` (both added after the last type generation run).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: goalRow, error: goalError } = await (supabase.from('goals') as any)
    .insert({
      title: generated.title,
      slug,
      description: null,
      last_verified_at: null,
      embedding,
    })
    .select(GOAL_SUMMARY_COLUMNS)
    .single();

  if (goalError) {
    if (goalError.code === '23505') {
      console.warn(
        `[Irminsul/Tier3] Slug conflict on '${slug}' — concurrent write detected, skipping.`,
      );
    } else {
      console.error(`[Irminsul/Tier3] Goal insert failed (non-fatal): ${goalError.message}`);
    }
    return null;
  }

  const goalId: string = goalRow.id;
  console.log(`[Irminsul/Tier3] Goal inserted: '${goalRow.title}' (id: ${goalId})`);

  // ── Step 2: Prepare nodes ────────────────────────────────────────────────
  // sequence_order = array index. This is the bridge between the LLM payload's
  // temp_id world and the Supabase UUID world. temp_id and prerequisite_temp_ids
  // are intentionally stripped here — they must never reach the database.

  const preparedNodes = generated.nodes.map((node, index) => ({
    goal_id: goalId,
    title: node.title,
    lesson_context: node.lesson_context,
    actionable_tasks: node.actionable_tasks,
    estimated_minutes: node.estimated_minutes,
    sequence_order: index,
    source: 'llm_generated' as const,
    last_verified_at: null,
  }));

  // ── Step 3: Insert nodes, select id + sequence_order ────────────────────
  // `as any` on .from('nodes'): two interacting type errors require this cast.
  //
  // (a) preparedNodes assignability: nodes.Insert omits DB-managed fields
  //     (id, created_at, updated_at, access_count, is_deprecated), which our
  //     object satisfies at runtime. However, strict mode collapses the inferred
  //     object literal type to `never` when the Supabase client tries to match
  //     it against the Insert generic in some SDK versions.
  //
  // (b) .select('id, sequence_order') return type: the TS client cannot
  //     statically narrow a runtime column string to a partial Row shape, so
  //     the inferred type of insertedNodes becomes `never[]` instead of
  //     `{ id: string; sequence_order: number }[]`.
  //
  // The cast is scoped to this single call. Remove once types are regenerated:
  //   npx supabase gen types typescript --project-id <id> > src/types/database.types.ts
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: insertedNodes, error: nodeError } = await (supabase.from('nodes') as any)
    .insert(preparedNodes)
    .select('id, sequence_order');

  if (nodeError || !insertedNodes || insertedNodes.length === 0) {
    console.error(
      `[Irminsul/Tier3] Node insert failed for goal '${goalId}': ${nodeError?.message}. ` +
      `Goal row exists but is empty — Refresh Protocol should recover.`,
    );
    return goalRow as GoalSummary;
  }

  console.log(`[Irminsul/Tier3] ${insertedNodes.length} nodes inserted for goal '${goalId}'.`);

  // ── Step 4: Build temp_id → real_uuid translation map ───────────────────
  //
  // Map A: temp_id → sequence_order (from the original LLM payload array index)
  const tempIdToSequenceOrder = new Map<string, number>(
    generated.nodes.map((node, index) => [node.temp_id, index]),
  );

  // Map B: sequence_order → real_uuid (from the Supabase insert response)
  const sequenceOrderToUUID = new Map<number, string>(
    (insertedNodes as { id: string; sequence_order: number }[]).map((row) => [row.sequence_order, row.id]),
  );

  // Master dictionary: temp_id → real_uuid (composed via sequence_order bridge)
  const tempIdToUUID = new Map<string, string>();
  for (const [tempId, seqOrder] of tempIdToSequenceOrder) {
    const realUUID = sequenceOrderToUUID.get(seqOrder);
    if (realUUID) {
      tempIdToUUID.set(tempId, realUUID);
    } else {
      // Should never fire — every prepared node has a sequence_order.
      // Logged loudly because it indicates a data integrity issue.
      console.warn(
        `[Irminsul/Tier3] Translation miss: temp_id "${tempId}" (sequence_order ${seqOrder}) ` +
        `has no matching UUID in the insert response. Node will be unreachable from milestones.`,
      );
    }
  }

  // ── Step 5: Insert node_prerequisites ───────────────────────────────────

  const prerequisiteRows: { node_id: string; prerequisite_id: string }[] = [];

  for (const node of generated.nodes) {
    const nodeUUID = tempIdToUUID.get(node.temp_id);
    if (!nodeUUID) continue;

    for (const prereqTempId of node.prerequisite_temp_ids) {
      const prereqUUID = tempIdToUUID.get(prereqTempId);
      if (!prereqUUID) {
        console.warn(
          `[Irminsul/Tier3] Orphaned prerequisite: node "${node.temp_id}" lists ` +
          `prerequisite "${prereqTempId}" which could not be resolved. Skipping edge.`,
        );
        continue;
      }
      prerequisiteRows.push({ node_id: nodeUUID, prerequisite_id: prereqUUID });
    }
  }

  if (prerequisiteRows.length > 0) {
    // `as any` on .from('node_prerequisites'): the Database type map declares
    // node_prerequisites.Update as `never` (prerequisites are replaced wholesale,
    // never partially updated). In strict mode, some versions of the Supabase TS
    // client bleed the `never` Update type into the insert call's generic resolution,
    // making the insert payload unassignable. The cast is scoped to this call only.
    // Remove once types are regenerated after the next migration run.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: prereqError } = await (supabase.from('node_prerequisites') as any)
      .insert(prerequisiteRows);

    if (prereqError) {
      // Non-fatal: nodes exist and are usable. Tree renders flat, not broken.
      console.error(
        `[Irminsul/Tier3] node_prerequisites insert failed for goal '${goalId}': ` +
        `${prereqError.message}. Tech tree will render without prerequisite edges.`,
      );
    } else {
      console.log(`[Irminsul/Tier3] ${prerequisiteRows.length} prerequisite edges inserted.`);
    }
  }

  // ── Step 6: Resolve milestones ───────────────────────────────────────────
  // Swap temp_ids in milestone.node_ids for real UUIDs via the master map.
  // Orphaned temp_ids are filtered out with a warning (graceful degradation).

  const resolvedMilestones: ResolvedMilestone[] = generated.milestones.map(
    (milestone: GeneratedMilestone) => {
      const resolvedNodeIds: string[] = [];

      for (const tempId of milestone.node_ids) {
        const realUUID = tempIdToUUID.get(tempId);
        if (realUUID) {
          resolvedNodeIds.push(realUUID);
        } else {
          console.warn(
            `[Irminsul/Tier3] Milestone "${milestone.id}" ("${milestone.title}") references ` +
            `temp_id "${tempId}" which has no resolved UUID. Filtering from node_ids.`,
          );
        }
      }

      return {
        id: milestone.id,
        title: milestone.title,
        description: milestone.description,
        prerequisite_milestone_ids: milestone.prerequisite_milestone_ids,
        node_ids: resolvedNodeIds,
      };
    },
  );

  // ── Step 7: Update goals.milestone_graph ─────────────────────────────────
  // TODO: remove `as any` cast once local types are regenerated.
  // milestone_graph is a new JSONB column not yet in the generated Database type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: updateError } = await (supabase.from('goals') as any)
    .update({ milestone_graph: resolvedMilestones })
    .eq('id', goalId);

  if (updateError) {
    // Non-fatal: goal and nodes are intact and usable.
    // The Refresh Protocol detects milestone_graph = null and re-attempts.
    console.error(
      `[Irminsul/Tier3] milestone_graph update failed for goal '${goalId}': ${updateError.message}. ` +
      `Goal is usable but milestone graph is absent. Refresh Protocol should recover.`,
    );
  } else {
    console.log(`[Irminsul/Tier3] milestone_graph written for goal '${goalId}'.`);
  }

  return goalRow as GoalSummary;
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
 *   The topic embedding is generated once before Tier 1b. If Tier 1b misses
 *   and Tier 2 runs, the same embedding vector is reused in Tier 3 write-back
 *   — no second API call is made.
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

    const generated: GoalGenerationPayload = await generateGoalFromLLM(topic);

    // Defensive audit: log the raw payload shape before touching any property.
    // If nodes or milestones are undefined here, the model returned a shape
    // that Zod passed through without the expected arrays (passthrough() in
    // effect). This log will reveal the actual keys the model used.
    console.log(
      `[Irminsul Engine] Tier 2 raw payload keys: ${Object.keys(generated).join(', ')}`,
    );
    console.log(
      `[Irminsul Engine] Tier 2 nodes type: ${typeof generated.nodes} — ` +
      `milestones type: ${typeof generated.milestones}`,
    );

    // Guard: if the model returned a payload missing nodes or milestones,
    // treat this as a fatal Tier 2 failure rather than crashing in Tier 3.
    if (!Array.isArray(generated.nodes) || !Array.isArray(generated.milestones)) {
      throw new Error(
        `[Irminsul Engine] Tier 2 payload missing required arrays. ` +
        `nodes: ${typeof generated.nodes}, milestones: ${typeof generated.milestones}. ` +
        `Raw keys: ${Object.keys(generated).join(', ')}`,
      );
    }

    console.log(
      `[Irminsul Engine] Tier 2 succeeded: '${generated.title}' — ` +
      `${generated.nodes.length} nodes, ${generated.milestones.length} milestones. ` +
      `Running Tier 3 write-back...`,
    );

    // -----------------------------------------------------------------------
    // Tier 3 — generateAndPersist (Phase 3.2 replacement for writeGoalToDb)
    //
    // Attempts to persist the full curriculum. If the goal INSERT succeeds,
    // returns the real DB row (real UUID, timestamps). If it fails, falls back
    // to an in-memory GoalSummary — the UI still gets a usable result either way.
    // -----------------------------------------------------------------------
    const persisted = await generateAndPersist(supabase, generated, queryEmbedding);

    if (persisted) {
      return { goal: persisted, source: 'llm_generated' };
    }

    // Tier 3 failed (logged inside generateAndPersist). Return in-memory goal.
    // id is marked as a placeholder so downstream FK references fail loudly
    // rather than silently writing bad data.
    const inMemoryGoal: GoalSummary = {
      id: 'tier3-write-failed',
      title: generated.title,
      slug: toSlug(generated.title),
      description: null,
      last_verified_at: null,
      access_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    return { goal: inMemoryGoal, source: 'llm_generated' };

  } catch (err: unknown) {
    // -----------------------------------------------------------------------
    // Top-level error boundary (unchanged from Phase 2).
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