// =============================================================================
// src/app/auth/callback/route.ts
// Irminsul — Supabase Auth Callback Handler
//
// Required by @supabase/ssr for OAuth and Magic Link flows.
// Not used by email+password login (Phase 4.3) — included for completeness
// and future OAuth expansion (Phase 5+).
//
// How it works:
//   When Supabase redirects back to the app after an OAuth or Magic Link flow,
//   it appends a `code` query parameter to this route's URL. This handler:
//     1. Exchanges the `code` for a session via exchangeCodeForSession().
//     2. Supabase SSR sets the session cookie on the response.
//     3. Redirects the user to their intended destination (or / as fallback).
//
// The `next` query parameter allows the originating page to specify where the
// user should land after auth. Example:
//   /auth/callback?code=xxx&next=/tree/learn-python
//
// Security:
//   `next` is validated to be a relative path only — no open redirect to
//   external URLs. Any value that doesn't start with '/' defaults to '/'.
// =============================================================================

import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { Database } from '@/types/database.types';

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);

  const code = searchParams.get('code');

  // Validate `next` — must be a relative path to prevent open redirect.
  const rawNext = searchParams.get('next') ?? '/';
  const next = rawNext.startsWith('/') ? rawNext : '/';

  if (!code) {
    // No code present — this route was hit directly or the OAuth flow was
    // cancelled. Redirect to login with an error indicator.
    console.error('[Irminsul/auth/callback] No code in callback URL.');
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  // ---------------------------------------------------------------------------
  // Exchange the code for a session
  // ---------------------------------------------------------------------------
  // We construct the server client inline here rather than using createClient()
  // from @/utils/supabase/server because Route Handlers receive the raw
  // NextRequest object — we need to thread cookies from the request into the
  // response manually so @supabase/ssr can set them correctly.
  // ---------------------------------------------------------------------------
  const cookieStore = await cookies();

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        },
      },
    },
  );

  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error(`[Irminsul/auth/callback] exchangeCodeForSession failed: ${error.message}`);
    return NextResponse.redirect(`${origin}/login?error=auth_failed`);
  }

  // Session is now set. Redirect to the intended destination.
  return NextResponse.redirect(`${origin}${next}`);
}