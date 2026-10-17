"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { WeekGrid } from "@/components/enroll/week-grid";
import { LedgerCell, LedgerHead, LedgerRow, LedgerTable } from "@/components/ledger/ledger-table";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { SkeletonRows } from "@/components/ui/skeleton";
import { itemMark, StatusMark } from "@/components/ui/status-mark";
import { codeCopy, messageFor } from "@/lib/api/errors";
import {
  dropItem,
  fetchEligibility,
  fetchEnrollment,
  fetchSections,
  joinWaitlist,
  reserveSections,
} from "@/lib/api/endpoints";
import type { SectionListItem, SectionSchedule } from "@/lib/api/types";
import { dayName, formatTime, peso, termLabel, units } from "@/lib/format";
import { type GridBlock } from "@/lib/grid";
import { useCurrentTerm } from "@/lib/hooks/use-current-term";
import { useIdempotentAction } from "@/lib/hooks/use-idempotent-action";

function scheduleSummary(schedules: SectionSchedule[]): string {
  return [...schedules]
    .sort((left, right) => left.dayOfWeek - right.dayOfWeek || left.startMin - right.startMin)
    .map(
      (schedule) =>
        `${dayName(schedule.dayOfWeek)} ${formatTime(schedule.startMin)}–${formatTime(schedule.endMin)}`,
    )
    .join(" · ");
}

function sectionUnits(section: SectionListItem): number {
  return Number(section.course.lectureUnits ?? 0) + Number(section.course.labUnits ?? 0);
}

export default function EnrollPage() {
  const { term } = useCurrentTerm();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

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

  const sectionsQuery = useQuery({
    queryKey: ["sections", term?.id],
    queryFn: () => fetchSections(term!.id),
    enabled: Boolean(term?.id),
  });

  const reserveAction = useIdempotentAction((key, sectionIds: string[]) =>
    reserveSections({ termId: term!.id, sectionIds }, key),
  );

  const dropMutation = useMutation({
    mutationFn: (itemId: string) => dropItem(itemId),
    onSuccess: async (data: { promoted?: boolean }) => {
      setNotice(
        data?.promoted
          ? "Dropped. A waitlisted student was promoted into the seat."
          : "Dropped the section.",
      );
      await invalidateEnrollment();
    },
    onError: (error) => setNotice(messageFor(error)),
  });

  const waitlistMutation = useMutation({
    mutationFn: (sectionId: string) => joinWaitlist(term!.id, sectionId),
    onSuccess: async () => {
      setNotice("Joined the waitlist. A seat will move to you automatically.");
      await invalidateEnrollment();
    },
    onError: (error) => setNotice(messageFor(error)),
  });

  const invalidateEnrollment = async () => {
    await queryClient.invalidateQueries({ queryKey: ["enrollment", term?.id] });
    await queryClient.invalidateQueries({ queryKey: ["sections", term?.id] });
  };

  const enrollment = enrollmentQuery.data ?? null;
  const enrolledItems = useMemo(
    () => enrollment?.items.filter((item) => item.status === "ENROLLED") ?? [],
    [enrollment],
  );
  const waitlistedItems = enrollment?.items.filter((item) => item.status === "WAITLISTED") ?? [];
  const sectionsData = useMemo(() => sectionsQuery.data ?? [], [sectionsQuery.data]);

  const windowOpen = term?.status === "ENROLLMENT" || term?.status === "ADD_DROP";

  const blocks = useMemo(() => {
    const result: GridBlock[] = [];
    for (const item of enrolledItems) {
      for (const schedule of item.section.schedules) {
        result.push({
          id: `e-${schedule.id}`,
          label: item.section.course.code,
          sublabel: `${item.section.sectionCode}${schedule.room ? ` · ${schedule.room.code}` : ""}`,
          day: schedule.dayOfWeek,
          startMin: schedule.startMin,
          endMin: schedule.endMin,
          state: "enrolled",
        });
      }
    }
    for (const section of sectionsData) {
      if (!selected.has(section.id)) continue;
      for (const schedule of section.schedules) {
        result.push({
          id: `c-${schedule.id}`,
          label: section.course.code,
          sublabel: section.sectionCode,
          day: schedule.dayOfWeek,
          startMin: schedule.startMin,
          endMin: schedule.endMin,
          state: "candidate",
        });
      }
    }
    return result;
  }, [enrolledItems, sectionsData, selected]);

  const selectedSections = sectionsData.filter((section) => selected.has(section.id));
  const selectedUnits = selectedSections.reduce((sum, section) => sum + sectionUnits(section), 0);

  const toggleSection = (sectionId: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(sectionId)) next.delete(sectionId);
      else next.add(sectionId);
      return next;
    });
    setNotice(null);
  };

  const toggleFromGrid = (block: GridBlock) => {
    if (!block.id.startsWith("c-")) return;
    const scheduleId = block.id.slice(2);
    const section = sectionsData.find((entry) =>
      entry.schedules.some((schedule) => schedule.id === scheduleId),
    );
    if (section) toggleSection(section.id);
  };

  const onReserve = async () => {
    if (selected.size === 0) return;
    setNotice(null);
    try {
      const result = await reserveAction.run(Array.from(selected));
      setSelected(new Set());
      setNotice(
        result.assessment
          ? `Reserved ${result.items.length} section(s) · Assessment ${peso(result.assessment.totalAmount)}`
          : `Reserved ${result.items.length} section(s).`,
      );
      await invalidateEnrollment();
      await queryClient.invalidateQueries({ queryKey: ["assessment"] });
    } catch {
      // reserveAction.error renders below; keep the selection so the student can adjust.
    }
  };

  const filteredSections = sectionsData.filter((section) =>
    `${section.course.code} ${section.course.title} ${section.sectionCode}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );

  if (!term) {
    return (
      <div>
        <h1 className="font-display text-title font-semibold">Enrollment desk</h1>
        <p className="mt-4 border border-rule bg-surface px-4 py-6 text-body text-ink-soft">
          No academic terms are published yet.
        </p>
      </div>
    );
  }

  const reserveError = reserveAction.error;
  const reserveCopy = reserveError ? codeCopy(reserveError.code) : null;
  const canWaitlist =
    reserveError?.code === "SECTION_FULL" && selected.size === 1
      ? Array.from(selected)[0]
      : null;

  return (
    <div className="pb-10">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-display text-display-3 font-semibold">Enrollment desk</h1>
        <span className="text-label text-ink-soft">{termLabel(term)}</span>
      </div>
      <div className="mt-2 border-t-2 border-ink" />

      {!windowOpen ? (
        <div className="mt-4">
          <Banner tone="neutral" title="The enrollment window is closed for this term">
            You can review your schedule and assessment, but reserving and dropping are disabled.
          </Banner>
        </div>
      ) : null}

      {eligibilityQuery.data && eligibilityQuery.data.blocked.length > 0 ? (
        <div className="mt-4">
          <Banner
            tone="neutral"
            title={`${eligibilityQuery.data.blocked.length} course(s) blocked by prerequisites`}
          >
            {eligibilityQuery.data.blocked
              .slice(0, 3)
              .map((course) => course.code)
              .join(", ")}
            {eligibilityQuery.data.blocked.length > 3 ? "…" : ""}
          </Banner>
        </div>
      ) : null}

      {notice ? (
        <div className="mt-4">
          <Banner tone="ledger" title={notice} />
        </div>
      ) : null}

      {enrolledItems.length > 0 || waitlistedItems.length > 0 ? (
        <section className="mt-8">
          <h2 className="font-display text-title font-semibold">This term</h2>
          <div className="mt-3">
            <LedgerTable>
              <LedgerHead
                columns={[
                  { label: "Course" },
                  { label: "Section" },
                  { label: "Schedule" },
                  { label: "Units", align: "right" },
                  { label: "" },
                ]}
              />
              <tbody>
                {[...enrolledItems, ...waitlistedItems].map((item) => (
                  <LedgerRow key={item.id}>
                    <LedgerCell>
                      <span className="font-display font-semibold">{item.section.course.code}</span>
                      <span className="ml-2 text-ink-soft">{item.section.course.title}</span>
                    </LedgerCell>
                    <LedgerCell className="figure">{item.section.sectionCode}</LedgerCell>
                    <LedgerCell className="text-ink-soft">
                      {scheduleSummary(item.section.schedules)}
                    </LedgerCell>
                    <LedgerCell align="right">{units(item.unitsAtReservation)}</LedgerCell>
                    <LedgerCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <StatusMark cue={itemMark(item.status).cue}>
                          {itemMark(item.status).label}
                        </StatusMark>
                        {item.status === "ENROLLED" && windowOpen ? (
                          <Button
                            variant="danger"
                            size="sm"
                            disabled={dropMutation.isPending}
                            onClick={() => dropMutation.mutate(item.id)}
                          >
                            Drop
                          </Button>
                        ) : null}
                      </div>
                    </LedgerCell>
                  </LedgerRow>
                ))}
              </tbody>
            </LedgerTable>
          </div>
        </section>
      ) : null}

      <section className="mt-8">
        <h2 className="font-display text-title font-semibold">Your week</h2>
        <p className="mb-3 mt-1 text-label text-ink-soft">
          Solid blocks are reserved. Hatched picks are candidates — click one to remove it.
        </p>
        <WeekGrid blocks={blocks} onSelect={toggleFromGrid} emptyLabel="Reserve a section to see it here." />
      </section>

      <section className="mt-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="font-display text-title font-semibold">Sections offered</h2>
          <Field
            label="Search"
            placeholder="Code, title, or section"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="w-64"
          />
        </div>
        <div className="mt-3">
          {sectionsQuery.isLoading ? (
            <SkeletonRows rows={5} />
          ) : filteredSections.length === 0 ? (
            <p className="border border-rule bg-surface px-4 py-6 text-body text-ink-soft">
              No sections match.
            </p>
          ) : (
            <LedgerTable>
              <LedgerHead
                columns={[
                  { label: "Course" },
                  { label: "Section" },
                  { label: "Schedule" },
                  { label: "Seats", align: "right" },
                  { label: "", align: "right" },
                ]}
              />
              <tbody>
                {filteredSections.map((section) => {
                  const full = section._count.items >= section.maxCapacity;
                  const isSelected = selected.has(section.id);
                  const isAlready = enrolledItems.some((item) => item.section.id === section.id);
                  return (
                    <LedgerRow key={section.id}>
                      <LedgerCell>
                        <span className="font-display font-semibold">{section.course.code}</span>
                        <span className="ml-2 text-ink-soft">{section.course.title}</span>
                      </LedgerCell>
                      <LedgerCell className="figure">{section.sectionCode}</LedgerCell>
                      <LedgerCell className="text-ink-soft">
                        {scheduleSummary(section.schedules) || "No schedule published"}
                      </LedgerCell>
                      <LedgerCell align="right" className={full ? "text-stamp" : ""}>
                        {section._count.items}/{section.maxCapacity}
                      </LedgerCell>
                      <LedgerCell className="text-right">
                        {isAlready ? (
                          <StatusMark cue="solid">Reserved</StatusMark>
                        ) : (
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              variant={isSelected ? "primary" : "outline"}
                              size="sm"
                              disabled={!windowOpen || full}
                              onClick={() => toggleSection(section.id)}
                            >
                              {isSelected ? "Selected ✓" : "Select"}
                            </Button>
                            {full && windowOpen ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={waitlistMutation.isPending}
                                onClick={() => waitlistMutation.mutate(section.id)}
                              >
                                Waitlist
                              </Button>
                            ) : null}
                          </div>
                        )}
                      </LedgerCell>
                    </LedgerRow>
                  );
                })}
              </tbody>
            </LedgerTable>
          )}
        </div>
      </section>

      <div className="sticky bottom-4 mt-6 border border-ink bg-surface px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-display text-body font-semibold">
              {selected.size === 0
                ? "Nothing selected"
                : `${selected.size} section(s) selected · ${units(selectedUnits)} units`}
            </p>
            {selectedSections.length > 0 ? (
              <p className="text-micro text-ink-soft">
                {selectedSections.map((section) => section.course.code).join(", ")}
              </p>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {selected.size > 0 ? (
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            ) : null}
            <Button
              variant="primary"
              disabled={!windowOpen || selected.size === 0 || reserveAction.pending}
              onClick={() => void onReserve()}
            >
              {reserveAction.pending ? "Reserving…" : "Reserve selected"}
            </Button>
          </div>
        </div>
      </div>

      {reserveError && reserveCopy ? (
        <div className="mt-4">
          <Banner tone="stamp" title={reserveCopy.message}>
            {reserveCopy.action}
            {canWaitlist ? (
              <span className="ml-1 inline-block">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={waitlistMutation.isPending}
                  onClick={() => waitlistMutation.mutate(canWaitlist)}
                >
                  Join waitlist
                </Button>
              </span>
            ) : null}
            {reserveError.code === "SCHEDULE_CONFLICT_STUDENT" ? (
              <span className="ml-1 inline-block">
                <Link href="/schedule" className="underline">
                  View your week
                </Link>
              </span>
            ) : null}
          </Banner>
        </div>
      ) : null}
    </div>
  );
}
