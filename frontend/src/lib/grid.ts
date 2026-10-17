export const GRID_START_MIN = 420;
export const GRID_END_MIN = 1200;
export const SLOT_MIN = 30;
export const GRID_DAYS = [1, 2, 3, 4, 5];

export type BlockState = "enrolled" | "candidate" | "waitlisted" | "conflict" | "open";

export interface GridBlock {
  id: string;
  label: string;
  sublabel?: string;
  day: number;
  startMin: number;
  endMin: number;
  state: BlockState;
}

export interface TimeSlice {
  day: number;
  startMin: number;
  endMin: number;
}

export function overlaps(a: TimeSlice, b: TimeSlice): boolean {
  return a.day === b.day && a.startMin < b.endMin && b.startMin < a.endMin;
}

const CONFLICTING_STATES: BlockState[] = ["enrolled", "candidate"];

export function findConflicts(blocks: GridBlock[]): Set<string> {
  const active = blocks.filter((block) => CONFLICTING_STATES.includes(block.state));
  const flagged = new Set<string>();
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      if (overlaps(active[i], active[j])) {
        flagged.add(active[i].id);
        flagged.add(active[j].id);
      }
    }
  }
  return flagged;
}

export function slotIndex(min: number): number {
  return (min - GRID_START_MIN) / SLOT_MIN;
}

export interface BlockLayout {
  rowStart: number;
  rowSpan: number;
  clipped: boolean;
}

export function blockLayout(block: TimeSlice): BlockLayout {
  const start = Math.max(block.startMin, GRID_START_MIN);
  const end = Math.min(block.endMin, GRID_END_MIN);
  const rowStart = slotIndex(start) + 1;
  const rowSpan = Math.max(1, (end - start) / SLOT_MIN);
  const clipped = block.startMin < GRID_START_MIN || block.endMin > GRID_END_MIN;
  return { rowStart, rowSpan, clipped };
}

export function gridRowCount(): number {
  return (GRID_END_MIN - GRID_START_MIN) / SLOT_MIN;
}

export function gridSlotLabels(): number[] {
  const labels: number[] = [];
  for (let min = GRID_START_MIN; min < GRID_END_MIN; min += SLOT_MIN) {
    labels.push(min);
  }
  return labels;
}
