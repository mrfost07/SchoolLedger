"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { WeekGrid } from "@/components/enroll/week-grid";
import { LedgerCell, LedgerHead, LedgerRow, LedgerTable } from "@/components/ledger/ledger-table";
import { StatusMark } from "@/components/ui/status-mark";
import { SkeletonRows } from "@/components/ui/skeleton";
import { fetchEnrollment } from "@/lib/api/endpoints";
import { dayName, formatRange, termLabel, units } from "@/lib/format";
import { type GridBlock } from "@/lib/grid";
import { useCurrentTerm } from "@/lib/hooks/use-current-term";

export default function SchedulePage() {
  const { term } = useCurrentTerm();

  const enrollmentQuery = useQuery({
    queryKey: ["enrollment", term?.id],
    queryFn: () => fetchEnrollment(term!.id),
    enabled: Boolean(term?.id),
  });

  const items = useMemo(
    () => enrollmentQuery.data?.items.filter((item) => item.status === "ENROLLED") ?? [],
    [enrollmentQuery.data],
  );

  const blocks = useMemo(() => {
    const result: GridBlock[] = [];
    for (const item of items) {
      for (const schedule of item.section.schedules) {
        result.push({
          id: schedule.id,
          label: item.section.course.code,
          sublabel: `${item.section.sectionCode}${schedule.room ? ` · ${schedule.room.code}` : ""}`,
          day: schedule.dayOfWeek,
          startMin: schedule.startMin,
          endMin: schedule.endMin,
          state: "enrolled",
        });
      }
    }
    return result;
  }, [items]);

  const totalUnits = items.reduce((sum, item) => sum + Number(item.unitsAtReservation ?? 0), 0);

  if (!term) {
    return (
      <div>
        <h1 className="font-display text-title font-semibold">Schedule</h1>
        <p className="mt-4 border border-rule bg-surface px-4 py-6 text-body text-ink-soft">
          No academic terms are published yet.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-display text-display-3 font-semibold">Weekly schedule</h1>
        <span className="text-label text-ink-soft">
          {termLabel(term)} · {units(totalUnits)} units
        </span>
      </div>
      <div className="mt-2 border-t-2 border-ink" />

      {enrollmentQuery.isLoading ? (
        <SkeletonRows rows={5} className="mt-6" />
      ) : (
        <>
          <div className="mt-6">
            <WeekGrid
              blocks={blocks}
              emptyLabel="Nothing reserved yet for this term."
            />
          </div>

          {items.length === 0 ? (
            <p className="mt-4 text-body text-ink-soft">
              <Link href="/enroll" className="underline">
                Go to the enrollment desk
              </Link>{" "}
              to reserve sections.
            </p>
          ) : (
            <div className="mt-8">
              <LedgerTable caption="All meetings, sorted by day">
                <LedgerHead
                  columns={[
                    { label: "Day" },
                    { label: "Time" },
                    { label: "Course" },
                    { label: "Section" },
                    { label: "Room" },
                    { label: "Instructor" },
                  ]}
                />
                <tbody>
                  {items
                    .flatMap((item) =>
                      item.section.schedules.map((schedule) => ({ item, schedule })),
                    )
                    .sort(
                      (left, right) =>
                        left.schedule.dayOfWeek - right.schedule.dayOfWeek ||
                        left.schedule.startMin - right.schedule.startMin,
                    )
                    .map(({ item, schedule }) => (
                      <LedgerRow key={schedule.id}>
                        <LedgerCell>{dayName(schedule.dayOfWeek)}</LedgerCell>
                        <LedgerCell className="figure whitespace-nowrap text-ink-soft">
                          {formatRange(schedule.startMin, schedule.endMin)}
                        </LedgerCell>
                        <LedgerCell>
                          <span className="font-display font-semibold">
                            {item.section.course.code}
                          </span>
                          <span className="ml-2 text-ink-soft">{item.section.course.title}</span>
                        </LedgerCell>
                        <LedgerCell className="figure">{item.section.sectionCode}</LedgerCell>
                        <LedgerCell>{schedule.room?.code ?? "—"}</LedgerCell>
                        <LedgerCell className="text-ink-soft">
                          {item.section.instructor
                            ? `${item.section.instructor.firstName} ${item.section.instructor.lastName}`
                            : "—"}
                        </LedgerCell>
                      </LedgerRow>
                    ))}
                </tbody>
              </LedgerTable>
            </div>
          )}

          {enrollmentQuery.data?.assessment ? (
            <p className="mt-6 text-label text-ink-soft">
              Assessment status:{" "}
              <StatusMark
                cue={enrollmentQuery.data.assessment.status === "PAID" ? "ledger" : "stamp"}
              >
                {enrollmentQuery.data.assessment.status === "PAID" ? "Paid" : "Unpaid"}
              </StatusMark>{" "}
              <Link href="/assessment" className="ml-2 underline">
                View assessment
              </Link>
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
