"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Stamp } from "@/components/ui/stamp";
import { messageFor } from "@/lib/api/errors";
import { totpEnable, totpSetup } from "@/lib/api/endpoints";
import { useAuth } from "@/lib/auth/use-auth";
import { formatDate } from "@/lib/format";

export default function AccountPage() {
  const { me, signOut, logoutAll, refreshMe } = useAuth();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingAll, setConfirmingAll] = useState(false);

  const setupMutation = useMutation({
    mutationFn: totpSetup,
    onSuccess: (data) => {
      setSetup(data);
      setNotice(null);
    },
    onError: (error) => setNotice(messageFor(error)),
  });

  const enableMutation = useMutation({
    mutationFn: (value: string) => totpEnable(value),
    onSuccess: async () => {
      setSetup(null);
      setCode("");
      setNotice("Authenticator enabled. Official downloads will ask for a code.");
      await refreshMe();
    },
    onError: (error) => setNotice(messageFor(error)),
  });

  const revokeAllMutation = useMutation({
    mutationFn: logoutAll,
    onError: (error) => setNotice(messageFor(error)),
  });

  if (!me) {
    return null;
  }

  const profile = me.profile;

  return (
    <div className="max-w-2xl">
      <h1 className="font-display text-display-3 font-semibold">Account</h1>
      <div className="mt-2 border-t-2 border-ink" />

      <section className="mt-6 grid grid-cols-2 gap-4">
        <div>
          <h2 className="text-label font-semibold text-ink-soft">Name</h2>
          <p className="mt-1 text-body font-semibold">
            {me.firstName} {me.lastName}
          </p>
        </div>
        <div>
          <h2 className="text-label font-semibold text-ink-soft">Email</h2>
          <p className="mt-1 text-body">{me.email}</p>
        </div>
        <div>
          <h2 className="text-label font-semibold text-ink-soft">Student no.</h2>
          <p className="figure mt-1 text-body">{profile?.studentNo ?? "—"}</p>
        </div>
        <div>
          <h2 className="text-label font-semibold text-ink-soft">Program</h2>
          <p className="mt-1 text-body">
            {profile ? `${profile.program.code} — ${profile.program.degreeTitle}` : "—"}
          </p>
        </div>
        <div>
          <h2 className="text-label font-semibold text-ink-soft">Year level</h2>
          <p className="figure mt-1 text-body">{profile?.yearLevel ?? "—"}</p>
        </div>
        <div>
          <h2 className="text-label font-semibold text-ink-soft">Roles</h2>
          <p className="mt-1 flex flex-wrap gap-1">
            {me.roles.map((role) => (
              <Stamp key={role} tone="ink">
                {role}
              </Stamp>
            ))}
          </p>
        </div>
      </section>

      {notice ? (
        <div className="mt-6">
          <Banner tone="ledger" title={notice} />
        </div>
      ) : null}

      <section className="mt-8 border-t border-rule pt-4">
        <h2 className="font-display text-title font-semibold">Two-step verification</h2>
        {me.mfaEnabled ? (
          <p className="mt-2 text-body text-ink-soft">
            Authenticator enabled
            {me.totpEnabledAt ? ` since ${formatDate(me.totpEnabledAt)}` : ""}. Official document
            downloads ask for a fresh code (step-up).
          </p>
        ) : setup ? (
          <div className="mt-3">
            <p className="text-body text-ink-soft">
              Add this secret to your authenticator app, then enter the current 6-digit code to
              confirm.
            </p>
            <p className="figure mt-2 select-all break-all border border-rule bg-surface px-3 py-2 text-body">
              {setup.secret}
            </p>
            <p className="mt-1 break-all text-micro text-ink-soft">{setup.otpauthUrl}</p>
            <form
              className="mt-4 flex items-end gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (code.length === 6 && !enableMutation.isPending) enableMutation.mutate(code);
              }}
            >
              <Field
                label="Authenticator code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
              />
              <Button
                type="submit"
                variant="primary"
                disabled={code.length !== 6 || enableMutation.isPending}
              >
                {enableMutation.isPending ? "Verifying…" : "Enable"}
              </Button>
            </form>
          </div>
        ) : (
          <div className="mt-2">
            <p className="text-body text-ink-soft">
              Set up an authenticator app to unlock official document downloads (step-up
              confirmation) and protect your records.
            </p>
            <Button
              variant="outline"
              className="mt-3"
              disabled={setupMutation.isPending}
              onClick={() => setupMutation.mutate()}
            >
              {setupMutation.isPending ? "Preparing…" : "Set up authenticator"}
            </Button>
          </div>
        )}
      </section>

      <section className="mt-8 border-t border-rule pt-4">
        <h2 className="font-display text-title font-semibold">Sessions</h2>
        <p className="mt-2 text-body text-ink-soft">
          Signing out everywhere revokes all active sessions on every device.
        </p>
        <div className="mt-3 flex flex-wrap gap-3">
          <Button variant="outline" onClick={() => void signOut()}>
            Sign out
          </Button>
          {confirmingAll ? (
            <div className="flex items-center gap-2">
              <Button
                variant="danger"
                disabled={revokeAllMutation.isPending}
                onClick={() => revokeAllMutation.mutate()}
              >
                {revokeAllMutation.isPending ? "Revoking…" : "Yes, sign out everywhere"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmingAll(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button variant="outline" onClick={() => setConfirmingAll(true)}>
              Sign out everywhere
            </Button>
          )}
        </div>
      </section>
    </div>
  );
}
