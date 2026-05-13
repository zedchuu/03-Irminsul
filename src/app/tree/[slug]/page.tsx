// =============================================================================
// src/app/tree/[slug]/page.tsx
// Phase 3.4 — Tech Tree Server Component Route
//
// Route: /tree/[slug]  (e.g. /tree/learn-python)
// This is a pure async Server Component — no 'use client', no useState.
//
// Data flow:
//   URL slug
//     → getOrGenerateGoal(slug)   [four-tier waterfall in goalService.ts]
//     → generateGraphData(goal.id) [topological sort in graphService.ts]
//     → <TechTreeCanvas nodes edges /> [React Flow client component]
//
// notFound() triggers:
//   - error_fallback source (DB + LLM both failed)
//   - tier3-write-failed id (goal exists in memory but not in DB — no real id
//     to pass to generateGraphData, which would return an empty graph)
//
// Next.js 15+: params is a Promise and must be awaited before property access.
// =============================================================================

import { notFound } from "next/navigation";
import { getOrGenerateGoal } from "@/services/goalService";
import { generateGraphData } from "@/services/graphService";
import TechTreeCanvas from "@/components/TechTree/TechTreeCanvas";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PageProps {
  params: Promise<{ slug: string }>;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function TechTreePage({ params }: PageProps) {
  // Await params before property access — required in Next.js 15+.
  const { slug } = await params;

  // ── Step 1: Resolve goal via tiered waterfall ──────────────────────────
  // getOrGenerateGoal never throws — it catches all errors internally and
  // returns source: 'error_fallback' with a sentinel id. We treat both
  // error states as not-found from the user's perspective.
  const result = await getOrGenerateGoal(slug);

  if (
    result.source === "error_fallback" ||
    result.goal.id === "error-fallback" ||
    result.goal.id === "tier3-write-failed"
  ) {
    // error-fallback: both DB and LLM failed — nothing to render.
    // tier3-write-failed: goal was generated but never persisted — no real
    // UUID to pass to generateGraphData, which would return an empty graph.
    notFound();
  }

  const goal = result.goal;

  // ── Step 2: Generate graph data from persisted node + prerequisite rows ─
  // generateGraphData throws on Supabase failure or cycle detection.
  // We let that propagate to Next.js's error boundary (error.tsx) rather
  // than silently swallowing it — a broken graph is a data integrity issue
  // that should surface loudly, not render as an empty canvas.
  const { nodes, edges } = await generateGraphData(goal.id);

  // ── Step 3: Render ────────────────────────────────────────────────────
  return (
    <main className="min-h-screen bg-[#080b10] text-slate-100 p-6 flex flex-col gap-6">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header className="flex flex-col gap-2 max-w-3xl">

        {/* Eyebrow label */}
        <p className="font-mono text-[10px] tracking-[0.25em] uppercase text-amber-500/70">
          Tech Tree · {result.source.replace(/_/g, " ")}
        </p>

        {/* Goal title */}
        <h1 className="font-mono text-3xl font-bold uppercase tracking-tight text-amber-100 leading-none">
          {goal.title}
        </h1>

        {/* Goal description — milestone_graph descriptions replace this in
            Phase 4 once the milestone sidebar is built. For now we render
            the legacy description column if it exists. */}
        {goal.description && (
          <p className="text-sm text-slate-500 leading-relaxed max-w-xl mt-1">
            {goal.description}
          </p>
        )}

        {/* Graph metadata */}
        <p className="font-mono text-[10px] tracking-widest text-slate-700 uppercase mt-1">
          {nodes.length} node{nodes.length !== 1 ? "s" : ""}
          <span className="mx-2 text-slate-800">·</span>
          {edges.length} edge{edges.length !== 1 ? "s" : ""}
          <span className="mx-2 text-slate-800">·</span>
          slug: {goal.slug}
        </p>

      </header>

      {/* ── Canvas wrapper ──────────────────────────────────────────────── */}
      {/* Explicit height is REQUIRED — React Flow collapses to 0px if the  */}
      {/* container does not have a fixed or calculated height. h-[800px]   */}
      {/* is the Phase 3 default; Phase 4 can make this viewport-relative   */}
      {/* (e.g. h-[calc(100vh-160px)]) once the header height is stable.    */}
      <div className="w-full h-[800px] border border-slate-800 rounded-xl overflow-hidden shadow-2xl shadow-black/50">
        <TechTreeCanvas
          initialNodes={nodes}
          initialEdges={edges}
          goalTitle={goal.title}
        />
      </div>

      {/* ── Empty state (no nodes generated yet) ────────────────────────── */}
      {/* Shown when generateGraphData returns [] — goal exists in DB but   */}
      {/* node generation hasn't run yet (e.g. Tier 3 write partially       */}
      {/* failed between goal insert and node insert).                      */}
      {nodes.length === 0 && (
        <div className="flex flex-col items-center justify-center py-24 gap-3">
          <p className="font-mono text-xs text-slate-700 uppercase tracking-widest">
            Recalculating path...
          </p>
          <p className="text-sm text-slate-600">
            No nodes found for this goal. The curriculum may still be generating.
          </p>
        </div>
      )}

    </main>
  );
}