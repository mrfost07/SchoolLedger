import { createSingleFlight } from "./refresh-mutex";
import { sessionStore } from "./session-store";

export interface RefreshedTokens {
  tokenType: string;
  accessToken: string;
  expiresInSeconds: number;
}

declare global {
  var __spRefreshSingleFlight: ReturnType<typeof createSingleFlight<RefreshedTokens | null>> | undefined;
}

const single = (globalThis.__spRefreshSingleFlight ??= createSingleFlight<RefreshedTokens | null>());

export function refreshAccessToken(): Promise<RefreshedTokens | null> {
  return single(fetchRefresh);
}

async function fetchRefresh(): Promise<RefreshedTokens | null> {
  let response: Response;
  try {
    response = await fetch("/session/refresh", { method: "POST", cache: "no-store" });
  } catch {
    return null;
  }

  if (!response.ok) {
    sessionStore.set(null);
    return null;
  }

  const data = (await response.json().catch(() => null)) as RefreshedTokens | null;
  if (!data || typeof data.accessToken !== "string") {
    sessionStore.set(null);
    return null;
  }

  sessionStore.set(data.accessToken);
  return data;
}
