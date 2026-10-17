"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { toApiError } from "@/lib/api/errors";
import { fetchMe, stepUp as stepUpRequest } from "@/lib/api/endpoints";
import type { Me } from "@/lib/api/types";
import { refreshAccessToken } from "./refresh-client";
import { sessionStore } from "./session-store";

type AuthStatus = "booting" | "anon" | "authed";

export type SignInResult = { mfaRequired: true; mfaToken: string } | { mfaRequired: false };

interface AuthContextValue {
  status: AuthStatus;
  me: Me | null;
  studentId: string | null;
  signIn(email: string, password: string): Promise<SignInResult>;
  submitMfa(mfaToken: string, code: string): Promise<void>;
  signOut(): Promise<void>;
  logoutAll(): Promise<void>;
  stepUp(code: string): Promise<void>;
  refreshMe(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function applyTokens(data: unknown): void {
  const token = (data as { accessToken?: unknown } | null)?.accessToken;
  if (typeof token !== "string" || token.length === 0) {
    throw toApiError(data, 500);
  }
  sessionStore.set(token);
}

async function postSession(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw toApiError(data, response.status);
  return data;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("booting");
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const tokens = await refreshAccessToken();
      if (cancelled) return;
      if (!tokens) {
        setStatus("anon");
        return;
      }
      try {
        const profile = await fetchMe();
        if (cancelled) return;
        setMe(profile);
        setStatus("authed");
      } catch {
        if (!cancelled) setStatus("anon");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () =>
      sessionStore.subscribe(() => {
        if (sessionStore.get() === null) {
          setMe(null);
          setStatus((current) => (current === "authed" ? "anon" : current));
        }
      }),
    [],
  );

  const signIn = useCallback(async (email: string, password: string): Promise<SignInResult> => {
    const data = await postSession("/session/login", { email, password });
    if (data && typeof data === "object" && (data as { mfaRequired?: unknown }).mfaRequired === true) {
      return { mfaRequired: true, mfaToken: String((data as { mfaToken?: unknown }).mfaToken ?? "") };
    }
    applyTokens(data);
    const profile = await fetchMe();
    setMe(profile);
    setStatus("authed");
    return { mfaRequired: false };
  }, []);

  const submitMfa = useCallback(async (mfaToken: string, code: string) => {
    const data = await postSession("/session/mfa", { mfaToken, code });
    applyTokens(data);
    const profile = await fetchMe();
    setMe(profile);
    setStatus("authed");
  }, []);

  const signOut = useCallback(async () => {
    await fetch("/session/logout", { method: "POST", cache: "no-store" }).catch(() => undefined);
    sessionStore.set(null);
    setMe(null);
    setStatus("anon");
  }, []);

  const refreshMe = useCallback(async () => {
    const profile = await fetchMe();
    setMe(profile);
  }, []);

  const stepUp = useCallback(async (code: string) => {
    const data = await stepUpRequest(code);
    applyTokens(data);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      me,
      studentId: me?.id ?? null,
      signIn,
      submitMfa,
      signOut,
      logoutAll: async () => {
        const { logoutAll: logoutAllRequest } = await import("@/lib/api/endpoints");
        await logoutAllRequest();
        await signOut();
      },
      stepUp,
      refreshMe,
    }),
    [status, me, signIn, submitMfa, signOut, stepUp, refreshMe],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider.");
  return context;
}
