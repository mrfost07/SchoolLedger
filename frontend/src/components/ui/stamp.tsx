import type { ReactNode } from "react";

type StampTone = "ink" | "stamp" | "ledger" | "signal";

interface StampProps {
  tone?: StampTone;
  children: ReactNode;
  className?: string;
}

const TONE_CLASSES: Record<StampTone, string> = {
  ink: "border-ink text-ink",
  stamp: "border-stamp text-stamp",
  ledger: "border-ledger text-ledger",
  signal: "border-ink bg-signal text-ink",
};

export function Stamp({ tone = "ink", children, className = "" }: StampProps) {
  return (
    <span
      className={`inline-block border px-2 py-0.5 font-display text-micro font-semibold ${TONE_CLASSES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
