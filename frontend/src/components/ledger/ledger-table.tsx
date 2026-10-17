import type { ReactNode } from "react";

export function LedgerTable({ caption, children }: { caption?: string; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-body">
        {caption ? (
          <caption className="pb-2 text-left text-label font-semibold text-ink-soft">
            {caption}
          </caption>
        ) : null}
        {children}
      </table>
    </div>
  );
}

export interface LedgerColumn {
  label: string;
  align?: "left" | "right";
}

export function LedgerHead({ columns }: { columns: LedgerColumn[] }) {
  return (
    <thead>
      <tr className="border-b-2 border-ink">
        {columns.map((column, index) => (
          <th
            key={index}
            scope="col"
            className={`pb-2 text-label font-semibold text-ink-soft ${
              column.align === "right" ? "text-right" : "text-left"
            }`}
          >
            {column.label}
          </th>
        ))}
      </tr>
    </thead>
  );
}

export function LedgerRow({ children }: { children: ReactNode }) {
  return <tr className="border-b border-rule align-baseline">{children}</tr>;
}

export function LedgerCell({
  children,
  align = "left",
  className = "",
}: {
  children: ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <td className={`py-2 ${align === "right" ? "figure text-right" : ""} ${className}`}>
      {children}
    </td>
  );
}

export function LedgerTotalRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <tfoot>
      <tr className="border-t-2 border-ink">
        <td colSpan={99} className="py-2">
          <div className="flex items-baseline justify-between">
            <span className="text-label font-semibold text-ink-soft">{label}</span>
            <span className="figure font-display text-body font-semibold">{children}</span>
          </div>
        </td>
      </tr>
    </tfoot>
  );
}
