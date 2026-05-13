// =============================================================================
// src/services/graphService.ts
// Phase 3.1 — Graph Data Service
//
// Server-only. No client-side code. No external layout libraries.
// Exports: generateGraphData(goalId)
// =============================================================================

import { createClient } from '@/utils/supabase/server';
import type { NodePrerequisite } from '@/types/database.types';
// Aliased to avoid collision with the DOM global `Node` type present in Next.js.
import type { Node as IrminsulNode } from '@/types/database.types';

// ---------------------------------------------------------------------------
// React Flow shape contracts
// Defined here so this file has no runtime import from 'reactflow', keeping
// it purely server-side. The Client Component will re-assert these against
// the actual reactflow types when it receives them as props.
// ---------------------------------------------------------------------------

/** Positional data required by React Flow for each node. */
export interface RFPosition {
  x: number;
  y: number;
}

/** Data payload embedded inside each React Flow node — safe for client serialisation. */
export interface TechTreeNodeData {
  label: string;
  lessonContext: string;
  estimatedMinutes: number;
  sequenceOrder: number;
}

/** React Flow Node shape (server-safe subset). */
export interface RFNode {
  id: string;
  type: 'techTreeNode'; // maps to the custom node renderer registered in TechTreeCanvas
  position: RFPosition;
  data: TechTreeNodeData;
}

/** React Flow Edge shape (server-safe subset). */
export interface RFEdge {
  id: string;
  source: string; // prerequisite_id — must be completed first
  target: string; // node_id — unlocked after source
  type: 'smoothstep';
}

/** The final output shape returned to the Server Component parent. */
export interface GraphData {
  nodes: RFNode[];
  edges: RFEdge[];
}

// ---------------------------------------------------------------------------
// Internal working types — never leave this module
// ---------------------------------------------------------------------------

/**
 * Enriched representation used during graph construction.
 * Combines the DB node row with its resolved prerequisite IDs and
 * computed layout metadata.
 */
interface GraphNode {
  dbNode: IrminsulNode;
  /** UUIDs of nodes that must be completed before this one. */
  prerequisiteIds: Set<string>;
  /** UUIDs of nodes that depend on this one (outgoing edges). */
  dependentIds: Set<string>;
  /** Topological depth (0 = root, n = nth generation). Assigned during sort. */
  depth: number;
  /**
   * Sibling index within its depth level.
   * Assigned during x-coordinate calculation — not meaningful until after sort.
   */
  siblingIndex: number;
}

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

/** Vertical distance (px) between topological depth levels. */
const LEVEL_HEIGHT = 150;

/** Horizontal distance (px) between sibling nodes at the same depth. */
const NODE_WIDTH_GAP = 220;

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

/** Raw rows fetched from the `nodes` table for a given goal. */
async function fetchNodes(
  supabase: Awaited<ReturnType<typeof createClient>>,
  goalId: string,
): Promise<IrminsulNode[]> {
  const { data, error } = await supabase
    .from('nodes')
    .select(
      'id, goal_id, title, lesson_context, actionable_tasks, estimated_minutes, ' +
        'sequence_order, source, last_verified_at, access_count, is_deprecated, ' +
        'created_at, updated_at'
    )
    .eq('goal_id', goalId)
    .eq('is_deprecated', false)
    .order('sequence_order', { ascending: true });

  if (error) {
    throw new Error(
      `[graphService] Failed to fetch nodes for goal "${goalId}": ${error.message}`
    );
  }

  return (data ?? []) as IrminsulNode[];
}

/** Raw rows fetched from `node_prerequisites` for the resolved node IDs. */
async function fetchPrerequisites(
  supabase: Awaited<ReturnType<typeof createClient>>,
  nodeIds: string[],
): Promise<NodePrerequisite[]> {
  if (nodeIds.length === 0) return [];

  const { data, error } = await supabase
    .from('node_prerequisites')
    .select('node_id, prerequisite_id')
    .in('node_id', nodeIds);

  if (error) {
    throw new Error(
      `[graphService] Failed to fetch prerequisites for nodes [${nodeIds.join(', ')}]: ${error.message}`
    );
  }

  return (data ?? []) as NodePrerequisite[];
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

/**
 * Builds the internal `GraphNode` map from raw DB rows.
 * Prerequisite IDs that reference nodes outside the current goal's node set
 * are silently dropped — orphaned cross-goal edges should never exist given
 * the FK constraints, but this guards against stale data during migrations.
 */
function buildGraphMap(
  nodes: IrminsulNode[],
  prerequisites: NodePrerequisite[]
): Map<string, GraphNode> {
  const nodeIds = new Set(nodes.map((n) => n.id));

  // Initialise every node with empty adjacency sets
  const graphMap = new Map<string, GraphNode>(
    nodes.map((dbNode) => [
      dbNode.id,
      {
        dbNode,
        prerequisiteIds: new Set<string>(),
        dependentIds: new Set<string>(),
        depth: 0,
        siblingIndex: 0,
      },
    ])
  );

  // Wire up edges
  for (const { node_id, prerequisite_id } of prerequisites) {
    if (!nodeIds.has(node_id) || !nodeIds.has(prerequisite_id)) continue;

    const target = graphMap.get(node_id)!;
    const source = graphMap.get(prerequisite_id)!;

    target.prerequisiteIds.add(prerequisite_id);
    source.dependentIds.add(node_id);
  }

  return graphMap;
}

// ---------------------------------------------------------------------------
// Cycle detection & topological sort (Kahn's algorithm)
// ---------------------------------------------------------------------------

/**
 * Performs a topological sort using Kahn's BFS algorithm and simultaneously
 * assigns a `depth` value to each node.
 *
 * Kahn's algorithm is chosen over DFS-based sort because it makes cycle
 * detection trivial: if the number of processed nodes is less than the total
 * node count at the end, the unprocessed nodes form one or more cycles.
 *
 * Depth semantics:
 *   A node's depth = max(depth of all its prerequisites) + 1.
 *   Root nodes (no prerequisites) receive depth 0.
 *
 * @throws {Error} If a cycle is detected, with the cyclic node IDs listed.
 */
function topologicalSortWithDepth(graphMap: Map<string, GraphNode>): void {
  // In-degree = number of prerequisites not yet processed
  const inDegree = new Map<string, number>();
  for (const [id, graphNode] of graphMap) {
    inDegree.set(id, graphNode.prerequisiteIds.size);
  }

  // Queue starts with all root nodes (no prerequisites)
  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  let processedCount = 0;

  while (queue.length > 0) {
    // Use a stable sort within each BFS wave so layout is deterministic
    // across identical data sets — sort by sequence_order ascending.
    queue.sort(
      (a, b) =>
        graphMap.get(a)!.dbNode.sequence_order -
        graphMap.get(b)!.dbNode.sequence_order
    );

    const currentId = queue.shift()!;
    const current = graphMap.get(currentId)!;
    processedCount++;

    for (const dependentId of current.dependentIds) {
      const dependent = graphMap.get(dependentId)!;

      // A node's depth is the maximum depth across all its prerequisites + 1.
      // This places it one level below its deepest ancestor.
      dependent.depth = Math.max(dependent.depth, current.depth + 1);

      const newDegree = inDegree.get(dependentId)! - 1;
      inDegree.set(dependentId, newDegree);

      if (newDegree === 0) {
        queue.push(dependentId);
      }
    }
  }

  // If not all nodes were processed, the remainder form cycles.
  if (processedCount < graphMap.size) {
    const cyclicIds = [...graphMap.keys()].filter(
      (id) => inDegree.get(id)! > 0
    );
    throw new Error(
      `[graphService] Cycle detected in prerequisite graph for nodes: [${cyclicIds.join(', ')}]. ` +
        'A Tech Tree must be a Directed Acyclic Graph (DAG). ' +
        'Inspect the node_prerequisites table for these IDs and remove the circular dependency.'
    );
  }
}

// ---------------------------------------------------------------------------
// Layout: x/y coordinate assignment
// ---------------------------------------------------------------------------

/**
 * Assigns `siblingIndex` to every node, then derives (x, y) from depth and
 * siblingIndex. Siblings within the same depth level are centred around x=0.
 *
 * Centring formula:
 *   totalWidth = (siblingCount - 1) * NODE_WIDTH_GAP
 *   x = siblingIndex * NODE_WIDTH_GAP - totalWidth / 2
 *
 * This keeps the tree visually balanced regardless of how wide any given
 * level is.
 */
function assignCoordinates(
  graphMap: Map<string, GraphNode>
): Map<string, RFPosition> {
  // Group nodes by depth
  const depthBuckets = new Map<number, string[]>();
  for (const [id, graphNode] of graphMap) {
    const bucket = depthBuckets.get(graphNode.depth) ?? [];
    bucket.push(id);
    depthBuckets.set(graphNode.depth, bucket);
  }

  const positions = new Map<string, RFPosition>();

  for (const [depth, ids] of depthBuckets) {
    // Sort siblings by sequence_order for a stable, readable left-to-right order
    ids.sort(
      (a, b) =>
        graphMap.get(a)!.dbNode.sequence_order -
        graphMap.get(b)!.dbNode.sequence_order
    );

    const count = ids.length;
    const totalWidth = (count - 1) * NODE_WIDTH_GAP;

    ids.forEach((id, index) => {
      graphMap.get(id)!.siblingIndex = index;
      positions.set(id, {
        x: index * NODE_WIDTH_GAP - totalWidth / 2,
        y: depth * LEVEL_HEIGHT,
      });
    });
  }

  return positions;
}

// ---------------------------------------------------------------------------
// React Flow shape serialisation
// ---------------------------------------------------------------------------

function toRFNodes(
  graphMap: Map<string, GraphNode>,
  positions: Map<string, RFPosition>
): RFNode[] {
  return [...graphMap.values()].map(({ dbNode }) => ({
    id: dbNode.id,
    type: 'techTreeNode' as const,
    position: positions.get(dbNode.id)!,
    data: {
      label: dbNode.title,
      lessonContext: dbNode.lesson_context,
      estimatedMinutes: dbNode.estimated_minutes,
      sequenceOrder: dbNode.sequence_order,
    },
  }));
}

function toRFEdges(prerequisites: NodePrerequisite[], validNodeIds: Set<string>): RFEdge[] {
  return prerequisites
    .filter(
      ({ node_id, prerequisite_id }) =>
        validNodeIds.has(node_id) && validNodeIds.has(prerequisite_id)
    )
    .map(({ node_id, prerequisite_id }) => ({
      // Edge ID is deterministic and collision-free: source→target
      id: `edge-${prerequisite_id}-${node_id}`,
      source: prerequisite_id,
      target: node_id,
      type: 'smoothstep' as const,
    }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates all data required to render the Tech Tree for a given goal.
 *
 * Execution order:
 *   1. Fetch non-deprecated nodes from Supabase.
 *   2. Fetch prerequisite relationships for those node IDs.
 *   3. Build an internal adjacency map.
 *   4. Run Kahn's topological sort — throws on cycle detection.
 *   5. Assign (x, y) coordinates from depth + sibling index.
 *   6. Serialise to React Flow `RFNode[]` and `RFEdge[]`.
 *
 * This function is server-only. Call it from a Server Component or Server Action.
 * The returned `GraphData` is safe to pass as props to a Client Component.
 *
 * @param goalId - UUID of the goal whose nodes should be rendered.
 * @returns `GraphData` — `{ nodes: RFNode[], edges: RFEdge[] }`
 * @throws If Supabase queries fail, or if the prerequisite graph contains a cycle.
 */
export async function generateGraphData(goalId: string): Promise<GraphData> {
  if (!goalId) {
    throw new Error('[graphService] generateGraphData requires a non-empty goalId.');
  }

  const supabase = await createClient();

  // 1 & 2: Sequential fetch — prerequisites scoped to returned node IDs
  const rawNodes = await fetchNodes(supabase, goalId);

  if (rawNodes.length === 0) {
    return { nodes: [], edges: [] };
  }

  const nodeIds = rawNodes.map((n) => n.id);
  const rawPrerequisites = await fetchPrerequisites(supabase, nodeIds);

  // 3: Build internal graph map
  const graphMap = buildGraphMap(rawNodes, rawPrerequisites);

  // 4: Topological sort + cycle detection (mutates graphMap.depth in place)
  topologicalSortWithDepth(graphMap);

  // 5: Coordinate assignment
  const positions = assignCoordinates(graphMap);

  // 6: Serialise to React Flow shapes
  const validNodeIds = new Set(nodeIds);
  const rfNodes = toRFNodes(graphMap, positions);
  const rfEdges = toRFEdges(rawPrerequisites, validNodeIds);

  return { nodes: rfNodes, edges: rfEdges };
}