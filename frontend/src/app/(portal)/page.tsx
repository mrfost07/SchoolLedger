"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { LedgerTable, LedgerHead, LedgerCell, LedgerRow } from "@/components/ledger/ledger-table";
import { Banner } from "@/components/ui/banner";
import { buttonClasses } from "@/components/ui/button";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Stamp } from "@/components/ui/stamp";
import { assessmentMark, StatusMark } from "@/components/ui/status-mark";
import { fetchEligibility, fetchEnrollment, fetchHolds } from "@/lib/api/endpoints";
import type { Eligibility } from "@/lib/api/types";
import { useAuth } from "@/lib/auth/use-auth";
import { dayName, formatRange, formatTime, peso, termLabel, units } from "@/lib/format";
import { useCurrentTerm } from "@/lib/hooks/use-current-term";
import { useNow } from "@/lib/hooks/use-now";

function termStatusBadge(status: string) {
  if (status === "ENROLLMENT") return <Stamp tone="signal">Enrollment open</Stamp>;
  if (status === "ADD_DROP") return <Stamp tone="signal">Add/drop open</Stamp>;
  const label =
    status === "PLANNING"
      ? "Planned"
      : status === "ONGOING"
        ? "Ongoing"
        : status === "GRADING"
          ? "Grading"
          : status === "CLOSED"
            ? "Closed"
            : status;
  return <Stamp tone="ink">{label}</Stamp>;
}

function eligibilityLine(eligibility: Eligibility | undefined) {
  if (!eligibility) return null;
  const parts: string[] = [];
  if (eligibility.eligible.length > 0) parts.push(`${eligibility.eligible.length} courses ready`);
  if (eligibility.blocked.length > 0) parts.push(`${eligibility.blocked.length} blocked`);
  if (parts.length === 0) return null;
  return parts.join(" · ");
}

export default function HomePage() {
  const { studentId } = useAuth();
  const { term } = useCurrentTerm();
  const now = useNow();

  const eligibilityQuery = useQuery({
    queryKey: ["eligibility", term?.id],
    queryFn: () => fetchEligibility(term!.id),
    enabled: Boolean(term?.id),
  });

  const enrollmentQuery = useQuery({
    queryKey: ["enrollment", term?.id],
    queryFn: () => fetchEnrollment(term!.id),
    enabled: Boolean(term?.id),
  });

  const holdsQuery = useQuery({
    queryKey: ["holds", studentId],
    queryFn: () => fetchHolds(studentId!, true),
    enabled: Boolean(studentId),
  });

  if (!term) {
    return (
      <div>
        <h1 className="font-display text-title font-semibold">Home</h1>
        <p className="mt-4 border border-rule bg-surface px-4 py-6 text-body text-ink-soft">
          No academic terms are published yet.
        </p>
      </div>
    );
  }

  const enrollment = enrollmentQuery.data ?? null;
  const items = enrollment?.items.filter((item) => item.status === "ENROLLED") ?? [];
  const totalUnits = items.reduce((sum, item) => sum + Number(item.unitsAtReservation ?? 0), 0);
  const assessment = enrollment?.assessment ?? null;
  const activeHolds =
    holdsQuery.data?.filter(
      (hold) =>
        !hold.liftedAt &&
        (!hold.endsAt || (now !== null && new Date(hold.endsAt).getTime() > now)),
    ) ?? [];
  const today = now === null ? null : new Date(now).getDay();
  const todayBlocks =
    today === null
      ? []
      : items
          .flatMap((item) =>
            item.section.schedules
              .filter((schedule) => schedule.dayOfWeek === today)
              .map((schedule) => ({ schedule, item })),
          )
          .sort((left, right) => left.schedule.startMin - right.schedule.startMin);

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-display text-display-3 font-semibold">{termLabel(term)}</h1>
        {termStatusBadge(term.status)}
      </div>
      <div className="mt-2 border-t-2 border-ink" />

      {activeHolds.length > 0 ? (
        <div className="mt-4">
          <Banner
            tone="stamp"
            title={
              activeHolds.length === 1 ? "1 clearance hold is active" : `${activeHolds.length} clearance holds are active`
            }
            action={
              <Link href="/holds" className="text-body font-semibold underline">
                View holds
              </Link>
            }
          >
            Holds block enrollment and official document requests until the cashier lifts them.
          </Banner>
        </div>
      ) : null}

      <div className="mt-6 grid gap-6 sm:grid-cols-3">
        <section>
          <h2 className="text-label font-semibold text-ink-soft">Units reserved</h2>
          <p className="figure mt-1 font-display text-display-2 font-semibold">{units(totalUnits)}</p>
          <p className="mt-1 text-micro text-ink-soft">
            {items.length === 1 ? "1 section" : `${items.length} sections`}
          </p>
        </section>
        <section>
          <h2 className="text-label font-semibold text-ink-soft">Assessment</h2>
          <p className="figure mt-1 font-display text-display-2 font-semibold">
            {assessment ? peso(assessment.totalAmount) : "—"}
          </p>
          <p className="mt-1">
            {assessment ? (
              <StatusMark cue={assessmentMark(assessment.status).cue}>
                {assessmentMark(assessment.status).label}
              </StatusMark>
            ) : (
              <span className="text-micro text-ink-soft">Nothing assessed yet</span>
            )}
          </p>
        </section>
        <section>
          <h2 className="text-label font-semibold text-ink-soft">Eligibility</h2>
          <p className="mt-1 font-display text-body font-semibold">
            {eligibilityLine(eligibilityQuery.data) ?? "—"}
          </p>
          <p className="mt-1 text-micro text-ink-soft">
            {term.status === "ENROLLMENT" ? "Enrollment window is open" : "Window not open"}
          </p>
        </section>
      </div>

      <div className="mt-8 flex flex-wrap gap-3">
        <Link href="/enroll" className={buttonClasses("primary")}>
          Enrollment desk
        </Link>
        <Link href="/schedule" className={buttonClasses("outline")}>
          Weekly schedule
        </Link>
        <Link href="/assessment" className={buttonClasses("outline")}>
          Assessment
        </Link>
      </div>

      <section className="mt-10">
        <h2 className="font-display text-title font-semibold">
          Today{today !== null && today >= 1 && today <= 5 ? ` · ${dayName(today)}` : ""}
        </h2>
        <div className="mt-3">
          {now === null ? (
            <SkeletonRows rows={2} />
          ) : todayBlocks.length === 0 ? (
            <p className="border border-rule bg-surface px-4 py-6 text-body text-ink-soft">
              No classes on your schedule today.
            </p>
          ) : (
            <LedgerTable>
              <LedgerHead
                columns={[
                  { label: "Time" },
                  { label: "Course" },
                  { label: "Section" },
                  { label: "Room" },
                ]}
              />
              <tbody>
                {todayBlocks.map(({ schedule, item }) => (
                  <LedgerRow key={schedule.id}>
                    <LedgerCell className="figure whitespace-nowrap text-ink-soft">
                      {formatRange(schedule.startMin, schedule.endMin)}
                    </LedgerCell>
                    <LedgerCell className="font-display font-semibold">
                      {item.section.course.code}
                    </LedgerCell>
                    <LedgerCell>{item.section.sectionCode}</LedgerCell>
                    <LedgerCell>{schedule.room?.code ?? "—"}</LedgerCell>
                  </LedgerRow>
                ))}
              </tbody>
            </LedgerTable>
          )}
        </div>
      </section>

      {enrollmentQuery.isLoading ? <SkeletonRows rows={3} className="mt-6" /> : null}
      <p className="mt-8 text-micro text-ink-soft">
        Term window: {termLabel(term)} · classes run {formatTime(420)} – {formatTime(1200)} displayed on the week grid.
      </p>
    </div>
  );
}
