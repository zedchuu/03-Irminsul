'use client';

// =============================================================================
// src/components/TechTree/TechTreeNode.tsx
// Irminsul — Phase 4.5: Unhappy Path (Stall State)
//
// Changes from Phase 4.4:
//   - stallNode imported and wired to "I'm Stuck" button.
//   - Button layout changed to a flex column so both buttons stay within
//     the fixed 240px card width without overflow.
//   - Button visibility matrix:
//
//   status       | isStalled | Mark Complete | I'm Stuck / Stall indicator
//   -------------|-----------|---------------|-----------------------------
//   IN_PROGRESS  | false     | ✓ enabled     | ✓ enabled
//   IN_PROGRESS  | true      | ✓ enabled     | disabled "Recalculating..."
//   (all others) | —         | hidden        | hidden
//
//   When isPending (either action in-flight): both buttons disabled.
// =============================================================================

import React, { memo, useTransition } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { Node, NodeProps } from '@xyflow/react';
import type { HydratedNodeData, TreeNodeStatus } from '@/services/progressService';
import { completeNode, stallNode } from '@/app/actions/progressActions';

// ---------------------------------------------------------------------------
// Local data type — extends HydratedNodeData with canvas-injected goalSlug
// ---------------------------------------------------------------------------
interface TechTreeNodeData extends HydratedNodeData {
  goalSlug?: string;
}

type TechTreeNodeType = Node<TechTreeNodeData>;

// ---------------------------------------------------------------------------
// Visual config
// ---------------------------------------------------------------------------

interface NodeVisualConfig {
  wrapperClass: string;
  titleClass: string;
  bodyClass: string;
  pillClass: string;
}

const VISUAL_CONFIG: Record<TreeNodeStatus, NodeVisualConfig> = {
  LOCKED: {
    wrapperClass: 'bg-slate-900 border border-slate-800 opacity-75',
    titleClass: 'text-slate-500',
    bodyClass: 'text-slate-600',
    pillClass: 'bg-slate-800 text-slate-600',
  },
  UNLOCKED: {
    wrapperClass: [
      'bg-gray-900 border border-amber-500/50 cursor-pointer',
      'hover:-translate-y-0.5 hover:border-amber-400/70',
      'transition-all duration-150',
    ].join(' '),
    titleClass: 'text-amber-100',
    bodyClass: 'text-gray-400',
    pillClass: 'bg-amber-950/50 text-amber-400',
  },
  IN_PROGRESS: {
    wrapperClass: [
      'bg-gray-900 border border-emerald-400',
      'shadow-[0_0_15px_rgba(52,211,153,0.2)]',
      'hover:-translate-y-0.5 hover:shadow-[0_0_22px_rgba(52,211,153,0.3)]',
      'transition-all duration-150',
    ].join(' '),
    titleClass: 'text-white',
    bodyClass: 'text-gray-300',
    pillClass: 'bg-emerald-950/60 text-emerald-400',
  },
  COMPLETED: {
    wrapperClass: 'bg-emerald-950/30 border border-emerald-700',
    titleClass: 'text-emerald-200',
    bodyClass: 'text-emerald-400/70',
    pillClass: 'bg-emerald-900/50 text-emerald-500',
  },
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function LockIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"
      className="w-3.5 h-3.5 text-slate-600 flex-shrink-0" aria-hidden="true">
      <path fillRule="evenodd" d="M12 1.5a5.25 5.25 0 0 0-5.25 5.25v3a3 3 0 0 0-3 3v6.75a3 3 0 0 0 3 3h10.5a3 3 0 0 0 3-3v-6.75a3 3 0 0 0-3-3v-3c0-2.9-2.35-5.25-5.25-5.25Zm3.75 8.25v-3a3.75 3.75 0 1 0-7.5 0v3h7.5Z" clipRule="evenodd" />
    </svg>
  );
}

function CompletedBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-900/60 border border-emerald-700/50 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3" aria-hidden="true">
        <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z" clipRule="evenodd" />
      </svg>
      Completed
    </span>
  );
}

function StalledBadge({ count }: { count: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-orange-950/60 border border-orange-700/50 px-2 py-0.5 text-[10px] font-medium text-orange-400">
      <span className="relative flex h-1.5 w-1.5">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-orange-500" />
      </span>
      Recalculated ×{count}
    </span>
  );
}

// ---------------------------------------------------------------------------
// TechTreeNode
// ---------------------------------------------------------------------------

function TechTreeNode({ data, id }: NodeProps<TechTreeNodeType>) {
  const { status, label, lessonContext, estimatedMinutes, userProgress, goalSlug } = data;
  const config = VISUAL_CONFIG[status];
  const [isPending, startTransition] = useTransition();

  // isStalled: IN_PROGRESS with at least one prior stall recorded.
  // DB status 'stalled' maps to UI 'IN_PROGRESS' via hydrateGraphWithProgress.
  // We distinguish it here via recalculation_count so the button matrix
  // can change without introducing a 5th TreeNodeStatus value.
  const isStalled =
    status === 'IN_PROGRESS' &&
    userProgress !== null &&
    userProgress.recalculation_count > 0;

  // Shared stopPropagation guard — prevents canvas onNodeClick from firing
  // when the user interacts with buttons inside the node card.
  function stopAndCheck(e: React.MouseEvent): boolean {
    e.stopPropagation();
    return isPending || !goalSlug; // true = caller should abort
  }

  function handleComplete(e: React.MouseEvent) {
    if (stopAndCheck(e)) return;
    startTransition(async () => {
      try {
        await completeNode(id, goalSlug!);
      } catch (err) {
        console.error(`[TechTreeNode] completeNode failed: ${err instanceof Error ? err.message : err}`);
      }
    });
  }

  function handleStall(e: React.MouseEvent) {
    if (stopAndCheck(e)) return;
    startTransition(async () => {
      try {
        await stallNode(id, goalSlug!);
      } catch (err) {
        console.error(`[TechTreeNode] stallNode failed: ${err instanceof Error ? err.message : err}`);
      }
    });
  }

  return (
    <>
      <Handle type="target" position={Position.Top} className="!bg-slate-600 !border-slate-500 !w-2 !h-2" />

      <div className={`w-60 rounded-lg p-4 space-y-3 ${config.wrapperClass}`} style={{ width: 240 }}>

        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <h3 className={`text-sm font-semibold leading-snug ${config.titleClass}`}>
            {label}
          </h3>
          {status === 'LOCKED' && <LockIcon />}
        </div>

        {/* Lesson context */}
        <p className={`text-xs leading-relaxed line-clamp-2 ${config.bodyClass}`}>
          {lessonContext}
        </p>

        {/* Footer — time pill + status badges */}
        <div className="flex items-center justify-between gap-2 pt-1">
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-mono ${config.pillClass}`}>
            {estimatedMinutes}m
          </span>
          {status === 'COMPLETED' && <CompletedBadge />}
          {isStalled && <StalledBadge count={userProgress!.recalculation_count} />}
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* Action buttons — only rendered when IN_PROGRESS                  */}
        {/* Flex column keeps both within the fixed 240px card width.        */}
        {/* ---------------------------------------------------------------- */}
        {status === 'IN_PROGRESS' && (
          <div className="flex flex-col gap-1.5 pt-1">

            {/* Primary — Mark Complete */}
            <button
              onClick={handleComplete}
              disabled={isPending}
              className="
                w-full rounded px-3 py-1.5
                bg-emerald-900 hover:bg-emerald-800
                border border-emerald-700/60 hover:border-emerald-600
                text-[10px] font-mono font-medium uppercase tracking-widest
                text-emerald-400 hover:text-emerald-300
                disabled:opacity-50 disabled:cursor-not-allowed
                transition-all duration-150
              "
            >
              {isPending ? '···' : 'Mark Complete'}
            </button>

            {/* Secondary — I'm Stuck / Recalculating indicator */}
            {isStalled ? (
              // Already stalled — show a static disabled indicator instead of
              // letting them stack infinite stalls in one session. The badge
              // above already communicates recalculation_count to the user.
              <div className="
                w-full rounded px-3 py-1.5 text-center
                bg-slate-900 border border-slate-800
                text-[10px] font-mono text-slate-600
                cursor-not-allowed select-none
              ">
                Recalculating...
              </div>
            ) : (
              <button
                onClick={handleStall}
                disabled={isPending}
                className="
                  w-full rounded px-3 py-1.5
                  bg-slate-800 hover:bg-slate-700/80
                  border border-slate-700 hover:border-amber-500/50
                  text-[10px] font-mono font-medium
                  text-slate-400 hover:text-amber-400
                  disabled:opacity-50 disabled:cursor-not-allowed
                  transition-all duration-150
                "
              >
                {isPending ? '···' : "I'm Stuck — Break it Down"}
              </button>
            )}

          </div>
        )}

      </div>

      <Handle type="source" position={Position.Bottom} className="!bg-slate-600 !border-slate-500 !w-2 !h-2" />
    </>
  );
}

// ---------------------------------------------------------------------------
// Memo
// recalculation_count is included — it changes when stallNode fires and
// must trigger a re-render to swap the button to "Recalculating...".
// goalSlug is stable per page load — excluded.
// isPending is local state — not a prop — excluded.
// ---------------------------------------------------------------------------
export default memo(TechTreeNode, (prev: NodeProps<TechTreeNodeType>, next: NodeProps<TechTreeNodeType>) => {
  return (
    prev.data.status === next.data.status &&
    prev.data.label === next.data.label &&
    prev.data.lessonContext === next.data.lessonContext &&
    prev.data.estimatedMinutes === next.data.estimatedMinutes &&
    prev.data.userProgress?.recalculation_count ===
      next.data.userProgress?.recalculation_count
  );
});