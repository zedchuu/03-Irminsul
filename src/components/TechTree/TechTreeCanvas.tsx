"use client";

// =============================================================================
// src/components/TechTree/TechTreeCanvas.tsx
// Phase 3.3 — React Flow Canvas (Client Component)
//
// TYPE BOUNDARY CONTRACT (Option A — GM decision):
//   Props are typed using our internal domain types (RFNode, RFEdge) from
//   graphService.ts. @xyflow/react types NEVER cross the server boundary.
//   This component is the translation layer: it accepts pure data shapes from
//   the Server Component parent and casts them to React Flow types internally,
//   at the <ReactFlow> call site only.
//
//   graphService.ts  →  RFNode[] / RFEdge[]  →  [this component]  →  Node[] / Edge[]
//                                                     ↑
//                                              cast happens here
//
// Controls:
//   Background  — dot grid pattern
//   Controls    — zoom in/out/fit
//   MiniMap     — navigation for large skill trees
//
// Custom node:
//   TechTreeNode — registered under TECH_TREE_NODE_TYPE from constants.ts.
//   All nodes from graphService carry type: 'techTreeNode' which React Flow
//   resolves against this registry at render time.
// =============================================================================

import { useCallback } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  type Node,
  type Edge,
  type Connection,
  type NodeTypes,
  Panel,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

// Path note: ensure src/lib/constants.ts exists and tsconfig.json includes
// "paths": { "@/*": ["./src/*"] }. If your tsconfig maps @/ to the project
// root rather than src/, change this to "@/src/lib/constants".
import { TECH_TREE_NODE_TYPE } from "@/lib/constants";
import type { RFNode, RFEdge } from "@/services/graphService";
import TechTreeNode from "./TechTreeNode";

// ---------------------------------------------------------------------------
// Node type registry
// Maps the TECH_TREE_NODE_TYPE constant to our custom renderer.
// Defined outside the component to maintain referential stability —
// React Flow re-registers node types if this object is recreated on each render,
// causing all nodes to unmount and remount unnecessarily.
// ---------------------------------------------------------------------------

const NODE_TYPES: NodeTypes = {
  [TECH_TREE_NODE_TYPE]: TechTreeNode,
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TechTreeCanvasProps {
  /** Pre-computed nodes from graphService.generateGraphData() */
  initialNodes: RFNode[];
  /** Pre-computed edges from graphService.generateGraphData() */
  initialEdges: RFEdge[];
  /** Optional: goal title displayed in the top-left panel */
  goalTitle?: string;
}

// ---------------------------------------------------------------------------
// MiniMap node color
// In @xyflow/react v12 the nodeColor prop accepts a plain string (applied to
// all nodes) or a callback (node: Node) => string. MiniMapNodeProps was
// removed. Phase 3 uses a flat color since all nodes share the unlocked state.
// Phase 4: replace with a callback that switches on node.data?.status.
// ---------------------------------------------------------------------------
const MINIMAP_NODE_COLOR = "rgba(245, 158, 11, 0.4)"; // amber-500 @ 40%

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function TechTreeCanvas({
  initialNodes,
  initialEdges,
  goalTitle,
}: TechTreeCanvasProps) {
  // ── Type boundary cast ───────────────────────────────────────────────────
  // RFNode and RFEdge are structurally compatible with @xyflow/react's Node
  // and Edge types — they are intentionally designed as a server-safe subset.
  // The cast is safe because:
  //   - RFNode.type is 'techTreeNode' (a valid custom node type string)
  //   - RFNode.position satisfies { x: number; y: number }
  //   - RFNode.data satisfies Record<string, unknown> (React Flow's constraint)
  //   - RFEdge.type is 'smoothstep' (a built-in React Flow edge type)
  // This is the ONLY place @xyflow/react types are referenced against our data.
  const [nodes, setNodes, onNodesChange] = useNodesState(
    initialNodes as unknown as Node[]
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState(
    initialEdges as unknown as Edge[]
  );

  // ── Edge connection handler ───────────────────────────────────────────────
  // Required by React Flow even in a read-heavy context. In Phase 3 the graph
  // is read-only (edges are generated server-side), but this keeps React Flow
  // happy and sets us up for potential drag-to-connect in Phase 4.
  const onConnect = useCallback(
    (connection: Connection) =>
      setEdges((eds) => addEdge(connection, eds)),
    [setEdges]
  );

  return (
    <ReactFlowProvider>
    <div
      className="relative w-full h-full bg-[#080b10]"
      style={{ touchAction: "none" }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={NODE_TYPES}
        // fitView centers and scales the graph to fill the canvas on load.
        // fitViewOptions padding gives breathing room so edge labels aren't clipped.
        fitView
        fitViewOptions={{ padding: 0.2 }}
        // Prevent users from deleting nodes/edges via keyboard in Phase 3.
        // Phase 4: remove this once edit mode is implemented.
        deleteKeyCode={null}
        // proOptions suppresses the React Flow attribution watermark.
        // Only set this if you hold a valid React Flow Pro licence.
        // proOptions={{ hideAttribution: true }}
      >
        {/* ── Background ──────────────────────────────────────────────────── */}
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          color="rgba(255,255,255,0.04)"
        />

        {/* ── Controls ────────────────────────────────────────────────────── */}
        {/* Custom styled via global CSS overrides in globals.css (Phase 4). */}
        {/* React Flow's Controls component injects inline styles that need   */}
        {/* !important overrides to fully theme — deferred to Phase 4.        */}
        <Controls
          showInteractive={false}
          className="[&>button]:bg-[#0d1117] [&>button]:border-slate-700 [&>button]:text-slate-400 [&>button:hover]:bg-slate-800"
        />

        {/* ── MiniMap ─────────────────────────────────────────────────────── */}
        <MiniMap
          nodeColor={MINIMAP_NODE_COLOR}
          maskColor="rgba(8,11,16,0.85)"
          style={{
            backgroundColor: "#0d1117",
            border: "1px solid rgba(100,116,139,0.3)",
          }}
          className="rounded-sm"
        />

        {/* ── Goal title panel ────────────────────────────────────────────── */}
        {goalTitle && (
          <Panel position="top-left">
            <div className="bg-[#0d1117]/90 border border-slate-700/60 rounded-sm px-3 py-2 backdrop-blur-sm">
              <p className="font-mono text-[10px] text-slate-600 uppercase tracking-widest mb-0.5">
                Tech Tree
              </p>
              <h2 className="text-sm font-semibold text-amber-100 tracking-tight">
                {goalTitle}
              </h2>
            </div>
          </Panel>
        )}

        {/* ── Node count panel ────────────────────────────────────────────── */}
        <Panel position="top-right">
          <div className="bg-[#0d1117]/90 border border-slate-700/60 rounded-sm px-3 py-2 backdrop-blur-sm">
            <p className="font-mono text-[10px] text-slate-600 uppercase tracking-widest">
              {nodes.length} node{nodes.length !== 1 ? "s" : ""}{" "}
              <span className="text-slate-700">·</span>{" "}
              {edges.length} edge{edges.length !== 1 ? "s" : ""}
            </p>
          </div>
        </Panel>
      </ReactFlow>
    </div>
    </ReactFlowProvider>
  );
}