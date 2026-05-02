import { createServerClient } from "@supabase/ssr";
import createIntlMiddleware from "next-intl/middleware";
import { type NextRequest, NextResponse } from "next/server";
import { routing } from "@/i18n/routing";

const intlMiddleware = createIntlMiddleware(routing);

// Strip locale prefix before checking route protection
function isProtected(pathname: string): boolean {
  const stripped = pathname.replace(/^\/(en|es)(\/|$)/, "/");
  return (
    stripped === "/devices" ||
    stripped.startsWith("/devices/") ||
    stripped === "/profile" ||
    stripped.startsWith("/profile/")
  );
}

// Routes that must not be processed by next-intl: locale-agnostic handlers
// that live outside app/[locale]/ in the App Router tree. If intlMiddleware
// runs on these, it rewrites them into the [locale] subtree where they don't
// exist and Next.js returns 404.
const INTL_SKIP_PREFIXES = ["/auth/", "/pair", "/api/"];

export default async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  // Skip next-intl for locale-agnostic routes; those route handlers manage
  // their own auth (e.g. /auth/callback runs exchangeCodeForSession itself).
  const skipIntl = INTL_SKIP_PREFIXES.some((p) => pathname.startsWith(p));
  if (skipIntl) {
    return NextResponse.next();
  }

  // Run next-intl first to handle locale redirects and set locale headers
  const response = intlMiddleware(request);

  // Create Supabase client that reads session from request and writes refresh
  // cookies into the intl response — same response the browser will receive.
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          // Write refreshed session cookies onto the outgoing response
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && isProtected(pathname)) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", search ? `${pathname}${search}` : pathname);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  // Exclude Next.js internals, static files, AND locale-agnostic auth routes
  // from the middleware. The auth/callback route handler runs exchangeCodeForSession
  // itself and must not be intercepted by intlMiddleware.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|auth/|pair|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
