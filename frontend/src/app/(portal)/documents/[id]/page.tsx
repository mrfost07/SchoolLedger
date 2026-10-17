"use client";

import { use, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { SkeletonRows } from "@/components/ui/skeleton";
import { documentMark, StatusMark } from "@/components/ui/status-mark";
import { messageFor } from "@/lib/api/errors";
import { fetchDocument, fetchDownloadUrl } from "@/lib/api/endpoints";
import { DOCUMENT_TYPE_LABELS, OFFICIAL_DOCUMENT_TYPES } from "@/lib/api/types";
import { useStepUp } from "@/lib/auth/use-step-up";
import { formatDateTime } from "@/lib/format";

interface Step {
  label: string;
  at: string | null;
}

export default function DocumentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { withStepUp } = useStepUp();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);

  const documentQuery = useQuery({
    queryKey: ["document", id],
    queryFn: () => fetchDocument(id),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "QUEUED" || status === "PROCESSING" ? 4_000 : false;
    },
  });

  const downloadMutation = useMutation({
    mutationFn: () =>
      withStepUp(async () => {
        const result = await fetchDownloadUrl(id);
        window.open(result.url, "_blank", "noopener");
      }),
    onError: (error) => setNotice(messageFor(error)),
  });

  const row = documentQuery.data;

  if (documentQuery.isLoading) {
    return <SkeletonRows rows={6} />;
  }

  if (documentQuery.isError || !row) {
    return (
      <div>
        <Link href="/documents" className="text-body underline">
          ← Documents
        </Link>
        <p className="mt-4 border border-rule bg-surface px-4 py-6 text-body text-ink-soft">
          That document request could not be found.
        </p>
      </div>
    );
  }

  const mark = documentMark(row.status);
  const isOfficial = OFFICIAL_DOCUMENT_TYPES.includes(row.type);
  const steps: Step[] = [
    { label: "Requested", at: row.requestedAt },
    { label: "Processing", at: row.processingAt },
    { label: "Ready", at: row.readyAt },
    { label: "Expires", at: row.expiresAt },
  ];

  return (
    <div className="max-w-2xl">
      <Link href="/documents" className="text-body underline">
        ← Documents
      </Link>
      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-display text-display-3 font-semibold">
          {DOCUMENT_TYPE_LABELS[row.type]}
        </h1>
        <StatusMark cue={mark.cue}>{mark.label}</StatusMark>
      </div>
      <div className="mt-2 border-t-2 border-ink" />
      {isOfficial ? (
        <p className="mt-2 text-micro text-ink-soft">
          Official document — downloads are blocked while any clearance hold is active. A hold must
          be lifted at the cashier before this copy can be downloaded.
        </p>
      ) : null}

      {notice ? (
        <div className="mt-4">
          <Banner tone="stamp" title={notice} />
        </div>
      ) : null}

      {row.status === "FAILED" && row.failureReason ? (
        <div className="mt-4">
          <Banner tone="stamp" title="Processing failed">
            {row.failureReason}
          </Banner>
        </div>
      ) : null}

      <section className="mt-6">
        <h2 className="text-label font-semibold text-ink-soft">Timeline</h2>
        <ol className="mt-2">
          {steps.map((step) => (
            <li key={step.label} className="rule-y flex items-baseline justify-between py-2">
              <span className="text-body">{step.label}</span>
              <span className="figure text-body text-ink-soft">{formatDateTime(step.at)}</span>
            </li>
          ))}
          {row.revokedAt ? (
            <li className="rule-y flex items-baseline justify-between py-2">
              <span className="text-body text-stamp">Revoked</span>
              <span className="figure text-body text-stamp">{formatDateTime(row.revokedAt)}</span>
            </li>
          ) : null}
        </ol>
      </section>

      <section className="mt-6 grid grid-cols-2 gap-4 text-body">
        <div>
          <h2 className="text-label font-semibold text-ink-soft">Serial no.</h2>
          <p className="figure mt-1">{row.serialNo ?? "—"}</p>
        </div>
        <div>
          <h2 className="text-label font-semibold text-ink-soft">Downloads</h2>
          <p className="figure mt-1">{row.downloadCount}</p>
        </div>
        <div>
          <h2 className="text-label font-semibold text-ink-soft">Pages</h2>
          <p className="figure mt-1">{row.pageCount ?? "—"}</p>
        </div>
        <div>
          <h2 className="text-label font-semibold text-ink-soft">File size</h2>
          <p className="figure mt-1">
            {row.fileSize ? `${Math.max(1, Math.round(row.fileSize / 1024))} KB` : "—"}
          </p>
        </div>
      </section>

      {row.serialHash ? (
        <p className="mt-6 border-t border-rule pt-3 text-micro text-ink-soft">
          Anyone can verify this copy:{" "}
          <a
            className="underline"
            href={`/api/v1/public/verify/${row.serialHash}`}
            target="_blank"
            rel="noreferrer"
          >
            open the verification page
          </a>
          .
        </p>
      ) : null}

      <div className="mt-6 flex flex-wrap gap-3">
        {row.status === "READY" ? (
          <Button
            variant="primary"
            disabled={downloadMutation.isPending}
            onClick={() => downloadMutation.mutate()}
          >
            {downloadMutation.isPending ? "Preparing…" : "Download"}
          </Button>
        ) : null}
        {row.status === "QUEUED" || row.status === "PROCESSING" ? (
          <Button variant="outline" disabled>
            Preparing…
          </Button>
        ) : null}
        <Button
          variant="ghost"
          onClick={() => void queryClient.invalidateQueries({ queryKey: ["document", id] })}
        >
          Refresh status
        </Button>
      </div>
    </div>
  );
}
