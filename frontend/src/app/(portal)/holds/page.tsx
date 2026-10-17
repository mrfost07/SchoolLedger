"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { LedgerCell, LedgerHead, LedgerRow, LedgerTable } from "@/components/ledger/ledger-table";
import { Banner } from "@/components/ui/banner";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Stamp } from "@/components/ui/stamp";
import { fetchHolds } from "@/lib/api/endpoints";
import type { HoldRow } from "@/lib/api/types";
import { useAuth } from "@/lib/auth/use-auth";
import { formatDate } from "@/lib/format";
import { useNow } from "@/lib/hooks/use-now";

function typeStamp(type: string) {
  const label =
    type === "FINANCIAL" ? "Financial" : type === "DISCIPLINARY" ? "Disciplinary" : "Documentary";
  return <Stamp tone={type === "FINANCIAL" ? "stamp" : "ink"}>{label}</Stamp>;
}

function isActive(hold: HoldRow, now: number | null): boolean {
  if (hold.liftedAt) return false;
  if (!hold.endsAt) return true;
  if (now === null) return true;
  return new Date(hold.endsAt).getTime() > now;
}

export default function HoldsPage() {
  const { studentId } = useAuth();
  const now = useNow();

  const holdsQuery = useQuery({
    queryKey: ["holds", studentId],
    queryFn: () => fetchHolds(studentId!, true),
    enabled: Boolean(studentId),
  });

  const rows = holdsQuery.data ?? [];
  const active = rows.filter((hold) => isActive(hold, now));
  const lifted = rows.filter((hold) => !isActive(hold, now));

  return (
    <div>
      <h1 className="font-display text-display-3 font-semibold">Holds</h1>
      <div className="mt-2 border-t-2 border-ink" />

      {holdsQuery.isLoading ? (
        <SkeletonRows rows={4} className="mt-6" />
      ) : (
        <>
          {active.length > 0 ? (
            <div className="mt-4">
              <Banner
                tone="stamp"
                title={
                  active.length === 1
                    ? "1 hold is blocking you"
                    : `${active.length} holds are blocking you`
                }
              >
                A clearance hold blocks new enrollments and official document requests. The cashier
                lifts it once settled.
              </Banner>
            </div>
          ) : (
            <div className="mt-4">
              <Banner tone="ledger" title="You are cleared">
                No active holds. Official documents and enrollment are unblocked.
              </Banner>
            </div>
          )}

          <section className="mt-8">
            <h2 className="font-display text-title font-semibold">Active</h2>
            <div className="mt-3">
              {active.length === 0 ? (
                <p className="border border-rule bg-surface px-4 py-6 text-body text-ink-soft">
                  Nothing active.
                </p>
              ) : (
                <LedgerTable>
                  <LedgerHead
                    columns={[
                      { label: "Type" },
                      { label: "Reason" },
                      { label: "Started" },
                      { label: "Ends" },
                    ]}
                  />
                  <tbody>
                    {active.map((hold) => (
                      <LedgerRow key={hold.id}>
                        <LedgerCell>{typeStamp(hold.type)}</LedgerCell>
                        <LedgerCell>{hold.reason}</LedgerCell>
                        <LedgerCell className="figure text-ink-soft">
                          {formatDate(hold.startsAt)}
                        </LedgerCell>
                        <LedgerCell className="figure text-ink-soft">
                          {hold.endsAt ? formatDate(hold.endsAt) : "Until lifted"}
                        </LedgerCell>
                      </LedgerRow>
                    ))}
                  </tbody>
                </LedgerTable>
              )}
            </div>
          </section>

          {lifted.length > 0 ? (
            <section className="mt-8">
              <h2 className="font-display text-title font-semibold">Lifted / past</h2>
              <div className="mt-3">
                <LedgerTable>
                  <LedgerHead
                    columns={[
                      { label: "Type" },
                      { label: "Reason" },
                      { label: "Started" },
                      { label: "Ended" },
                    ]}
                  />
                  <tbody>
                    {lifted.map((hold) => (
                      <LedgerRow key={hold.id}>
                        <LedgerCell className="opacity-60">{typeStamp(hold.type)}</LedgerCell>
                        <LedgerCell className="opacity-60">{hold.reason}</LedgerCell>
                        <LedgerCell className="figure text-ink-soft">
                          {formatDate(hold.startsAt)}
                        </LedgerCell>
                        <LedgerCell className="figure text-ink-soft">
                          {formatDate(hold.liftedAt ?? hold.endsAt)}
                        </LedgerCell>
                      </LedgerRow>
                    ))}
                  </tbody>
                </LedgerTable>
              </div>
              <p className="mt-3 text-micro text-ink-soft">
                Questions about a hold? Visit the cashier window with your student ID. Need records
                sooner? <Link href="/documents" className="underline">Check document requests</Link>.
              </p>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
