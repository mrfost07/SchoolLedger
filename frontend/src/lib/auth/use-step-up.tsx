"use client";

import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { isApiError, messageFor } from "@/lib/api/errors";
import { useAuth } from "./use-auth";

interface StepUpContextValue {
  withStepUp<T>(fn: () => Promise<T>): Promise<T>;
}

const StepUpContext = createContext<StepUpContextValue | null>(null);

export function StepUpProvider({ children }: { children: ReactNode }) {
  const { stepUp } = useAuth();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [needsEnrollment, setNeedsEnrollment] = useState(false);
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);

  const close = (ok: boolean) => {
    setOpen(false);
    setPending(false);
    const resolve = resolverRef.current;
    resolverRef.current = null;
    resolve?.(ok);
  };

  const value = useMemo<StepUpContextValue>(
    () => ({
      withStepUp: async <T,>(fn: () => Promise<T>): Promise<T> => {
        try {
          return await fn();
        } catch (caught) {
          if (isApiError(caught) && caught.code === "STEP_UP_REQUIRED") {
            setCode("");
            setError(null);
            setNeedsEnrollment(false);
            const ok = await new Promise<boolean>((resolve) => {
              resolverRef.current = resolve;
              setOpen(true);
            });
            if (!ok) throw caught;
            return fn();
          }
          throw caught;
        }
      },
    }),
    [],
  );

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      await stepUp(code.trim());
      close(true);
    } catch (caught) {
      if (isApiError(caught)) {
        if (caught.code === "STEP_UP_MFA_NOT_ENROLLED") {
          setNeedsEnrollment(true);
          setError("Set up your authenticator app first.");
        } else if (caught.code === "AUTH_MFA_INVALID") {
          setError("That code is not right. Try the next one from your app.");
        } else if (caught.code === "RATE_LIMITED") {
          setError("Too many attempts. Try again in a minute.");
        } else {
          setError(messageFor(caught));
        }
      } else {
        setError("Something failed. Try again.");
      }
      setPending(false);
    }
  };

  return (
    <StepUpContext.Provider value={value}>
      {children}
      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <button
            type="button"
            aria-label="Cancel"
            className="absolute inset-0 bg-ink/40"
            onClick={() => close(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="step-up-title"
            className="relative w-full max-w-sm border border-ink bg-surface p-6"
          >
            <h2 id="step-up-title" className="font-display text-title font-semibold">
              Confirm it&rsquo;s you
            </h2>
            <p className="mt-2 text-body text-ink-soft">
              Enter the 6-digit code from your authenticator app to continue.
            </p>
            <label className="mt-4 block text-label font-semibold" htmlFor="step-up-code">
              Authenticator code
            </label>
            <input
              id="step-up-code"
              className="figure mt-1 w-full border border-ink bg-surface px-3 py-2 text-title tracking-widest"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
              onKeyDown={(event) => {
                if (event.key === "Enter" && code.length === 6 && !pending) void submit();
              }}
              autoFocus
            />
            {error ? <p className="mt-2 text-body text-stamp">{error}</p> : null}
            {needsEnrollment ? (
              <a href="/account" className="mt-1 inline-block text-body underline">
                Open Account to set up your authenticator
              </a>
            ) : null}
            <div className="mt-5 flex items-center gap-3">
              <button
                type="button"
                className="border border-ink px-4 py-2 font-display text-body font-semibold disabled:opacity-50"
                disabled={pending || code.length !== 6}
                onClick={() => void submit()}
              >
                {pending ? "Confirming…" : "Confirm"}
              </button>
              <button
                type="button"
                className="px-2 py-2 text-body text-ink-soft underline"
                onClick={() => close(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </StepUpContext.Provider>
  );
}

export function useStepUp(): StepUpContextValue {
  const context = useContext(StepUpContext);
  if (!context) throw new Error("useStepUp must be used inside StepUpProvider.");
  return context;
}
