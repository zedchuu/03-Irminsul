// =============================================================================
// src/app/tree/[slug]/page.tsx
// Irminsul — Phase 4.3: Live Auth & Interactivity
//
// Changes from Phase 4.2:
//   - MOCK_USER_ID removed. Real session resolved via supabase.auth.getUser().
//   - Unauthenticated users are redirected to /login immediately.
//   - `slug` is now passed to <TechTreeCanvas> so the canvas can pass it to
//     the startNode Server Action for targeted revalidation.
//   - Auth dev badge replaced with real user email indicator.
//
// ⚠️  Scaffold note (remove in Phase 4.3 when graphService is wired):
//   getScaffoldGraph() regenerates random UUIDs on every render. Because
//   revalidatePath() triggers a fresh render, clicking a node will assign new
//   UUIDs to scaffold nodes — the upserted progress row won't match the new
//   IDs, so the IN_PROGRESS state won't display. This is a scaffold limitation
//   only. Once generateGraphData() is wired, real DB node IDs are stable across
//   renders and the full click → revalidate → hydrate loop works correctly.
// =============================================================================

import { redirect, notFound } from 'next/navigation';
import { createClient } from '@/utils/supabase/server';
import type { GoalSummary } from '@/types/database.types';
import {
  getUserProgressForNodes,
  hydrateGraphWithProgress,
} from '@/services/progressService';
import TechTreeCanvas from '@/components/TechTree/TechTreeCanvas';
import { generateGraphData } from '@/services/graphService';

// ---------------------------------------------------------------------------
// Page props
// ---------------------------------------------------------------------------

interface PageProps {
  params: Promise<{ slug: string }>;
}

// ---------------------------------------------------------------------------
// Page — RSC
// ---------------------------------------------------------------------------

export default async function TechTreePage({ params }: PageProps) {
  // ── Step 1: Resolve slug ──────────────────────────────────────────────────
  const { slug } = await params;

  // ── Step 2: Auth — resolve real session ───────────────────────────────────
  // createClient() is called once and reused for both auth and the goal query.
  // getUser() validates the JWT server-side — cannot be spoofed by the client.
  // getSession() reads from the cookie without validation — never use it here.
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    // Pass the intended destination so login can redirect back here after auth.
    redirect(`/login?next=/tree/${slug}`);
  }

  const userId = user.id;

  // ── Step 3: Fetch goal metadata ───────────────────────────────────────────
  const { data: goal, error: goalError } = await supabase
    .from('goals')
    .select('id, title, slug, description, last_verified_at, access_count, created_at, updated_at')
    .eq('slug', slug)
    .maybeSingle() as { data: GoalSummary | null; error: { message: string } | null };

  if (goalError) {
    console.error(
      `[Irminsul/TechTreePage] Goal fetch failed for slug '${slug}': ${goalError.message}`,
    );
    throw new Error('Failed to load goal data.');
  }

  if (!goal) {
    notFound();
  }

  // ── Step 4: Generate layout graph ────────────────────────────────────────
  // TODO Phase 4.3: replace scaffold with the real graphService call:
  //   
  const { nodes, edges } = await generateGraphData(goal.id);

  // ── Step 5: Fetch user progress ───────────────────────────────────────────
  const nodeIds = nodes.map((n) => n.id);
  const userProgress = await getUserProgressForNodes(userId, nodeIds);

  // ── Step 6: Hydrate graph ─────────────────────────────────────────────────
  const hydratedNodes = hydrateGraphWithProgress(nodes, edges, userProgress);

  // ── Step 7: Render ────────────────────────────────────────────────────────
  return (
    <main className="h-screen bg-gray-950 text-gray-100 flex flex-col overflow-hidden">

      {/* ------------------------------------------------------------------ */}
      {/* Page header                                                         */}
      {/* ------------------------------------------------------------------ */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-gray-800 flex-shrink-0">
        <div>
          <p className="text-xs font-mono text-gray-600 uppercase tracking-widest mb-0.5">
            Tech Tree
          </p>
          <h1 className="text-lg font-semibold text-white leading-tight">
            {goal.title}
          </h1>
        </div>

        {/* Real user identity — confirms live auth is active */}
        <span className="rounded-full bg-slate-800 border border-slate-700 px-3 py-1 text-xs font-mono text-slate-400 max-w-[200px] truncate">
          {user.email}
        </span>
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* Tech Tree Canvas                                                    */}
      {/* slug passed through so TechTreeCanvas can target revalidatePath.   */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex-1 min-h-0 relative">
        <TechTreeCanvas
          initialNodes={hydratedNodes}
          initialEdges={edges}
          goalSlug={slug}
        />
      </div>

    </main>
  );
}

// ---------------------------------------------------------------------------
// Scaffold graph — remove when graphService is wired (see Step 4 above)
// ---------------------------------------------------------------------------

import type { RFNode, RFEdge, TechTreeNodeData } from '@/services/graphService';