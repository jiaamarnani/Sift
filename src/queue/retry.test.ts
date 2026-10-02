import { describe, expect, it } from "vitest";
import { backoffDelay, isRetryable } from "./retry.js";
import { ProviderError } from "../scoring/provider.js";
import { ScoreParseError } from "../scoring/scorer.js";
import { MissingCriteriaError } from "../pipeline/queries.js";

const opts = { baseMs: 1000, maxMs: 60_000 };
const noJitter = () => 0.5; // 0.8 + 0.5 * 0.4 = 1.0

describe("backoffDelay", () => {
  it("doubles from the base delay each attempt", () => {
    expect([1, 2, 3, 4].map((n) => backoffDelay(n, new Error("x"), opts, noJitter))).toEqual([
      1000, 2000, 4000, 8000,
    ]);
  });

  it("caps at maxMs", () => {
    expect(backoffDelay(20, new Error("x"), opts, noJitter)).toBe(60_000);
  });

  it("jitters within ±20%", () => {
    expect(backoffDelay(1, new Error("x"), opts, () => 0)).toBe(800);
    expect(backoffDelay(1, new Error("x"), opts, () => 0.999999)).toBe(1200);
  });

  it("waits exactly what the provider asked for, plus a margin, ignoring the attempt count", () => {
    const err = new ProviderError("429", "gemini", true, 429, 32_852);
    expect(backoffDelay(1, err, opts, noJitter)).toBe(33_102);
    expect(backoffDelay(4, err, opts, noJitter)).toBe(33_102);
  });

  it("still caps a provider-requested delay at maxMs", () => {
    const err = new ProviderError("429", "gemini", true, 429, 10 * 60_000);
    expect(backoffDelay(1, err, opts)).toBe(60_000);
  });

  it("falls back to exponential when the error has no retryAfterMs", () => {
    const err = new ProviderError("503", "gemini", true, 503);
    expect(backoffDelay(3, err, opts, noJitter)).toBe(4000);
  });

  it("handles an undefined error", () => {
    expect(backoffDelay(1, undefined, opts, noJitter)).toBe(1000);
  });
});

describe("isRetryable", () => {
  it.each([
    ["a 429", new ProviderError("x", "gemini", true, 429), true],
    ["a 401", new ProviderError("x", "gemini", false, 401), false],
    ["invalid model output after re-prompt", new ScoreParseError("x", "raw"), false],
    ["missing criteria", new MissingCriteriaError(), false],
    ["an unknown error (e.g. Postgres reset)", new Error("ECONNRESET"), true],
    ["a non-Error throw", "boom", true],
  ])("%s -> %s", (_label, err, expected) => {
    expect(isRetryable(err)).toBe(expected);
  });
});
