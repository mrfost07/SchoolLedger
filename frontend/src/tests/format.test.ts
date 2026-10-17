import { describe, expect, it } from "vitest";
import {
  dayName,
  formatDate,
  formatDateTime,
  formatRange,
  formatTime,
  gradeRemark,
  gwa,
  peso,
  termLabel,
  units,
} from "@/lib/format";

describe("termLabel", () => {
  it("formats the school year and semester", () => {
    expect(termLabel({ schoolYear: 2026, termNo: 1 })).toBe("2026–1st sem");
    expect(termLabel({ schoolYear: 2026, termNo: 2 })).toBe("2026–2nd sem");
    expect(termLabel({ schoolYear: 2026, termNo: 3 })).toBe("2026–3rd sem");
  });

  it("accepts string school years", () => {
    expect(termLabel({ schoolYear: "2025", termNo: 2 })).toBe("2025–2nd sem");
  });
});

describe("time formatting", () => {
  it("formats minutes as 12-hour time", () => {
    expect(formatTime(420)).toBe("7:00 AM");
    expect(formatTime(750)).toBe("12:30 PM");
    expect(formatTime(1200)).toBe("8:00 PM");
  });

  it("formats ranges", () => {
    expect(formatRange(480, 570)).toBe("8:00 AM – 9:30 AM");
  });

  it("names days with Monday as 1", () => {
    expect(dayName(1)).toBe("Mon");
    expect(dayName(5)).toBe("Fri");
    expect(dayName(6)).toBe("Sat");
    expect(dayName(0)).toBe("?");
  });
});

describe("numbers", () => {
  it("formats unit values", () => {
    expect(units(3)).toBe("3");
    expect(units("3.5")).toBe("3.5");
    expect(units("not-a-number")).toBe("0");
  });

  it("formats peso amounts", () => {
    expect(peso("1234.50")).toContain("1,234.50");
    expect(peso(0)).toContain("0.00");
  });

  it("formats GWA values", () => {
    expect(gwa("1.4567")).toBe("1.46");
    expect(gwa(null)).toBe("—");
    expect(gwa(undefined)).toBe("—");
  });

  it("labels failing and incomplete grades", () => {
    expect(gradeRemark("5.00", false)).toBe("Failed");
    expect(gradeRemark("1.50", false)).toBe("");
    expect(gradeRemark("2.00", true)).toBe("INC");
    expect(gradeRemark(null, false)).toBe("");
  });
});

describe("dates", () => {
  it("formats ISO dates", () => {
    expect(formatDate("2026-08-15T00:00:00.000Z")).toContain("2026");
    expect(formatDate("2026-08-15T00:00:00.000Z")).toContain("Aug");
  });

  it("falls back for null and invalid values", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate("not-a-date")).toBe("—");
    expect(formatDateTime(undefined)).toBe("—");
  });
});
