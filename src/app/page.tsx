// =============================================================================
// src/app/page.tsx
// Irminsul — Phase 2.2 Integration Harness
//
// Next.js 16 compliance:
//   `searchParams` is now a Promise and must be awaited before property access.
//   Ref: https://nextjs.org/docs/app/api-reference/file-conventions/page
//
// Pattern: Pure React Server Component. No 'use client', no useState, no
//          onClick. The HTML <form method="GET"> submits natively, updating
//          the URL's ?topic= param and triggering a full server re-render.
// =============================================================================

import { getOrGenerateGoal, type GoalResultSource } from '@/services/goalService';

// ---------------------------------------------------------------------------
// Source badge config
// ---------------------------------------------------------------------------

interface BadgeConfig {
  label: string;
  className: string;
}

const SOURCE_BADGE: Record<GoalResultSource, BadgeConfig> = {
  db_retrieved: {
    label: '✓ DB Cache Hit — Tier 1',
    className: 'bg-green-900 text-green-300 border border-green-700',
  },
  db_semantic: {
    label: '🔍 DB Semantic — Tier 1',
    className: 'bg-cyan-900 text-cyan-300 border border-cyan-700',
  },
  llm_mock: {
    label: '⚙ Mock LLM — Tier 2 Stub',
    className: 'bg-yellow-900 text-yellow-300 border border-yellow-700',
  },
  llm_generated: {
    label: '✦ LLM Generated — Tier 2 Live',
    className: 'bg-blue-900 text-blue-300 border border-blue-700',
  },
  error_fallback: {
    label: '✕ Error Fallback',
    className: 'bg-red-900 text-red-300 border border-red-700',
  },
};

// ---------------------------------------------------------------------------
// Page — RSC
//
// Next.js 16: both `params` and `searchParams` are Promises.
// The type signature reflects this; we await before accessing any property.
// ---------------------------------------------------------------------------

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function Page({ searchParams }: PageProps) {
  // Await the Promise before any property access.
  // Accessing searchParams.topic without awaiting first causes the runtime
  // error: "searchParams is a Promise and must be unwrapped with await".
  const resolvedParams = await searchParams;

  // Normalize: values can be string | string[] | undefined.
  const rawTopic = resolvedParams['topic'];
  const topic = typeof rawTopic === 'string' ? rawTopic.trim() : undefined;

  // Only call the service when a non-empty topic is present in the URL.
  const result = topic ? await getOrGenerateGoal(topic) : null;

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 flex flex-col items-center justify-start px-4 py-16">

      {/* ------------------------------------------------------------------ */}
      {/* Header                                                              */}
      {/* ------------------------------------------------------------------ */}
      <div className="w-full max-w-xl mb-10 text-center">
        <h1 className="text-3xl font-bold tracking-tight text-white">Irminsul</h1>
        <p className="mt-2 text-sm text-gray-500">
          Phase 2.2 — Tiered Retrieval Engine Harness
        </p>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Search form                                                         */}
      {/* Native GET form — zero JS. Submits by updating ?topic= in the URL, */}
      {/* which triggers a full RSC re-render with the new searchParam.       */}
      {/* ------------------------------------------------------------------ */}
      <form
        method="GET"
        className="w-full max-w-xl flex gap-2"
      >
        <input
          type="text"
          name="topic"
          defaultValue={topic ?? ''}
          placeholder="e.g. Learn Python, Next.js, SQL..."
          autoComplete="off"
          className="
            flex-1 rounded-md bg-gray-800 border border-gray-700
            px-4 py-2 text-sm text-gray-100 placeholder-gray-500
            focus:outline-none focus:ring-2 focus:ring-indigo-500
          "
        />
        <button
          type="submit"
          className="
            rounded-md bg-indigo-600 hover:bg-indigo-500
            px-4 py-2 text-sm font-medium text-white
            transition-colors
          "
        >
          Search
        </button>
      </form>

      {/* ------------------------------------------------------------------ */}
      {/* Result panel                                                        */}
      {/* ------------------------------------------------------------------ */}
      <div className="w-full max-w-xl mt-8">

        {/* Empty state — no topic in URL yet */}
        {!topic && (
          <p className="text-center text-gray-500 text-sm">
            Enter a learning topic above to test the retrieval engine.
          </p>
        )}

        {/* Result card — rendered only when a topic was queried */}
        {result && (() => {
          const badge = SOURCE_BADGE[result.source];
          return (
            <div className="rounded-lg bg-gray-900 border border-gray-800 p-6 space-y-4">

              {/* Source badge */}
              <span
                className={`
                  inline-block rounded-full px-3 py-1 text-xs font-mono font-medium
                  ${badge.className}
                `}
              >
                {badge.label}
              </span>

              {/* Goal title */}
              <h2 className="text-xl font-semibold text-white">
                {result.goal.title}
              </h2>

              {/* Goal description */}
              <p className="text-sm text-gray-400 leading-relaxed">
                {result.goal.description ?? (
                  <span className="italic text-gray-600">No description available.</span>
                )}
              </p>

              {/* Debug metadata — remove in Phase 3 */}
              <div className="mt-4 pt-4 border-t border-gray-800 space-y-1">
                <p className="text-xs font-mono text-gray-600">
                  <span className="text-gray-500">id: </span>{result.goal.id}
                </p>
                <p className="text-xs font-mono text-gray-600">
                  <span className="text-gray-500">slug: </span>{result.goal.slug}
                </p>
                <p className="text-xs font-mono text-gray-600">
                  <span className="text-gray-500">access_count: </span>
                  {result.goal.access_count}
                </p>
                <p className="text-xs font-mono text-gray-600">
                  <span className="text-gray-500">last_verified_at: </span>
                  {result.goal.last_verified_at ?? 'null'}
                </p>
              </div>

            </div>
          );
        })()}

      </div>
    </main>
  );
}