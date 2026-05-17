'use client';

// =============================================================================
// src/app/login/page.tsx
// Irminsul — Authentication Gate
//
// useSearchParams() requires a Suspense boundary in Next.js App Router.
// The page exports a thin wrapper (LoginPage) that provides the boundary,
// and the real form logic lives in LoginForm.
//
// After successful login, redirects to the `next` query parameter if present
// and relative (e.g. /login?next=/tree/learn-python), otherwise falls back
// to '/' (the goal picker).
// =============================================================================

import { useState, useTransition, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/utils/supabase/client';

// ---------------------------------------------------------------------------
// Scanline grid — decorative background texture
// ---------------------------------------------------------------------------
function ScanlineGrid() {
  return (
    <svg
      className="absolute inset-0 w-full h-full opacity-[0.03] pointer-events-none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M 20 0 L 0 0 0 20" fill="none" stroke="white" strokeWidth="0.5" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#grid)" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// LoginForm — inner component that uses useSearchParams
// ---------------------------------------------------------------------------
function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Read `next` from the URL — e.g. /login?next=/tree/learn-python
  // Validate it is a relative path to prevent open redirect.
  const rawNext = searchParams.get('next') ?? '/';
  const next = rawNext.startsWith('/') ? rawNext : '/';

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const formData = new FormData(event.currentTarget);
    const email = formData.get('email') as string;
    const password = formData.get('password') as string;

    if (!email?.trim() || !password?.trim()) {
      setError('Email and password are required.');
      return;
    }

    startTransition(async () => {
      const supabase = createClient();

      const { error: authError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (authError) {
        setError(authError.message);
        return;
      }

      // Session cookie is now set. Redirect to intended destination.
      router.push(next);
      router.refresh(); // flush RSC cache so new session is picked up
    });
  }

  return (
    <main className="relative min-h-screen bg-[#080b10] flex items-center justify-center overflow-hidden">

      <ScanlineGrid />

      {/* Ambient glow */}
      <div
        className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[300px] pointer-events-none"
        style={{
          background: 'radial-gradient(ellipse at center top, rgba(52,211,153,0.06) 0%, transparent 70%)',
        }}
      />

      <div className="relative z-10 w-full max-w-sm px-4">

        {/* Header */}
        <div className="mb-8 text-center">
          <div className="inline-flex items-center gap-2 mb-6">
            <svg
              viewBox="0 0 24 24"
              className="w-6 h-6 text-emerald-500"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 22V12M12 12L7 7M12 12L17 7M12 7V2M8 17l-3 3M16 17l3 3" />
            </svg>
            <span className="font-mono text-sm font-semibold tracking-[0.2em] text-slate-300 uppercase">
              Irminsul
            </span>
          </div>
          <h1 className="text-xl font-semibold text-white tracking-tight">
            Access your Tech Tree
          </h1>
          <p className="mt-1.5 text-xs font-mono text-slate-600">
            Authenticate to continue your learning path
          </p>
        </div>

        {/* Card */}
        <div className="bg-[#0d1117] border border-slate-800 rounded-lg p-6 shadow-[0_0_40px_rgba(0,0,0,0.4)]">
          <form onSubmit={handleSubmit} noValidate className="space-y-4">

            {/* Email */}
            <div className="space-y-1.5">
              <label
                htmlFor="email"
                className="block text-[10px] font-mono font-medium text-slate-500 uppercase tracking-widest"
              >
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                autoFocus
                required
                disabled={isPending}
                placeholder="you@example.com"
                className="
                  w-full rounded-md bg-[#080b10] border border-slate-800
                  px-3 py-2.5 text-sm font-mono text-slate-200 placeholder-slate-700
                  focus:outline-none focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700/50
                  disabled:opacity-50 disabled:cursor-not-allowed
                  transition-colors duration-150
                "
              />
            </div>

            {/* Password */}
            <div className="space-y-1.5">
              <label
                htmlFor="password"
                className="block text-[10px] font-mono font-medium text-slate-500 uppercase tracking-widest"
              >
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                disabled={isPending}
                placeholder="••••••••"
                className="
                  w-full rounded-md bg-[#080b10] border border-slate-800
                  px-3 py-2.5 text-sm font-mono text-slate-200 placeholder-slate-700
                  focus:outline-none focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700/50
                  disabled:opacity-50 disabled:cursor-not-allowed
                  transition-colors duration-150
                "
              />
            </div>

            {/* Error */}
            {error && (
              <div className="flex items-start gap-2 rounded-md bg-red-950/40 border border-red-900/50 px-3 py-2.5">
                <svg
                  className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z"
                    clipRule="evenodd"
                  />
                </svg>
                <p className="text-xs font-mono text-red-400 leading-relaxed">{error}</p>
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={isPending}
              className="
                w-full rounded-md px-4 py-2.5
                bg-emerald-900/40 hover:bg-emerald-900/70
                border border-emerald-800/60 hover:border-emerald-700
                text-sm font-mono font-medium text-emerald-400 hover:text-emerald-300
                focus:outline-none focus:ring-2 focus:ring-emerald-700/50
                disabled:opacity-50 disabled:cursor-not-allowed
                transition-all duration-150
                flex items-center justify-center gap-2
              "
            >
              {isPending ? (
                <>
                  <svg className="w-3.5 h-3.5 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Authenticating...
                </>
              ) : (
                <>
                  Authenticate
                  <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <path fillRule="evenodd" d="M3 10a.75.75 0 01.75-.75h10.638L10.23 5.29a.75.75 0 111.04-1.08l5.5 5.25a.75.75 0 010 1.08l-5.5 5.25a.75.75 0 11-1.04-1.08l4.158-3.96H3.75A.75.75 0 013 10z" clipRule="evenodd" />
                  </svg>
                </>
              )}
            </button>

          </form>
        </div>

        <p className="mt-6 text-center text-[10px] font-mono text-slate-700">
          No account? Contact your administrator.
        </p>

      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// LoginPage — Suspense boundary required by useSearchParams in App Router
// ---------------------------------------------------------------------------
export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}