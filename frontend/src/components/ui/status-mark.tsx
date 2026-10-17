export type StatusCue = "solid" | "outline" | "hatch" | "stamp" | "ledger";

interface StatusMarkProps {
  cue: StatusCue;
  children: string;
}

const CUE_CLASSES: Record<StatusCue, string> = {
  solid: "border border-ink bg-ink text-paper",
  outline: "border border-ink text-ink",
  hatch: "border border-ink bg-paper text-ink hatch",
  stamp: "border border-stamp text-stamp",
  ledger: "border border-ledger text-ledger",
};

export function StatusMark({ cue, children }: StatusMarkProps) {
  return (
    <span
      className={`inline-block px-2 py-0.5 font-display text-micro font-semibold ${CUE_CLASSES[cue]}`}
    >
      {children}
    </span>
  );
}

export function itemMark(status: string): { cue: StatusCue; label: string } {
  switch (status) {
    case "ENROLLED":
      return { cue: "solid", label: "Enrolled" };
    case "WAITLISTED":
      return { cue: "hatch", label: "Waitlisted" };
    case "DROPPED":
      return { cue: "outline", label: "Dropped" };
    default:
      return { cue: "outline", label: status };
  }
}

export function assessmentMark(status: string): { cue: StatusCue; label: string } {
  switch (status) {
    case "PAID":
      return { cue: "ledger", label: "Paid" };
    case "ASSESSED":
      return { cue: "stamp", label: "Unpaid" };
    case "VOID":
      return { cue: "outline", label: "Void" };
    default:
      return { cue: "outline", label: status };
  }
}

export function documentMark(status: string): { cue: StatusCue; label: string } {
  switch (status) {
    case "QUEUED":
      return { cue: "outline", label: "Queued" };
    case "PROCESSING":
      return { cue: "hatch", label: "Processing" };
    case "READY":
      return { cue: "ledger", label: "Ready" };
    case "FAILED":
      return { cue: "stamp", label: "Failed" };
    case "EXPIRED":
      return { cue: "outline", label: "Expired" };
    case "REVOKED":
      return { cue: "stamp", label: "Revoked" };
    default:
      return { cue: "outline", label: status };
  }
}
