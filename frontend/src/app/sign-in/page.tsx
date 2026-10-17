"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { messageFor } from "@/lib/api/errors";
import { useAuth } from "@/lib/auth/use-auth";

export default function SignInPage() {
  const router = useRouter();
  const { status, signIn, submitMfa } = useAuth();
  const [step, setStep] = useState<"credentials" | "mfa">("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaToken, setMfaToken] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (status === "authed") router.replace("/");
  }, [status, router]);

  const submitCredentials = async () => {
    setPending(true);
    setError(null);
    try {
      const result = await signIn(email.trim(), password);
      if (result.mfaRequired) {
        setMfaToken(result.mfaToken);
        setStep("mfa");
        setCode("");
      } else {
        router.replace("/");
      }
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setPending(false);
    }
  };

  const submitCode = async () => {
    setPending(true);
    setError(null);
    try {
      await submitMfa(mfaToken, code.trim());
      router.replace("/");
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <p className="font-display text-label font-semibold text-ink-soft">Enrollment &amp; records</p>
        <h1 className="mt-1 font-display text-display-3 font-semibold">Student Portal</h1>
        <div className="mt-2 border-t-2 border-ink" />

        {step === "credentials" ? (
          <form
            className="mt-6 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!pending) void submitCredentials();
            }}
          >
            <Field
              label="Email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
            <Field
              label="Password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
            {error ? <Banner tone="stamp" title={error} /> : null}
            <Button
              type="submit"
              variant="primary"
              className="w-full"
              disabled={pending || email.length === 0 || password.length === 0}
            >
              {pending ? "Signing in…" : "Sign in"}
            </Button>
            <p className="text-micro text-ink-soft">
              Demo seed: alice.santos@student.portal.test · Password123!
            </p>
          </form>
        ) : (
          <form
            className="mt-6 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!pending && code.length === 6) void submitCode();
            }}
          >
            <p className="text-body text-ink-soft">
              Enter the 6-digit code from your authenticator app.
            </p>
            <Field
              label="Authenticator code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              className="[&_input]:figure [&_input]:tracking-widest"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
            />
            {error ? <Banner tone="stamp" title={error} /> : null}
            <Button
              type="submit"
              variant="primary"
              className="w-full"
              disabled={pending || code.length !== 6}
            >
              {pending ? "Confirming…" : "Confirm code"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => {
                setStep("credentials");
                setError(null);
              }}
            >
              Back to sign in
            </Button>
          </form>
        )}
      </div>
    </main>
  );
}
