"use client";

// =============================================================================
// src/components/TechTree/TechTreeCanvas.tsx
// Irminsul — Phase 4.4: Completion Cascade
//
// Changes from Phase 4.3:
//   - goalSlug is injected into each node's data payload before initialising
//     RF state. TechTreeNode receives it as data.goalSlug and uses it to call
//     completeNode() without needing a separate prop channel.
//   - statusKey sync effect unchanged — still keys on id:status pairs.
// =============================================================================

import { useCallback, useTransition, useEffect } from "react";
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

import { TECH_TREE_NODE_TYPE } from "@/lib/constants";
import type { RFEdge } from "@/services/graphService";
import type { HydratedRFNode } from "@/services/progressService";
import { startNode } from "@/app/actions/progressActions";
import { ActionError } from "@/lib/errors";
import TechTreeNode from "./TechTreeNode";

const NODE_TYPES: NodeTypes = {
  [TECH_TREE_NODE_TYPE]: TechTreeNode,
};

const MINIMAP_NODE_COLOR = "rgba(245, 158, 11, 0.4)";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TechTreeCanvasProps {
  initialNodes: HydratedRFNode[];
  initialEdges: RFEdge[];
  goalSlug: string;
  goalTitle?: string;
}

// ---------------------------------------------------------------------------
// Helper — inject goalSlug into node data
//
// TechTreeNode needs goalSlug to call completeNode(nodeId, goalSlug).
// Threading it as a separate prop would require exposing it through RF's
// nodeTypes registry (complex). Injecting it into node.data is the
// idiomatic RF pattern for shared canvas-level context.
// ---------------------------------------------------------------------------
function injectSlug(nodes: HydratedRFNode[], slug: string): HydratedRFNode[] {
  return nodes.map(node => ({
    ...node,
    data: { ...node.data, goalSlug: slug },
  }));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function TechTreeCanvas({
  initialNodes,
  initialEdges,
  goalSlug,
  goalTitle,
}: TechTreeCanvasProps) {
  const [isPending, startTransition] = useTransition();

  // Inject slug before initialising RF state and before the statusKey check.
  const nodesWithSlug = injectSlug(initialNodes, goalSlug);

  const [nodes, setNodes, onNodesChange] = useNodesState(
    nodesWithSlug as unknown as Node[]
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState(
    initialEdges as unknown as Edge[]
  );

  // Sync RSC prop updates into RF internal state — keyed on content not reference.
  const statusKey = nodesWithSlug.map(n => `${n.id}:${n.data.status}`).join(',');
  useEffect(() => {
    setNodes(nodesWithSlug as unknown as Node[]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusKey]);

  const onConnect = useCallback(
    (connection: Connection) => setEdges((eds) => addEdge(connection, eds)),
    [setEdges],
  );

  // Canvas-level click — only handles UNLOCKED → IN_PROGRESS transition.
  // IN_PROGRESS → COMPLETED is handled inside TechTreeNode via the button.
  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      const hydratedNode = node as unknown as HydratedRFNode;
      if (hydratedNode.data.status !== 'UNLOCKED') return;
      if (isPending) return;

      startTransition(async () => {
        try {
          await startNode(node.id, goalSlug);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          console.error(`[TechTreeCanvas] startNode failed: ${message}`);
        }
      });
    },
    [goalSlug, isPending, startTransition],
  );

  return (
    <ReactFlowProvider>
      <div
        className="relative w-full h-full bg-[#080b10]"
        style={{ touchAction: "none", cursor: isPending ? 'wait' : 'default' }}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          nodeTypes={NODE_TYPES}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          deleteKeyCode={null}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="rgba(255,255,255,0.04)" />

          <Controls
            showInteractive={false}
            className="[&>button]:bg-[#0d1117] [&>button]:border-slate-700 [&>button]:text-slate-400 [&>button:hover]:bg-slate-800"
          />

          <MiniMap
            nodeColor={MINIMAP_NODE_COLOR}
            maskColor="rgba(8,11,16,0.85)"
            style={{ backgroundColor: "#0d1117", border: "1px solid rgba(100,116,139,0.3)" }}
            className="rounded-sm"
          />

          {goalTitle && (
            <Panel position="top-left">
              <div className="bg-[#0d1117]/90 border border-slate-700/60 rounded-sm px-3 py-2 backdrop-blur-sm">
                <p className="font-mono text-[10px] text-slate-600 uppercase tracking-widest mb-0.5">Tech Tree</p>
                <h2 className="text-sm font-semibold text-amber-100 tracking-tight">{goalTitle}</h2>
              </div>
            </Panel>
          )}

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

        {isPending && (
          <div
            className="absolute inset-0 flex items-center justify-center bg-black/30 backdrop-blur-[1px] z-10"
            aria-live="polite"
            aria-label="Updating..."
          >
            <div className="flex items-center gap-2 bg-[#0d1117]/90 border border-emerald-700/50 rounded-md px-4 py-2.5">
              <svg className="w-4 h-4 text-emerald-400 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span className="text-xs font-mono text-emerald-400">Updating path...</span>
            </div>
          </div>
        )}
      </div>
    </ReactFlowProvider>
  );
}