import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_PATH, REFRESH_COOKIE, upstreamJson } from "../shared";

export async function POST(request: NextRequest) {
  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;

  if (refreshToken) {
    await upstreamJson("/api/v1/auth/logout", { refreshToken });
  }

  const out = new NextResponse(null, { status: 204 });
  out.cookies.delete({ name: REFRESH_COOKIE, path: COOKIE_PATH });
  return out;
}
