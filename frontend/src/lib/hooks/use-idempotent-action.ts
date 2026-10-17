"use client";

import { useCallback, useRef, useState } from "react";
import { ApiError } from "@/lib/api/errors";
import { createIdempotencyStore, currentKey, resetKey, type IdempotencyStore } from "@/lib/api/idempotency";

export function useIdempotentAction<A extends unknown[], T>(
  action: (key: string, ...args: A) => Promise<T>,
) {
  const storeRef = useRef<IdempotencyStore | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const run = useCallback(
    async (...args: A): Promise<T> => {
      const store = (storeRef.current ??= createIdempotencyStore());
      setPending(true);
      setError(null);
      try {
        const result = await action(currentKey(store), ...args);
        resetKey(store);
        return result;
      } catch (caught) {
        if (caught instanceof ApiError) setError(caught);
        throw caught;
      } finally {
        setPending(false);
      }
    },
    [action],
  );

  const reset = useCallback(() => {
    if (storeRef.current) resetKey(storeRef.current);
    setError(null);
  }, []);

  return { run, pending, error, reset };
}
