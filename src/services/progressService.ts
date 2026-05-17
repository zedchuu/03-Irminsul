// =============================================================================
// src/services/progressService.ts
// Irminsul — Phase 4.1: State Hydration
//
// Responsibilities:
//   1. Fetch raw `user_progress` rows from Supabase for a given set of nodes.
//   2. Merge that progress into a React Flow node graph, deriving display state
//      from both DB records AND edge topology (LOCKED / UNLOCKED logic).
//
// Type architecture:
//   This service imports `RFNode`, `RFEdge`, and `TechTreeNodeData` from
//   `graphService` — the single source of truth for React Flow shapes.
//   It does NOT redeclare those types. Adding a second definition caused
//   structural mismatches at the TechTreeCanvas call site (Phase 4.2 fix).
//
//   The hydration layer introduces two NEW types built on top of graphService:
//     HydratedNodeData  — TechTreeNodeData extended with status + userProgress.
//     HydratedRFNode    — RFNode with data narrowed to HydratedNodeData.
//
//   The hydration function signature is therefore:
//     (nodes: RFNode[], edges: RFEdge[], progress: UserProgress[]) → HydratedRFNode[]
//   which is a strict narrowing: HydratedRFNode extends RFNode, so the output
//   is assignable to any context that accepts RFNode[].
//
// Two-layer status model:
//   `NodeStatus`     (DB)  — 'not_started' | 'in_progress' | 'completed' | 'stalled'
//                            Persisted in `user_progress.status`. What the user *did*.
//   `TreeNodeStatus` (UI)  — 'LOCKED' | 'UNLOCKED' | 'IN_PROGRESS' | 'COMPLETED'
//                            Derived at runtime from DB status + edge topology.
//                            Never written to the DB; computed fresh on each render.
//
// The Diamond Problem:
//   A node is UNLOCKED only when *every* incoming edge's source is COMPLETED.
//   Enforced by `every()` in Pass 3 — not `some()`.
//
// Stall mapping:
//   DB `stalled` → UI `IN_PROGRESS`. The stall detail is surfaced via
//   `recalculation_count` in the node data payload, not via a separate
//   TreeNodeStatus value.
// =============================================================================

import { createClient } from '@/utils/supabase/server';
import type { UserProgress, NodeStatus } from '@/types/database.types';
import type { RFNode, RFEdge, TechTreeNodeData } from '@/services/graphService';

// ---------------------------------------------------------------------------
// Re-exports — callers get everything from one import path.
// ---------------------------------------------------------------------------
export type { UserProgress, RFNode, RFEdge };

// ---------------------------------------------------------------------------
// TreeNodeStatus — UI display state (NOT a DB value)
// ---------------------------------------------------------------------------
export type TreeNodeStatus = 'LOCKED' | 'UNLOCKED' | 'IN_PROGRESS' | 'COMPLETED';

// ---------------------------------------------------------------------------
// HydratedNodeData
//
// Extends graphService's TechTreeNodeData with two hydration fields.
// The index signature satisfies @xyflow/react v12's
// `Node<T extends Record<string, unknown>>` constraint — required for
// the `Node<HydratedNodeData>` type used in TechTreeNode.tsx.
//
// Named fields override the index signature's `unknown` type —
// TypeScript's excess property rules still apply to the named keys.
// ---------------------------------------------------------------------------
export interface HydratedNodeData extends TechTreeNodeData {
  /** Satisfies @xyflow/react v12 Node<T extends Record<string, unknown>>. */
  [key: string]: unknown;
  /** Render-time display state derived from DB status + edge topology. */
  status: TreeNodeStatus;
  /**
   * Goal URL slug injected by TechTreeCanvas at runtime.
   * Used by TechTreeNode to call completeNode(nodeId, goalSlug).
   * Not part of the DB shape — always undefined until injected.
   */
  goalSlug?: string;
  /**
   * Live progress snapshot. Null for nodes the user has never opened.
   */
  userProgress: Pick<
    UserProgress,
    'status' | 'last_interacted_at' | 'recalculation_count' | 'recalculated_tasks'
  > | null;
}

/**
 * An RFNode whose data payload has been hydrated with user progress state.
 * Assignable to RFNode[] — safe to pass anywhere RFNode is expected.
 */
export interface HydratedRFNode extends Omit<RFNode, 'data'> {
  data: HydratedNodeData;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Maps a DB NodeStatus to the closest TreeNodeStatus equivalent.
 * LOCKED and UNLOCKED are topology-derived — they are never the output
 * of this function. 'not_started' returns UNLOCKED as a base; Pass 3
 * in hydrateGraphWithProgress may downgrade it to LOCKED if prerequisites
 * are unmet.
 */
function dbStatusToTreeStatus(dbStatus: NodeStatus): TreeNodeStatus {
  switch (dbStatus) {
    case 'completed':   return 'COMPLETED';
    case 'in_progress': return 'IN_PROGRESS';
    case 'stalled':     return 'IN_PROGRESS'; // stall rendered via recalculation_count
    case 'not_started': return 'UNLOCKED';    // topology check in Pass 3 may override
  }
}

// ---------------------------------------------------------------------------
// Public API — 1: Data Fetching
// ---------------------------------------------------------------------------

/**
 * Fetches all `user_progress` rows for the given user and node IDs.
 *
 * Takes `nodeIds` rather than `goalId` — decoupled from goal-level concerns.
 * The caller extracts node IDs from the graph produced by generateGraphData.
 *
 * Returns an empty array (not an error) when the user has no recorded progress —
 * normal for a brand-new user. The tree renders in its default topology state.
 *
 * @param userId  - Authenticated user UUID from supabase.auth.getUser().
 * @param nodeIds - Node UUIDs to query progress for.
 */
export async function getUserProgressForNodes(
  userId: string,
  nodeIds: string[],
): Promise<UserProgress[]> {
  if (nodeIds.length === 0) return [];

  const supabase = await createClient();

  const { data, error } = await supabase
    .from('user_progress')
    .select(
      'id, user_id, node_id, status, last_interacted_at, started_at, completed_at, recalculation_count, recalculated_tasks',
    )
    .eq('user_id', userId)
    .in('node_id', nodeIds);

  if (error) {
    console.error(
      `[Irminsul/Progress] getUserProgressForNodes failed (non-fatal): ${error.message}`,
    );
    return [];
  }

  return (data ?? []) as UserProgress[];
}

// ---------------------------------------------------------------------------
// Public API — 2: State Hydration
// ---------------------------------------------------------------------------

/**
 * Merges user progress into a React Flow node graph, computing each node's
 * TreeNodeStatus from DB records and edge topology.
 *
 * Algorithm — three passes:
 *
 *   Pass 1 — Index inputs:
 *     Map<nodeId, UserProgress> for O(1) progress lookups.
 *     Map<nodeId, Set<sourceId>> of incoming edges (prerequisite map).
 *
 *   Pass 2 — Resolve initial TreeNodeStatus per node:
 *     DB record present  → dbStatusToTreeStatus(record.status)
 *     No DB record       → UNLOCKED (root) or LOCKED (has prerequisites)
 *
 *   Pass 3 — Prerequisite unlock check (Diamond Problem):
 *     For every LOCKED node, if ALL prerequisite nodes resolved to COMPLETED
 *     in Pass 2 → upgrade to UNLOCKED.
 *     Uses every() not some() — a single incomplete prerequisite blocks unlock.
 *
 * Does not mutate the input arrays. Returns a new HydratedRFNode[] with new
 * data objects — safe for React's immutability contract.
 *
 * @param nodes        - RFNode[] from graphService.generateGraphData.
 * @param edges        - RFEdge[] from graphService.generateGraphData.
 * @param userProgress - Rows from getUserProgressForNodes.
 */
export function hydrateGraphWithProgress(
  nodes: RFNode[],
  edges: RFEdge[],
  userProgress: UserProgress[],
): HydratedRFNode[] {
  // ── Pass 1a: Index progress by node_id ───────────────────────────────────
  const progressByNodeId = new Map<string, UserProgress>();
  for (const record of userProgress) {
    progressByNodeId.set(record.node_id, record);
  }

  // ── Pass 1b: Build prerequisite map ──────────────────────────────────────
  // nodeId → Set of source node IDs (nodes that must be COMPLETED first).
  // Nodes absent from this map are root nodes with no prerequisites.
  const prerequisitesByNodeId = new Map<string, Set<string>>();
  for (const edge of edges) {
    const existing = prerequisitesByNodeId.get(edge.target);
    if (existing) {
      existing.add(edge.source);
    } else {
      prerequisitesByNodeId.set(edge.target, new Set([edge.source]));
    }
  }

  // ── Pass 2: Resolve initial TreeNodeStatus ───────────────────────────────
  const resolvedStatus = new Map<string, TreeNodeStatus>();

  for (const node of nodes) {
    const progressRecord = progressByNodeId.get(node.id);
    const hasPrerequisites = prerequisitesByNodeId.has(node.id);

    let status: TreeNodeStatus;

    if (progressRecord) {
      status = dbStatusToTreeStatus(progressRecord.status);
    } else {
      status = hasPrerequisites ? 'LOCKED' : 'UNLOCKED';
    }

    resolvedStatus.set(node.id, status);
  }

  // ── Pass 3: Unlock nodes whose every prerequisite is COMPLETED ───────────
  for (const [nodeId, prerequisites] of prerequisitesByNodeId) {
    if (resolvedStatus.get(nodeId) !== 'LOCKED') continue;

    const allCompleted = [...prerequisites].every(
      (prereqId) => resolvedStatus.get(prereqId) === 'COMPLETED',
    );

    if (allCompleted) {
      resolvedStatus.set(nodeId, 'UNLOCKED');
    }
  }

  // ── Final pass: Assemble HydratedRFNode[] ────────────────────────────────
  return nodes.map((node): HydratedRFNode => {
    const progressRecord = progressByNodeId.get(node.id) ?? null;
    const finalStatus = resolvedStatus.get(node.id) ?? 'LOCKED';

    return {
      ...node,
      data: {
        ...node.data,
        status: finalStatus,
        userProgress: progressRecord
          ? {
              status: progressRecord.status,
              last_interacted_at: progressRecord.last_interacted_at,
              recalculation_count: progressRecord.recalculation_count,
              recalculated_tasks: progressRecord.recalculated_tasks,
            }
          : null,
      },
    };
  });
}