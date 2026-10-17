export interface IdempotencyStore {
  key: string | null;
}

export function createIdempotencyStore(): IdempotencyStore {
  return { key: null };
}

export function currentKey(store: IdempotencyStore): string {
  if (!store.key) {
    store.key =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `key-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  }
  return store.key;
}

export function resetKey(store: IdempotencyStore): void {
  store.key = null;
}
