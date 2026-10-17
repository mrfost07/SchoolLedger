import { NextResponse, type NextRequest } from "next/server";
import { cookieOptions, isTokenPair, problem, REFRESH_COOKIE, upstreamJson } from "../shared";

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    email?: unknown;
    password?: unknown;
  } | null;

  if (!body || typeof body.email !== "string" || typeof body.password !== "string") {
    return problem(400, "VALIDATION_FAILED", "Send email and password.");
  }

  const { ok, status, data } = await upstreamJson("/api/v1/auth/login", {
    email: body.email,
    password: body.password,
  });

  if (!ok) {
    return NextResponse.json(data ?? { status, code: "INTERNAL_ERROR", detail: "Sign in failed." }, { status });
  }

  if (isTokenPair(data)) {
    const out = NextResponse.json({
      tokenType: data.tokenType,
      accessToken: data.accessToken,
      expiresInSeconds: data.expiresInSeconds,
    });
    out.cookies.set(REFRESH_COOKIE, data.refreshToken, cookieOptions());
    return out;
  }

  return NextResponse.json(data);
}
