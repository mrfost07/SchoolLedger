export function termLabel(term: { schoolYear: number | string; termNo: number }): string {
  const ordinal =
    term.termNo === 1 ? "1st" : term.termNo === 2 ? "2nd" : term.termNo === 3 ? "3rd" : `${term.termNo}th`;
  return `${term.schoolYear}–${ordinal} sem`;
}

export function formatTime(min: number): string {
  const hours = Math.floor(min / 60);
  const minutes = min % 60;
  const period = hours >= 12 ? "PM" : "AM";
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${String(minutes).padStart(2, "0")} ${period}`;
}

export function formatRange(startMin: number, endMin: number): string {
  return `${formatTime(startMin)} – ${formatTime(endMin)}`;
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function dayName(day: number): string {
  return DAY_NAMES[day - 1] ?? "?";
}

export function units(value: number | string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "0";
  return Number.isInteger(parsed) ? String(parsed) : parsed.toFixed(1);
}

export function peso(amount: number | string, currency = "PHP"): string {
  return new Intl.NumberFormat("en-PH", { style: "currency", currency }).format(Number(amount));
}

export function gwa(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : "—";
}

export function gradeRemark(value: string | null | undefined, isInc: boolean): string {
  if (isInc) return "INC";
  if (value === null || value === undefined) return "";
  return Number(value) >= 5 ? "Failed" : "";
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-PH", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-PH", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
