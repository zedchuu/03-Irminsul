"use client";

// =============================================================================
// src/components/TechTree/TechTreeNode.tsx
// Phase 3.3 — Custom React Flow Node Renderer
//
// Receives TechTreeNodeData via React Flow's NodeProps generic.
// Renders as a dark, tactical "mission briefing" card.
//
// Status states (Phase 3 stub — all nodes render as 'unlocked' for now):
//   locked   — grayed out, no interaction
//   unlocked — amber accent, interactive (current default)
//   mastered — green accent, completed
//
// Phase 4 gate: inject real NodeStatus from user_progress via a data prop
// and switch the status CSS class dynamically.
// =============================================================================

import { memo } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { TechTreeNodeData } from "@/services/graphService";

// Typed node shape for React Flow v12.
// NodeProps requires Node<DataType, NodeType> where DataType must satisfy
// Record<string, unknown>. TechTreeNodeData is a closed interface (no index
// signature) so it fails that constraint directly.
//
// Fix: intersect with Record<string, unknown> at this use site only.
// This satisfies the generic bound without modifying TechTreeNodeData in
// graphService.ts (which is server-only and must stay React Flow-agnostic).
// The intersection adds no runtime behaviour — it only broadens the type
// so the index signature constraint is satisfied.
type TechTreeNodeType = Node<TechTreeNodeData & Record<string, unknown>, "techTreeNode">;

// ---------------------------------------------------------------------------
// Status palette
// Defined as a constant map so Phase 4 can swap status without touching JSX.
// ---------------------------------------------------------------------------

const STATUS_STYLES = {
  locked: {
    border: "border-slate-700",
    accent: "bg-slate-700",
    label: "text-slate-500",
    badge: "text-slate-600 border-slate-700",
    glow: "",
  },
  unlocked: {
    border: "border-amber-500/60",
    accent: "bg-amber-500",
    label: "text-amber-100",
    badge: "text-amber-400/80 border-amber-500/40",
    glow: "shadow-[0_0_18px_rgba(245,158,11,0.15)]",
  },
  mastered: {
    border: "border-emerald-500/60",
    accent: "bg-emerald-500",
    label: "text-emerald-100",
    badge: "text-emerald-400/80 border-emerald-500/40",
    glow: "shadow-[0_0_18px_rgba(16,185,129,0.15)]",
  },
} as const;

type NodeStatusKey = keyof typeof STATUS_STYLES;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function TechTreeNode({ data, selected }: NodeProps<TechTreeNodeType>) {
  // Phase 3 stub: all nodes are 'unlocked'.
  // Phase 4: derive from data.status ?? 'locked'
  const status: NodeStatusKey = "unlocked";
  const styles = STATUS_STYLES[status];

  // `data` is already TechTreeNodeData — no cast needed.
  // The NodeProps<TechTreeNodeType> generic above wires this up at compile time.

  return (
    <>
      {/* Incoming edge handle — top center */}
      <Handle
        type="target"
        position={Position.Top}
        className="!w-2 !h-2 !bg-slate-600 !border-slate-500"
      />

      {/* Card */}
      <div
        className={`
          relative w-52 rounded-sm border bg-[#0d1117]
          transition-all duration-200 cursor-pointer
          ${styles.border}
          ${styles.glow}
          ${selected ? "ring-1 ring-amber-400/50 ring-offset-0" : ""}
          hover:brightness-110
        `}
      >
        {/* Top accent bar */}
        <div className={`h-[2px] w-full rounded-t-sm ${styles.accent}`} />

        {/* Body */}
        <div className="px-3 py-2.5 space-y-2">
          {/* Sequence order badge + status */}
          <div className="flex items-center justify-between">
            <span
              className={`
                font-mono text-[10px] tracking-widest uppercase
                border px-1.5 py-0.5 rounded-sm
                ${styles.badge}
              `}
            >
              NODE {String(data.sequenceOrder + 1).padStart(2, "0")}
            </span>
            <span
              className={`
                font-mono text-[10px] tracking-widest uppercase
                ${styles.badge.split(" ")[0]}
              `}
            >
              {status}
            </span>
          </div>

          {/* Title */}
          <p
            className={`
              text-sm font-semibold leading-snug tracking-tight
              ${styles.label}
            `}
          >
            {data.label}
          </p>

          {/* Estimated time */}
          <div className="flex items-center gap-1 pt-0.5">
            <svg
              className="w-3 h-3 text-slate-600 shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            <span className="font-mono text-[10px] text-slate-600">
              {data.estimatedMinutes} min
            </span>
          </div>
        </div>

        {/* Selected indicator — left border flash */}
        {selected && (
          <div className="absolute inset-y-0 left-0 w-[2px] bg-amber-400 rounded-l-sm" />
        )}
      </div>

      {/* Outgoing edge handle — bottom center */}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-2 !h-2 !bg-slate-600 !border-slate-500"
      />
    </>
  );
}

// memo: React Flow re-renders nodes on every canvas interaction (pan, zoom,
// selection). Memoising prevents re-renders when node data hasn't changed.
export default memo(TechTreeNode);