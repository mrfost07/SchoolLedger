import { describe, expect, it } from "vitest";
import { createKeyedSingleFlight, createSingleFlight } from "@/lib/auth/refresh-mutex";

describe("createSingleFlight", () => {
  it("dedupes concurrent calls into one invocation", async () => {
    const run = createSingleFlight<number>();
    let calls = 0;
    let resolveFn!: (value: number) => void;
    const fn = () =>
      new Promise<number>((resolve) => {
        calls += 1;
        resolveFn = resolve;
      });

    const first = run(fn);
    const second = run(fn);
    expect(calls).toBe(1);

    resolveFn(42);
    await expect(first).resolves.toBe(42);
    await expect(second).resolves.toBe(42);
  });

  it("allows a new call after settling", async () => {
    const run = createSingleFlight<number>();
    let calls = 0;
    const fn = async () => {
      calls += 1;
      return calls;
    };

    await expect(run(fn)).resolves.toBe(1);
    await expect(run(fn)).resolves.toBe(2);
  });

  it("clears the flight after a rejection", async () => {
    const run = createSingleFlight<number>();
    let calls = 0;

    await expect(
      run(() => {
        calls += 1;
        return Promise.reject(new Error("refresh failed"));
      }),
    ).rejects.toThrow("refresh failed");

    await expect(
      run(() => {
        calls += 1;
        return Promise.resolve(calls);
      }),
    ).resolves.toBe(2);
  });
});

describe("createKeyedSingleFlight", () => {
  it("dedupes per key while keeping other keys independent", async () => {
    const run = createKeyedSingleFlight<string, number>();
    let calls = 0;
    let resolveA!: (value: number) => void;
    const fnA = () =>
      new Promise<number>((resolve) => {
        calls += 1;
        resolveA = resolve;
      });
    const fnB = async () => {
      calls += 1;
      return 9;
    };

    const first = run("token-a", fnA);
    const second = run("token-a", fnA);
    expect(calls).toBe(1);

    await expect(run("token-b", fnB)).resolves.toBe(9);
    expect(calls).toBe(2);

    resolveA(7);
    await expect(first).resolves.toBe(7);
    await expect(second).resolves.toBe(7);
  });

  it("removes settled keys so later calls run again", async () => {
    const run = createKeyedSingleFlight<string, number>();
    let calls = 0;
    const fn = async () => {
      calls += 1;
      return calls;
    };

    await run("k", fn);
    await run("k", fn);
    expect(calls).toBe(2);
  });
});
