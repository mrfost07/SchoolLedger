"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { LedgerCell, LedgerHead, LedgerRow, LedgerTable } from "@/components/ledger/ledger-table";
import { SkeletonRows } from "@/components/ui/skeleton";
import { StatusMark } from "@/components/ui/status-mark";
import { assessmentMark } from "@/components/ui/status-mark";
import { fetchEnrollment } from "@/lib/api/endpoints";
import type { FeeBreakdown } from "@/lib/api/types";
import { formatDateTime, peso, units } from "@/lib/format";
import { useCurrentTerm } from "@/lib/hooks/use-current-term";

export default function AssessmentPage() {
  const { term } = useCurrentTerm();

  const enrollmentQuery = useQuery({
    queryKey: ["enrollment", term?.id],
    queryFn: () => fetchEnrollment(term!.id),
    enabled: Boolean(term?.id),
  });

  const assessment = enrollmentQuery.data?.assessment ?? null;
  const breakdown = (assessment?.breakdown ?? null) as unknown as FeeBreakdown | null;
  const mark = assessment ? assessmentMark(assessment.status) : null;

  return (
    <div>
      <h1 className="font-display text-display-3 font-semibold">Assessment</h1>
      <div className="mt-2 border-t-2 border-ink" />

      {enrollmentQuery.isLoading ? (
        <SkeletonRows rows={6} className="mt-6" />
      ) : !assessment || !breakdown ? (
        <p className="mt-6 border border-rule bg-surface px-4 py-6 text-body text-ink-soft">
          Nothing assessed yet for this term.{" "}
          <Link href="/enroll" className="underline">
            Reserve sections first
          </Link>
          .
        </p>
      ) : (
        <>
          <div className="mt-6 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="text-label font-semibold text-ink-soft">Total amount due</h2>
              <p className="figure mt-1 font-display text-display-1 font-semibold">
                {peso(assessment.totalAmount, assessment.currency)}
              </p>
              <p className="mt-1 text-micro text-ink-soft">
                Computed {formatDateTime(assessment.computedAt)}
                {assessment.paidAt ? ` · paid ${formatDateTime(assessment.paidAt)}` : ""}
              </p>
            </div>
            <div className="text-right">
              {mark ? <StatusMark cue={mark.cue}>{mark.label}</StatusMark> : null}
              <p className="figure mt-2 text-micro text-ink-soft">
                Snapshot {assessment.snapshotHash.slice(0, 12)}…
              </p>
            </div>
          </div>

          <div className="mt-8">
            <LedgerTable caption="Fee breakdown">
              <LedgerHead
                columns={[
                  { label: "Code" },
                  { label: "Item" },
                  { label: "Category" },
                  { label: "Amount", align: "right" },
                ]}
              />
              <tbody>
                {breakdown.lineItems.map((line) => (
                  <LedgerRow key={line.code}>
                    <LedgerCell className="figure text-ink-soft">{line.code}</LedgerCell>
                    <LedgerCell>
                      <span className="font-display font-semibold">{line.name}</span>
                      {line.detail ? (
                        <span className="ml-2 text-ink-soft">{line.detail}</span>
                      ) : null}
                    </LedgerCell>
                    <LedgerCell className="text-ink-soft">{line.category.toLowerCase()}</LedgerCell>
                    <LedgerCell align="right">{peso(line.amount, assessment.currency)}</LedgerCell>
                  </LedgerRow>
                ))}
                {breakdown.discounts.length > 0 ? (
                  breakdown.discounts.map((discount) => (
                    <LedgerRow key={discount.code}>
                      <LedgerCell className="figure text-ledger">{discount.code}</LedgerCell>
                      <LedgerCell className="text-ledger">
                        {discount.name} ({discount.percent}%)
                      </LedgerCell>
                      <LedgerCell className="text-ledger">discount</LedgerCell>
                      <LedgerCell align="right" className="text-ledger">
                        −{peso(discount.amount, assessment.currency)}
                      </LedgerCell>
                    </LedgerRow>
                  ))
                ) : null}
              </tbody>
              <tfoot>
                <tr className="border-t border-rule">
                  <td colSpan={2} />
                  <td className="py-2 text-label font-semibold text-ink-soft">Subtotal</td>
                  <td className="figure py-2 text-right">{peso(breakdown.subtotal, assessment.currency)}</td>
                </tr>
                <tr className="border-t-2 border-ink">
                  <td colSpan={2} />
                  <td className="py-2 font-display font-semibold">Total</td>
                  <td className="figure py-2 text-right font-display font-semibold">
                    {peso(breakdown.total, assessment.currency)}
                  </td>
                </tr>
              </tfoot>
            </LedgerTable>
          </div>

          <div className="mt-6 grid gap-6 sm:grid-cols-3">
            <div>
              <h3 className="text-label font-semibold text-ink-soft">Lecture units</h3>
              <p className="figure mt-1 font-display text-title font-semibold">
                {units(breakdown.units.lecture)}
              </p>
            </div>
            <div>
              <h3 className="text-label font-semibold text-ink-soft">Lab units</h3>
              <p className="figure mt-1 font-display text-title font-semibold">
                {units(breakdown.units.lab)}
              </p>
            </div>
            <div>
              <h3 className="text-label font-semibold text-ink-soft">Total units</h3>
              <p className="figure mt-1 font-display text-title font-semibold">
                {units(breakdown.units.total)}
              </p>
            </div>
          </div>

          <p className="mt-8 border-t border-rule pt-3 text-micro text-ink-soft">
            Payment is settled at the cashier. Once recorded, this assessment freezes to a paid
            snapshot — drop or add sections before payment to change it.
          </p>
        </>
      )}
    </div>
  );
}
