import { NextResponse, type NextRequest } from "next/server";
import { cookieOptions, isTokenPair, problem, REFRESH_COOKIE, upstreamJson } from "../shared";

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    mfaToken?: unknown;
    code?: unknown;
  } | null;

  if (!body || typeof body.mfaToken !== "string" || typeof body.code !== "string") {
    return problem(400, "VALIDATION_FAILED", "Send the MFA token and code.");
  }

  const { ok, status, data } = await upstreamJson("/api/v1/auth/mfa/verify", {
    mfaToken: body.mfaToken,
    code: body.code,
  });

  if (!ok) {
    return NextResponse.json(data ?? { status, code: "INTERNAL_ERROR", detail: "Verification failed." }, { status });
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
