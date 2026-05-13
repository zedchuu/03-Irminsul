// =============================================================================
// src/lib/constants.ts
// Shared compile-time constants for Irminsul.
//
// Rules:
//   - No runtime logic. Pure constant exports only.
//   - Safe to import from both Server Components and Client Components.
//   - All magic strings shared across service ↔ component boundaries live here.
// =============================================================================

/**
 * The React Flow node type key for Irminsul's custom tech tree node renderer.
 *
 * Must match the key used when registering the custom node in TechTreeCanvas.tsx:
 *   const nodeTypes = { [TECH_TREE_NODE_TYPE]: TechTreeNode };
 *
 * And the `type` field emitted by graphService.ts:
 *   { id, type: TECH_TREE_NODE_TYPE, position, data }
 *
 * Never hardcode 'techTreeNode' directly in either file — a rename here
 * propagates automatically via the type system.
 */
export const TECH_TREE_NODE_TYPE = 'techTreeNode' as const;