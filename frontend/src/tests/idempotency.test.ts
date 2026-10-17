import { describe, expect, it } from "vitest";
import { createIdempotencyStore, currentKey, resetKey } from "@/lib/api/idempotency";
import { pickCurrentTerm } from "@/lib/hooks/use-current-term";
import type { TermRow } from "@/lib/api/types";

describe("idempotency store", () => {
  it("returns a stable key across calls", () => {
    const store = createIdempotencyStore();
    const first = currentKey(store);
    expect(first.length).toBeGreaterThan(0);
    expect(currentKey(store)).toBe(first);
  });

  it("mints a new key after a reset", () => {
    const store = createIdempotencyStore();
    const first = currentKey(store);
    resetKey(store);
    expect(currentKey(store)).not.toBe(first);
  });

  it("keeps stores independent", () => {
    const a = createIdempotencyStore();
    const b = createIdempotencyStore();
    expect(currentKey(a)).not.toBe(currentKey(b));
  });
});

function term(partial: Partial<TermRow> & Pick<TermRow, "id" | "startsAt">): TermRow {
  return {
    code: partial.code ?? partial.id,
    schoolYear: 2026,
    termNo: 1,
    status: "ONGOING",
    endsAt: "2026-12-20T00:00:00.000Z",
    enrollmentStartAt: "2026-08-01T00:00:00.000Z",
    addDropEndAt: "2026-09-01T00:00:00.000Z",
    gradingStartAt: "2026-12-01T00:00:00.000Z",
    gradingEndAt: "2026-12-15T00:00:00.000Z",
    ...partial,
  } as TermRow;
}

describe("pickCurrentTerm", () => {
  it("prefers a term in ENROLLMENT", () => {
    const chosen = pickCurrentTerm([
      term({ id: "t1", startsAt: "2026-06-01T00:00:00.000Z", status: "ONGOING" }),
      term({ id: "t2", startsAt: "2026-08-01T00:00:00.000Z", status: "ENROLLMENT" }),
    ]);
    expect(chosen?.id).toBe("t2");
  });

  it("falls back to ADD_DROP", () => {
    const chosen = pickCurrentTerm([
      term({ id: "t1", startsAt: "2026-06-01T00:00:00.000Z", status: "ONGOING" }),
      term({ id: "t2", startsAt: "2026-08-01T00:00:00.000Z", status: "ADD_DROP" }),
    ]);
    expect(chosen?.id).toBe("t2");
  });

  it("falls back to the latest start date", () => {
    const chosen = pickCurrentTerm([
      term({ id: "t1", startsAt: "2026-01-05T00:00:00.000Z", status: "CLOSED" }),
      term({ id: "t2", startsAt: "2026-08-01T00:00:00.000Z", status: "GRADING" }),
    ]);
    expect(chosen?.id).toBe("t2");
  });

  it("returns null for an empty list", () => {
    expect(pickCurrentTerm([])).toBeNull();
  });
});
