import { NextResponse, type NextRequest } from "next/server";
import { createKeyedSingleFlight } from "@/lib/auth/refresh-mutex";
import { COOKIE_PATH, cookieOptions, isTokenPair, problem, REFRESH_COOKIE, upstreamJson, type UpstreamResult } from "../shared";

const runKeyed = createKeyedSingleFlight<string, UpstreamResult>();

export async function POST(request: NextRequest) {
  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;
  if (!refreshToken) return problem(401, "UNAUTHENTICATED", "No session.");

  const outcome = await runKeyed(refreshToken, () =>
    upstreamJson("/api/v1/auth/refresh", { refreshToken }),
  );

  if (!outcome.ok || !isTokenPair(outcome.data)) {
    const out = NextResponse.json(
      outcome.data ?? { status: outcome.status, code: "INTERNAL_ERROR", detail: "Refresh failed." },
      { status: outcome.status || 502 },
    );
    out.cookies.delete({ name: REFRESH_COOKIE, path: COOKIE_PATH });
    return out;
  }

  const out = NextResponse.json({
    tokenType: outcome.data.tokenType,
    accessToken: outcome.data.accessToken,
    expiresInSeconds: outcome.data.expiresInSeconds,
  });
  out.cookies.set(REFRESH_COOKIE, outcome.data.refreshToken, cookieOptions());
  return out;
}
