"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { LedgerCell, LedgerHead, LedgerRow, LedgerTable } from "@/components/ledger/ledger-table";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { SkeletonRows } from "@/components/ui/skeleton";
import { documentMark, StatusMark } from "@/components/ui/status-mark";
import { codeCopy, messageFor } from "@/lib/api/errors";
import { fetchDocuments, fetchDownloadUrl, requestDocument } from "@/lib/api/endpoints";
import {
  DOCUMENT_TYPE_LABELS,
  OFFICIAL_DOCUMENT_TYPES,
  REQUESTABLE_DOCUMENT_TYPES,
  type DocumentTypeValue,
} from "@/lib/api/types";
import { useAuth } from "@/lib/auth/use-auth";
import { useStepUp } from "@/lib/auth/use-step-up";
import { formatDateTime } from "@/lib/format";
import { useCurrentTerm, useTerms } from "@/lib/hooks/use-current-term";
import { useIdempotentAction } from "@/lib/hooks/use-idempotent-action";

export default function DocumentsPage() {
  const { studentId } = useAuth();
  const { withStepUp } = useStepUp();
  const queryClient = useQueryClient();
  const { term } = useCurrentTerm();
  const termsQuery = useTerms();
  const [type, setType] = useState<DocumentTypeValue>("COR");
  const [termId, setTermId] = useState<string>("");
  const [notice, setNotice] = useState<string | null>(null);

  const documentsQuery = useQuery({
    queryKey: ["documents", studentId],
    queryFn: () => fetchDocuments(studentId!),
    enabled: Boolean(studentId),
    refetchInterval: (query) => {
      const rows = query.state.data ?? [];
      return rows.some((row) => row.status === "QUEUED" || row.status === "PROCESSING")
        ? 5_000
        : false;
    },
  });

  const requestAction = useIdempotentAction((key, input: { type: DocumentTypeValue; termId?: string }) =>
    withStepUp(() => requestDocument(input, key)),
  );

  const downloadMutation = useMutation({
    mutationFn: (id: string) =>
      withStepUp(async () => {
        const result = await fetchDownloadUrl(id);
        window.open(result.url, "_blank", "noopener");
      }),
    onError: (error) => setNotice(messageFor(error)),
  });

  const rows = documentsQuery.data ?? [];
  const activeTermId = termId || term?.id || "";
  const isOfficial = OFFICIAL_DOCUMENT_TYPES.includes(type);

  const onRequest = async () => {
    setNotice(null);
    try {
      await requestAction.run({
        type,
        ...(activeTermId ? { termId: activeTermId } : {}),
      });
      setNotice("Request submitted. It will appear here as it is processed.");
      await queryClient.invalidateQueries({ queryKey: ["documents", studentId] });
    } catch {
      // requestAction.error renders below.
    }
  };

  const requestError = requestAction.error;
  const requestCopy = requestError ? codeCopy(requestError.code) : null;

  return (
    <div>
      <h1 className="font-display text-display-3 font-semibold">Documents</h1>
      <div className="mt-2 border-t-2 border-ink" />

      <section className="mt-6">
        <h2 className="font-display text-title font-semibold">Request a document</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <label className="block">
            <span className="block text-label font-semibold">Document type</span>
            <select
              className="mt-1 w-full border border-ink bg-surface px-3 py-2 text-body"
              value={type}
              onChange={(event) => setType(event.target.value as DocumentTypeValue)}
            >
              {REQUESTABLE_DOCUMENT_TYPES.map((value) => (
                <option key={value} value={value}>
                  {DOCUMENT_TYPE_LABELS[value]}
                  {OFFICIAL_DOCUMENT_TYPES.includes(value) ? " — official" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-label font-semibold">Term (optional)</span>
            <select
              className="mt-1 w-full border border-ink bg-surface px-3 py-2 text-body"
              value={activeTermId}
              onChange={(event) => setTermId(event.target.value)}
            >
              <option value="">No specific term</option>
              {(termsQuery.data ?? []).map((row) => (
                <option key={row.id} value={row.id}>
                  {row.code}
                </option>
              ))}
            </select>
          </label>
          <Button
            variant="primary"
            disabled={requestAction.pending || downloadMutation.isPending}
            onClick={() => void onRequest()}
          >
            {requestAction.pending ? "Requesting…" : "Request"}
          </Button>
        </div>
        <p className="mt-2 text-micro text-ink-soft">
          {isOfficial
            ? "Official documents need a clean clearance — a hold blocks their download until the cashier lifts it."
            : "Unofficial documents are delivered as soon as processing finishes."}
        </p>
        {notice ? (
          <div className="mt-3">
            <Banner tone="ledger" title={notice} />
          </div>
        ) : null}
        {requestError && requestCopy ? (
          <div className="mt-3">
            <Banner tone="stamp" title={requestCopy.message}>
              {requestCopy.action}
            </Banner>
          </div>
        ) : null}
      </section>

      <section className="mt-10">
        <h2 className="font-display text-title font-semibold">Your requests</h2>
        <div className="mt-3">
          {documentsQuery.isLoading ? (
            <SkeletonRows rows={5} />
          ) : rows.length === 0 ? (
            <p className="border border-rule bg-surface px-4 py-6 text-body text-ink-soft">
              No document requests yet.
            </p>
          ) : (
            <LedgerTable>
              <LedgerHead
                columns={[
                  { label: "Document" },
                  { label: "Requested" },
                  { label: "Status" },
                  { label: "Serial" },
                  { label: "", align: "right" },
                ]}
              />
              <tbody>
                {rows.map((row) => {
                  const mark = documentMark(row.status);
                  return (
                    <LedgerRow key={row.id}>
                      <LedgerCell>
                        <Link
                          href={`/documents/${row.id}`}
                          className="font-display font-semibold underline decoration-rule underline-offset-4 hover:decoration-ink"
                        >
                          {DOCUMENT_TYPE_LABELS[row.type]}
                        </Link>
                      </LedgerCell>
                      <LedgerCell className="figure whitespace-nowrap text-ink-soft">
                        {formatDateTime(row.requestedAt)}
                      </LedgerCell>
                      <LedgerCell>
                        <StatusMark cue={mark.cue}>{mark.label}</StatusMark>
                      </LedgerCell>
                      <LedgerCell className="figure text-ink-soft">{row.serialNo ?? "—"}</LedgerCell>
                      <LedgerCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Link href={`/documents/${row.id}`} className="text-body underline">
                            Open
                          </Link>
                          {row.status === "READY" ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={downloadMutation.isPending}
                              onClick={() => downloadMutation.mutate(row.id)}
                            >
                              Download
                            </Button>
                          ) : null}
                        </div>
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
