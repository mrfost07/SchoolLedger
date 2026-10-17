"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth/use-auth";
import { termLabel } from "@/lib/format";
import { useCurrentTerm } from "@/lib/hooks/use-current-term";

function DefinitionRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-3 border-t border-rule pt-2">
      <dt className="text-micro text-ink-soft">{label}</dt>
      <dd className="figure font-semibold">{children}</dd>
    </div>
  );
}

function useRecord() {
  const { me, signOut } = useAuth();
  const { term } = useCurrentTerm();
  return { me, signOut, term };
}

export function RecordRail() {
  const { me, signOut, term } = useRecord();
  const profile = me?.profile ?? null;

  return (
    <aside className="hidden w-56 shrink-0 border-r border-rule pr-4 lg:block">
      <p className="font-display text-body font-semibold">
        {me ? `${me.firstName} ${me.lastName}` : "—"}
      </p>
      <dl className="text-label">
        <DefinitionRow label="Student no.">{profile?.studentNo ?? "—"}</DefinitionRow>
        <DefinitionRow label="Program">{profile?.program.code ?? "—"}</DefinitionRow>
        <DefinitionRow label="Term">{term ? termLabel(term) : "—"}</DefinitionRow>
        <DefinitionRow label="Year level">{profile?.yearLevel ?? "—"}</DefinitionRow>
      </dl>
      <Button variant="ghost" size="sm" className="mt-4 px-0" onClick={() => void signOut()}>
        Sign out
      </Button>
    </aside>
  );
}

export function TopStrip() {
  const { me, signOut, term } = useRecord();
  const profile = me?.profile ?? null;

  return (
    <div className="flex items-center justify-between gap-3 border-b border-rule pb-2 lg:hidden">
      <div className="min-w-0">
        <p className="truncate font-display text-body font-semibold">
          {me ? `${me.firstName} ${me.lastName}` : "—"}
          {profile ? <span className="figure ml-2 text-label font-normal text-ink-soft">{profile.studentNo}</span> : null}
        </p>
        <p className="text-micro text-ink-soft">{term ? termLabel(term) : "—"}</p>
      </div>
      <Button variant="ghost" size="sm" className="px-2" onClick={() => void signOut()}>
        Sign out
      </Button>
    </div>
  );
}
