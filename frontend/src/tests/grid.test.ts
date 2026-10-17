import { describe, expect, it } from "vitest";
import {
  blockLayout,
  findConflicts,
  GRID_END_MIN,
  GRID_START_MIN,
  gridRowCount,
  gridSlotLabels,
  overlaps,
  slotIndex,
  type GridBlock,
} from "@/lib/grid";

function block(partial: Partial<GridBlock> & Pick<GridBlock, "id" | "day" | "startMin" | "endMin">): GridBlock {
  return {
    label: partial.label ?? partial.id,
    state: partial.state ?? "enrolled",
    ...partial,
  } as GridBlock;
}

describe("overlaps", () => {
  it("detects overlap on the same day", () => {
    expect(overlaps({ day: 1, startMin: 480, endMin: 570 }, { day: 1, startMin: 540, endMin: 630 })).toBe(true);
  });

  it("treats touching intervals as non-overlapping", () => {
    expect(overlaps({ day: 1, startMin: 480, endMin: 570 }, { day: 1, startMin: 570, endMin: 660 })).toBe(false);
  });

  it("ignores different days", () => {
    expect(overlaps({ day: 1, startMin: 480, endMin: 570 }, { day: 2, startMin: 480, endMin: 570 })).toBe(false);
  });
});

describe("findConflicts", () => {
  it("flags both blocks of a conflicting pair", () => {
    const blocks = [
      block({ id: "a", day: 1, startMin: 480, endMin: 570, state: "enrolled" }),
      block({ id: "b", day: 1, startMin: 540, endMin: 630, state: "candidate" }),
    ];
    expect(findConflicts(blocks)).toEqual(new Set(["a", "b"]));
  });

  it("ignores waitlisted and open blocks", () => {
    const blocks = [
      block({ id: "a", day: 1, startMin: 480, endMin: 570, state: "enrolled" }),
      block({ id: "b", day: 1, startMin: 480, endMin: 570, state: "waitlisted" }),
      block({ id: "c", day: 1, startMin: 480, endMin: 570, state: "open" }),
    ];
    expect(findConflicts(blocks).size).toBe(0);
  });

  it("returns empty for disjoint blocks", () => {
    const blocks = [
      block({ id: "a", day: 1, startMin: 480, endMin: 570 }),
      block({ id: "b", day: 1, startMin: 600, endMin: 660 }),
    ];
    expect(findConflicts(blocks).size).toBe(0);
  });
});

describe("blockLayout", () => {
  it("maps a normal block to row positions", () => {
    const layout = blockLayout({ day: 1, startMin: 480, endMin: 570 });
    expect(layout.rowStart).toBe(3);
    expect(layout.rowSpan).toBe(3);
    expect(layout.clipped).toBe(false);
  });

  it("clips blocks that start before the grid", () => {
    const layout = blockLayout({ day: 1, startMin: 360, endMin: 480 });
    expect(layout.rowStart).toBe(1);
    expect(layout.rowSpan).toBe(2);
    expect(layout.clipped).toBe(true);
  });

  it("clips blocks that end after the grid and never spans less than one row", () => {
    const layout = blockLayout({ day: 1, startMin: 1185, endMin: 1300 });
    expect(layout.clipped).toBe(true);
    expect(layout.rowSpan).toBeGreaterThanOrEqual(1);
  });
});

describe("grid geometry", () => {
  it("computes slot indexes from the grid start", () => {
    expect(slotIndex(GRID_START_MIN)).toBe(0);
    expect(slotIndex(GRID_START_MIN + 60)).toBe(2);
  });

  it("computes the row count and slot labels", () => {
    expect(gridRowCount()).toBe((GRID_END_MIN - GRID_START_MIN) / 30);
    const labels = gridSlotLabels();
    expect(labels[0]).toBe(GRID_START_MIN);
    expect(labels[labels.length - 1]).toBe(GRID_END_MIN - 30);
    expect(labels.length).toBe(gridRowCount());
  });
});
