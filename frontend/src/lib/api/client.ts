import createClient, { type Middleware } from "openapi-fetch";
import type { paths } from "./schema";
import { toApiError } from "./errors";
import { refreshAccessToken } from "@/lib/auth/refresh-client";
import { sessionStore } from "@/lib/auth/session-store";

const RETRY_CLONE = Symbol("sp-retry-clone");

type RetryCarrier = Request & { [RETRY_CLONE]?: Request };

export const api = createClient<paths>({ baseUrl: "" });

const authMiddleware: Middleware = {
  async onRequest({ request }) {
    const token = sessionStore.get();
    if (token) request.headers.set("Authorization", `Bearer ${token}`);
    (request as RetryCarrier)[RETRY_CLONE] = request.clone();
    return request;
  },

  async onResponse({ request, response }) {
    if (response.status !== 401) return response;

    const carrier = request as RetryCarrier;
    const retryClone = carrier[RETRY_CLONE];
    if (!retryClone) return response;

    const hadToken = request.headers.get("Authorization") !== null;
    if (!hadToken) return response;

    const refreshed = await refreshAccessToken();
    if (!refreshed) return response;

    retryClone.headers.set("Authorization", `Bearer ${refreshed.accessToken}`);
    return fetch(retryClone);
  },
};

api.use(authMiddleware);

export interface FetchResult<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

export async function apiFetch<T>(result: Promise<FetchResult<T>>): Promise<T> {
  const { data, error, response } = await result;
  if (!response.ok || error !== undefined) throw toApiError(error, response.status);
  return data as T;
}
