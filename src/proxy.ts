// =============================================================================
// src/proxy.ts
// Migrated from: src/middleware.ts
// Next.js 16: the `middleware` file convention is deprecated.
// File renamed to `proxy.ts`; named export renamed from `middleware` to `proxy`.
//
// ⚠️  RUNTIME WARNING — READ BEFORE DEPLOYING:
//     Next.js 16 proxy runs on the Node.js runtime ONLY.
//     The Edge Runtime is NOT supported in proxy.ts and cannot be configured.
//     Ref: https://nextjs.org/docs/app/guides/upgrading/version-16
//
//     Supabase SSR auth (supabase.auth.getUser()) is Node.js-compatible and
//     works correctly here. However, if your team ever adds Edge-only APIs
//     (e.g., `EdgeRuntime`, Cloudflare bindings, or `export const runtime =
//     'edge'` in this file), those will silently fail.
//
//     If you need Edge Runtime session handling in the future, you must keep
//     a separate `middleware.ts` for that path. Do not delete middleware.ts
//     until you have confirmed no edge-specific logic is required.
// =============================================================================

import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import type { Database } from '@/types/database.types';

export async function proxy(request: NextRequest) {
  // We must create a response object to pass to the Supabase client so it can
  // write the refreshed session cookie back to the browser.
  let supabaseResponse = NextResponse.next({
    request,
  });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          // Write cookies to the outgoing request (for downstream Server
          // Components) and to the response (for the browser).
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // IMPORTANT: Do not add any logic between createServerClient and
  // supabase.auth.getUser(). Any code here could invalidate the session.
  //
  // getUser() makes a network request to Supabase to revalidate the Auth token.
  // Do not use getSession() here — it reads from the cookie without validation
  // and can be spoofed by client-side code.
  await supabase.auth.getUser();

  // Return the response with the refreshed session cookie attached.
  return supabaseResponse;
}

// ---------------------------------------------------------------------------
// Route matcher
// Excludes static assets and Next.js internals from proxy execution.
// `skipProxyUrlNormalize` replaces the deprecated `skipMiddlewareUrlNormalize`
// in Next.js 16 if you need that config flag.
// ---------------------------------------------------------------------------
export const config = {
  matcher: [
    /*
     * Match all request paths EXCEPT:
     *   - _next/static  (static files)
     *   - _next/image   (image optimization)
     *   - favicon.ico   (browser favicon)
     *   - Files with an extension (e.g. .svg, .png, .js, .css)
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|woff2?)$).*)',
  ],
};