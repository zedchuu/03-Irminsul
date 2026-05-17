'use server';

// =============================================================================
// src/app/actions/progressActions.ts
// Irminsul — Phase 4.5: Unhappy Path (Stall State)
//
// 'use server' at module top — only async functions may be exported.
// ActionError lives in @/lib/errors.
// =============================================================================

import { revalidatePath } from 'next/cache';
import { createClient } from '@/utils/supabase/server';
import { ActionError } from '@/lib/errors';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function requireArg(value: string, name: string): void {
  if (!value?.trim()) {
    throw new ActionError(`${name} is required.`, 'INVALID_INPUT');
  }
}

async function requireUser() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    throw new ActionError('You must be signed in.', 'UNAUTHORIZED');
  }
  return { supabase, user };
}

/**
 * Upserts a user_progress row with a simple status + optional extra fields.
 * Used by startNode and completeNode — both are single-write, no read needed.
 * stallNode does its own read-before-write to increment recalculation_count.
 */
async function upsertProgress(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  userId: string,
  nodeId: string,
  status: 'in_progress' | 'completed',
  extra?: Record<string, unknown>,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase.from('user_progress') as any).upsert(
    {
      user_id: userId,
      node_id: nodeId,
      status,
      last_interacted_at: new Date().toISOString(),
      ...extra,
    },
    { onConflict: 'user_id,node_id', ignoreDuplicates: false },
  );
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// startNode
// ---------------------------------------------------------------------------

export async function startNode(nodeId: string, goalSlug: string): Promise<void> {
  requireArg(nodeId, 'nodeId');
  requireArg(goalSlug, 'goalSlug');

  const { supabase, user } = await requireUser();

  try {
    await upsertProgress(supabase, user.id, nodeId, 'in_progress', {
      started_at: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Irminsul/startNode] Upsert failed for user=${user.id} node=${nodeId}: ${message}`);
    throw new ActionError('Failed to start node. Please try again.', 'DB_ERROR');
  }

  console.log(`[Irminsul/startNode] node=${nodeId} → in_progress for user=${user.id}`);
  revalidatePath(`/tree/${goalSlug}`);
}

// ---------------------------------------------------------------------------
// completeNode
// ---------------------------------------------------------------------------

export async function completeNode(nodeId: string, goalSlug: string): Promise<void> {
  requireArg(nodeId, 'nodeId');
  requireArg(goalSlug, 'goalSlug');

  const { supabase, user } = await requireUser();

  try {
    await upsertProgress(supabase, user.id, nodeId, 'completed', {
      completed_at: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Irminsul/completeNode] Upsert failed for user=${user.id} node=${nodeId}: ${message}`);
    throw new ActionError('Failed to complete node. Please try again.', 'DB_ERROR');
  }

  console.log(`[Irminsul/completeNode] node=${nodeId} → completed for user=${user.id}`);
  revalidatePath(`/tree/${goalSlug}`);
}

// ---------------------------------------------------------------------------
// stallNode
// ---------------------------------------------------------------------------

/**
 * Marks a node as `stalled` and increments `recalculation_count`.
 *
 * Why read-before-write instead of upsertProgress:
 *   Postgres `count + 1` requires an UPDATE with a subexpression, which
 *   Supabase's upsert doesn't support without a custom RPC. The safe
 *   application-layer pattern is:
 *     1. SELECT the existing row to get the current recalculation_count.
 *     2. UPSERT with count + 1 (or 1 if no row exists yet).
 *   This is safe for our use case — stalling is a deliberate user action,
 *   not a high-frequency concurrent write, so a read-modify-write race is
 *   not a practical concern. A DB-level increment RPC can be added in Phase 5
 *   if stall detection becomes automated and concurrent.
 *
 * Visual behaviour after stall:
 *   DB status = 'stalled' → hydrateGraphWithProgress maps to UI 'IN_PROGRESS'
 *   recalculation_count > 0 → StalledBadge renders inside the node card
 *   "Mark Complete" button remains visible — user can still finish the node
 *   "I'm Stuck" button is hidden — replaced by disabled "Recalculating..." text
 */
export async function stallNode(nodeId: string, goalSlug: string): Promise<void> {
  requireArg(nodeId, 'nodeId');
  requireArg(goalSlug, 'goalSlug');

  const { supabase, user } = await requireUser();

  // ── 1. Read existing row to get current recalculation_count ──────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existing, error: selectError } = await (supabase.from('user_progress') as any)
    .select('recalculation_count')
    .eq('user_id', user.id)
    .eq('node_id', nodeId)
    .maybeSingle();

  if (selectError) {
    console.error(`[Irminsul/stallNode] Select failed for user=${user.id} node=${nodeId}: ${selectError.message}`);
    throw new ActionError('Failed to stall node. Please try again.', 'DB_ERROR');
  }

  // Use existing count if row exists, otherwise start at 0 before incrementing.
  const currentCount: number = existing?.recalculation_count ?? 0;
  const nextCount = currentCount + 1;

  // ── 2. Upsert with incremented count ─────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: upsertError } = await (supabase.from('user_progress') as any).upsert(
    {
      user_id: user.id,
      node_id: nodeId,
      status: 'stalled' as const,
      recalculation_count: nextCount,
      last_interacted_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,node_id', ignoreDuplicates: false },
  );

  if (upsertError) {
    console.error(`[Irminsul/stallNode] Upsert failed for user=${user.id} node=${nodeId}: ${upsertError.message}`);
    throw new ActionError('Failed to stall node. Please try again.', 'DB_ERROR');
  }

  console.log(
    `[Irminsul/stallNode] node=${nodeId} → stalled (recalculation_count=${nextCount}) for user=${user.id}`,
  );
  revalidatePath(`/tree/${goalSlug}`);
}