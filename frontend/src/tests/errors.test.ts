import { describe, expect, it } from "vitest";
import { ApiError, codeCopy, isApiError, messageFor, toApiError } from "@/lib/api/errors";

describe("ApiError", () => {
  it("derives fields from a problem document", () => {
    const error = new ApiError({ code: "SECTION_FULL", detail: "Section is full.", status: 409 });
    expect(error.code).toBe("SECTION_FULL");
    expect(error.status).toBe(409);
    expect(error.message).toBe("Section is full.");
    expect(isApiError(error)).toBe(true);
  });

  it("defaults to an internal error shape", () => {
    const error = new ApiError();
    expect(error.code).toBe("INTERNAL_ERROR");
    expect(error.status).toBe(500);
  });
});

describe("toApiError", () => {
  it("wraps a problem object", () => {
    const error = toApiError({ code: "RATE_LIMITED", detail: "Slow down." }, 429);
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.status).toBe(429);
  });

  it("uses the provided status when the problem has none", () => {
    expect(toApiError({}, 404).status).toBe(404);
  });

  it("passes through existing ApiError instances", () => {
    const original = new ApiError({ code: "NOT_FOUND" });
    expect(toApiError(original, 500)).toBe(original);
  });

  it("wraps non-object errors", () => {
    expect(toApiError("boom", 500).code).toBe("INTERNAL_ERROR");
  });
});

describe("codeCopy", () => {
  it("returns curated copy with an action", () => {
    expect(codeCopy("SECTION_FULL").action).toContain("waitlist");
    expect(codeCopy("STUDENT_CLEARANCE_HOLD").message).toContain("Clearance hold");
  });

  it("falls back for unknown and missing codes", () => {
    expect(codeCopy("SOMETHING_NEW").message).toBe("Request failed.");
    expect(codeCopy(undefined).message).toContain("Something failed");
  });
});

describe("messageFor", () => {
  it("maps known API codes to copy", () => {
    const error = new ApiError({ code: "MAX_UNITS_EXCEEDED", status: 409 });
    expect(messageFor(error)).toBe("That load is over the maximum for the term.");
  });

  it("uses plain Error messages as-is", () => {
    expect(messageFor(new Error("plain failure"))).toBe("plain failure");
  });

  it("handles unknown values", () => {
    expect(messageFor(42)).toBe("Request failed.");
  });
});
