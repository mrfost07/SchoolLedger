"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Nav } from "@/components/shell/nav";
import { RecordRail, TopStrip } from "@/components/shell/record-rail";
import { SkeletonRows } from "@/components/ui/skeleton";
import { useAuth } from "@/lib/auth/use-auth";

export default function PortalLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { status } = useAuth();

  useEffect(() => {
    if (status === "anon") router.replace("/sign-in");
  }, [status, router]);

  if (status !== "authed") {
    return (
      <main className="mx-auto max-w-5xl px-4 py-10 lg:px-8">
        <p className="font-display text-label font-semibold text-ink-soft">Enrollment &amp; records</p>
        <h1 className="mt-1 font-display text-display-3 font-semibold">SchoolLedger</h1>
        <div className="mt-6 border-t-2 border-ink" />
        <SkeletonRows rows={5} className="mt-6" />
      </main>
    );
  }

  return (
    <div className="min-h-dvh">
      <header className="border-b-2 border-ink bg-paper">
        <div className="mx-auto flex max-w-6xl flex-wrap items-baseline justify-between gap-x-6 gap-y-2 px-4 py-4 lg:px-8">
          <p className="font-display text-title font-semibold">
            SchoolLedger
            <span className="ml-2 text-label font-normal text-ink-soft">Enrollment &amp; records</span>
          </p>
          <Nav />
        </div>
      </header>
      <div className="mx-auto max-w-6xl px-4 py-6 lg:px-8">
        <TopStrip />
        <div className="lg:flex lg:gap-8">
          <RecordRail />
          <main className="min-w-0 flex-1 pt-4 lg:pt-0">{children}</main>
        </div>
      </div>
    </div>
  );
}
