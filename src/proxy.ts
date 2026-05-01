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

export default async function proxy(request: NextRequest) {
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

  const { pathname, search } = request.nextUrl;
  if (!user && isProtected(pathname)) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", search ? `${pathname}${search}` : pathname);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  // Run on all routes except Next.js internals and static files
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
