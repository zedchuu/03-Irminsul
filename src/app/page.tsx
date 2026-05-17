// =============================================================================
// src/app/page.tsx
// Irminsul — Root entry point / Goal picker
//
// Unauthenticated → /login
// Authenticated + no topic → goal input form
// Authenticated + topic submitted → runs getOrGenerateGoal() (tiered retrieval)
//                                   then redirects to /tree/[canonical-slug]
//
// Running getOrGenerateGoal() here before redirecting is critical:
//   - It ensures the slug we redirect to actually exists in the DB.
//   - It triggers Tier 2 LLM generation if the goal is new.
//   - It returns the canonical slug (not a naive client-side slugification)
//     so the tree page always finds the goal via Tier 1a exact match.
// =============================================================================

import { redirect } from 'next/navigation';
import { createClient } from '@/utils/supabase/server';
import { getOrGenerateGoal } from '@/services/goalService';

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function RootPage({ searchParams }: PageProps) {
  // ── Auth guard ────────────────────────────────────────────────────────────
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // ── Topic submission — run tiered retrieval then redirect ─────────────────
  const resolvedParams = await searchParams;
  const rawTopic = resolvedParams['topic'];
  const topic = typeof rawTopic === 'string' ? rawTopic.trim() : undefined;

  if (topic) {
    // getOrGenerateGoal runs the full Tier 1a → 1b → 2 → 3 waterfall.
    // It always returns a GoalResult with a valid slug — either from the DB
    // or freshly written to it by Tier 3. We redirect to that canonical slug.
    const result = await getOrGenerateGoal(topic);
    redirect(`/tree/${result.goal.slug}`);
  }

  // ── Render goal picker ────────────────────────────────────────────────────
  return (
    <main className="min-h-screen bg-[#080b10] text-gray-100 flex flex-col items-center justify-center px-4">

      <div className="w-full max-w-md text-center mb-10">
        <p className="text-xs font-mono text-slate-600 uppercase tracking-widest mb-3">
          Irminsul
        </p>
        <h1 className="text-2xl font-semibold text-white tracking-tight">
          What do you want to learn?
        </h1>
        <p className="mt-2 text-sm text-slate-500">
          Enter a topic to generate or retrieve your Tech Tree.
        </p>
      </div>

      {/* Native GET form — triggers a server re-render with ?topic= */}
      <form method="GET" className="w-full max-w-md flex gap-2">
        <input
          type="text"
          name="topic"
          placeholder="e.g. Learn Python, SQL, Next.js..."
          autoComplete="off"
          className="
            flex-1 rounded-md bg-[#0d1117] border border-slate-800
            px-4 py-2.5 text-sm font-mono text-slate-200 placeholder-slate-700
            focus:outline-none focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700/50
            transition-colors duration-150
          "
        />
        <button
          type="submit"
          className="
            rounded-md px-4 py-2.5
            bg-emerald-900/40 hover:bg-emerald-900/70
            border border-emerald-800/60 hover:border-emerald-700
            text-sm font-mono text-emerald-400 hover:text-emerald-300
            transition-all duration-150
          "
        >
          Go
        </button>
      </form>

      <p className="mt-8 text-[10px] font-mono text-slate-700">
        {user.email}
      </p>

    </main>
  );
}