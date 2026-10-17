import { NextResponse } from "next/server";

export const API_ORIGIN = process.env.API_ORIGIN ?? "http://localhost:3000";
export const REFRESH_COOKIE = "sp_rt";
export const COOKIE_PATH = "/session";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

export interface TokenPair {
  tokenType: string;
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

export function isTokenPair(value: unknown): value is TokenPair {
  if (!value || typeof value !== "object") return false;
  const candidate = value as TokenPair;
  return typeof candidate.accessToken === "string" && typeof candidate.refreshToken === "string";
}

export function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: COOKIE_PATH,
    maxAge: COOKIE_MAX_AGE,
  };
}

export function problem(status: number, code: string, detail: string) {
  return NextResponse.json(
    { type: "about:blank", title: code, status, detail, code, errors: [] },
    { status },
  );
}

export interface UpstreamResult {
  ok: boolean;
  status: number;
  data: unknown;
}

export async function upstreamJson(path: string, body: unknown): Promise<UpstreamResult> {
  try {
    const response = await fetch(`${API_ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const data = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, data };
  } catch {
    return { ok: false, status: 502, data: null };
  }
}
