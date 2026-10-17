import type { ReactNode } from "react";

type BannerTone = "neutral" | "stamp" | "ledger" | "signal";

interface BannerProps {
  tone?: BannerTone;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}

const TONE_CLASSES: Record<BannerTone, string> = {
  neutral: "border-rule bg-surface",
  stamp: "border-stamp bg-surface",
  ledger: "border-ledger bg-surface",
  signal: "border-signal bg-surface",
};

const TONE_TEXT: Record<BannerTone, string> = {
  neutral: "text-ink",
  stamp: "text-stamp",
  ledger: "text-ledger",
  signal: "text-ink",
};

export function Banner({ tone = "neutral", title, children, action }: BannerProps) {
  return (
    <div className={`border ${TONE_CLASSES[tone]} px-4 py-3`}>
      <p className={`font-display text-body font-semibold ${TONE_TEXT[tone]}`}>{title}</p>
      {children ? <div className="mt-1 text-body text-ink-soft">{children}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
