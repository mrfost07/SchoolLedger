"use client";

import { useQuery } from "@tanstack/react-query";
import { LedgerCell, LedgerHead, LedgerRow, LedgerTable } from "@/components/ledger/ledger-table";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Stamp } from "@/components/ui/stamp";
import { StatusMark } from "@/components/ui/status-mark";
import { fetchGwa, fetchLedger } from "@/lib/api/endpoints";
import { useAuth } from "@/lib/auth/use-auth";
import { formatDate, gradeRemark, gwa as gwaText, units } from "@/lib/format";

function standingStamp(standing: string) {
  if (standing === "DEANS_LISTER") return <Stamp tone="ledger">Dean&rsquo;s lister</Stamp>;
  if (standing === "GOOD_STANDING") return <Stamp tone="ledger">Good standing</Stamp>;
  if (standing === "PROBATION") return <Stamp tone="stamp">Probation</Stamp>;
  if (standing === "DISQUALIFIED") return <Stamp tone="stamp">Disqualified</Stamp>;
  return <Stamp tone="ink">{standing}</Stamp>;
}

function honorsLabel(honors: string | null): string | null {
  if (honors === "SUMMA_CUM_LAUDE") return "Summa cum laude";
  if (honors === "MAGNA_CUM_LAUDE") return "Magna cum laude";
  if (honors === "CUM_LAUDE") return "Cum laude";
  return null;
}

export default function GradesPage() {
  const { studentId } = useAuth();

  const ledgerQuery = useQuery({
    queryKey: ["ledger", studentId],
    queryFn: () => fetchLedger(studentId!),
    enabled: Boolean(studentId),
  });

  const gwaQuery = useQuery({
    queryKey: ["gwa", studentId],
    queryFn: () => fetchGwa(studentId!),
    enabled: Boolean(studentId),
  });

  const entries = ledgerQuery.data ?? [];
  const report = gwaQuery.data;

  return (
    <div>
      <h1 className="font-display text-display-3 font-semibold">Grades</h1>
      <div className="mt-2 border-t-2 border-ink" />

      {gwaQuery.isLoading ? (
        <SkeletonRows rows={4} className="mt-6" />
      ) : report ? (
        <>
          <div className="mt-6 grid gap-6 sm:grid-cols-3">
            <section>
              <h2 className="text-label font-semibold text-ink-soft">Cumulative GWA</h2>
              <p className="figure mt-1 font-display text-display-2 font-semibold">
                {gwaText(report.cumulativeGwa)}
              </p>
              <p className="mt-1 text-micro text-ink-soft">
                {units(report.totalUnits)} units · lower is better (1.00–5.00 scale)
              </p>
            </section>
            <section>
              <h2 className="text-label font-semibold text-ink-soft">Standing</h2>
              <p className="mt-1">{standingStamp(report.standing)}</p>
            </section>
            <section>
              <h2 className="text-label font-semibold text-ink-soft">Latin honors</h2>
              <p className="mt-1">
                {honorsLabel(report.latinHonors) ? (
                  <Stamp tone="signal">{honorsLabel(report.latinHonors)}</Stamp>
                ) : (
                  <span className="text-label text-ink-soft">Projected: not yet</span>
                )}
              </p>
            </section>
          </div>

          {report.terms.length > 0 ? (
            <section className="mt-8">
              <h2 className="font-display text-title font-semibold">By term</h2>
              <div className="mt-3">
                <LedgerTable>
                  <LedgerHead
                    columns={[
                      { label: "Term" },
                      { label: "GWA", align: "right" },
                      { label: "Units", align: "right" },
                      { label: "Entries", align: "right" },
                      { label: "INC", align: "right" },
                    ]}
                  />
                  <tbody>
                    {report.terms.map((row) => (
                      <LedgerRow key={row.termId}>
                        <LedgerCell className="figure font-semibold">{row.termCode}</LedgerCell>
                        <LedgerCell align="right">{gwaText(row.gwa)}</LedgerCell>
                        <LedgerCell align="right">{units(row.units)}</LedgerCell>
                        <LedgerCell align="right">{row.entries}</LedgerCell>
                        <LedgerCell align="right" className={row.incCount > 0 ? "text-stamp" : ""}>
                          {row.incCount}
                        </LedgerCell>
                      </LedgerRow>
                    ))}
                  </tbody>
                </LedgerTable>
              </div>
            </section>
          ) : null}
        </>
      ) : null}

      <section className="mt-10">
        <h2 className="font-display text-title font-semibold">Grade ledger</h2>
        <p className="mt-1 text-label text-ink-soft">
          Every posted grade, including superseded versions (kept for the record).
        </p>
        <div className="mt-3">
          {ledgerQuery.isLoading ? (
            <SkeletonRows rows={6} />
          ) : entries.length === 0 ? (
            <p className="border border-rule bg-surface px-4 py-6 text-body text-ink-soft">
              No grades posted yet.
            </p>
          ) : (
            <LedgerTable>
              <LedgerHead
                columns={[
                  { label: "Term" },
                  { label: "Course" },
                  { label: "Section" },
                  { label: "Grade", align: "right" },
                  { label: "Remark" },
                  { label: "Status" },
                ]}
              />
              <tbody>
                {entries
                  .slice()
                  .sort(
                    (left, right) =>
                      left.term.code.localeCompare(right.term.code) ||
                      left.course.code.localeCompare(right.course.code) ||
                      left.version - right.version,
                  )
                  .map((entry) => {
                    const remark = gradeRemark(entry.value, entry.isInc);
                    const superseded = entry.status === "SUPERSEDED";
                    return (
                      <LedgerRow key={entry.id}>
                        <LedgerCell className={`figure ${superseded ? "opacity-60" : ""}`}>
                          {entry.term.code}
                        </LedgerCell>
                        <LedgerCell className={superseded ? "opacity-60" : ""}>
                          <span className="font-display font-semibold">{entry.course.code}</span>
                          <span className="ml-2 text-ink-soft">{entry.course.title}</span>
                        </LedgerCell>
                        <LedgerCell className={`figure ${superseded ? "opacity-60" : ""}`}>
                          {entry.section?.sectionCode ?? "—"}
                        </LedgerCell>
                        <LedgerCell align="right" className={superseded ? "opacity-60" : ""}>
                          {entry.value ?? "—"}
                        </LedgerCell>
                        <LedgerCell className={superseded ? "opacity-60" : ""}>
                          {entry.isInc && entry.incDeadlineAt ? (
                            <span className="text-stamp">
                              INC · due {formatDate(entry.incDeadlineAt)}
                            </span>
                          ) : remark ? (
                            <span className="text-stamp">{remark}</span>
                          ) : (
                            ""
                          )}
                        </LedgerCell>
                        <LedgerCell>
                          {superseded ? (
                            <span className="text-micro text-ink-soft">Superseded v{entry.version}</span>
                          ) : (
                            <StatusMark cue="solid">
                              {entry.status === "POSTED" ? "Posted" : entry.status.toLowerCase()}
                            </StatusMark>
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
    </div>
  );
}
