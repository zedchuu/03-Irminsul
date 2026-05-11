// =============================================================================
// src/utils/supabase/server.ts
// Supabase SSR client for use in Server Components, Server Actions,
// and Route Handlers (any server-side context with access to cookies).
//
// Next.js 15+ / 16 compliance:
//   `cookies()` from 'next/headers' is now async and returns a Promise.
//   It MUST be awaited before calling any method on the cookie store.
//   Calling cookieStore.getAll() on an unawaited Promise yields `undefined`,
//   which is the root cause of: "Cannot read properties of undefined (reading 'getAll')"
//
// Cookie method requirements (@supabase/ssr):
//   ✅ Use ONLY `getAll` and `setAll`
//   ❌ NEVER use `get`, `set`, or `remove` — these are the deprecated pattern
//      from @supabase/auth-helpers-nextjs and will break the application.
// =============================================================================

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { Database } from '@/types/database.types';

export async function createClient() {
  // `cookies()` is async in Next.js 15+. Awaiting it gives us the resolved
  // ReadonlyRequestCookies store, which exposes getAll() and set().
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // `setAll` was called from a Server Component, which cannot write
            // cookies. This is safe to ignore as long as proxy.ts is refreshing
            // the session on every request — which it is.
          }
        },
      },
    },
  );
}