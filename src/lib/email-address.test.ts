import { describe, expect, it } from "vitest";
import {
  matchesSenderPattern,
  normalizeAddress,
  parseFromHeader,
  splitAddress,
} from "./email-address.js";

describe("parseFromHeader", () => {
  it("parses a bare address", () => {
    expect(parseFromHeader("jane@corp.com")).toEqual({
      displayName: null,
      address: "jane@corp.com",
    });
  });

  it("parses angle-bracket form with a display name", () => {
    expect(parseFromHeader("Jane Doe <jane@corp.com>")).toEqual({
      displayName: "Jane Doe",
      address: "jane@corp.com",
    });
  });

  it("parses angle brackets with no display name", () => {
    expect(parseFromHeader("<jane@corp.com>")).toEqual({
      displayName: null,
      address: "jane@corp.com",
    });
  });

  it("strips quotes from a display name containing a comma", () => {
    expect(parseFromHeader('"Doe, Jane" <jane@corp.com>')).toEqual({
      displayName: "Doe, Jane",
      address: "jane@corp.com",
    });
  });

  it("unescapes a quoted-pair inside a display name", () => {
    expect(parseFromHeader(String.raw`"Jane \"JD\" Doe" <jane@corp.com>`)).toEqual({
      displayName: 'Jane "JD" Doe',
      address: "jane@corp.com",
    });
  });

  it("lowercases the address but preserves display-name case", () => {
    expect(parseFromHeader("Jane Doe <JANE@Corp.COM>")).toEqual({
      displayName: "Jane Doe",
      address: "jane@corp.com",
    });
  });

  it("uses the last angle-bracket pair so a bracketed display name cannot capture the address", () => {
    expect(parseFromHeader("Recruiting <team> <careers@corp.com>").address).toBe(
      "careers@corp.com",
    );
  });

  it("returns an empty address for null, undefined, and blank input", () => {
    for (const input of [null, undefined, "", "   "]) {
      expect(parseFromHeader(input).address).toBe("");
    }
  });

  it("does not throw on a malformed header", () => {
    expect(() => parseFromHeader("Jane Doe <unclosed")).not.toThrow();
    expect(parseFromHeader("Jane Doe <unclosed").address).toBe("jane doe <unclosed");
  });
});

describe("normalizeAddress", () => {
  it("lowercases, trims, and strips angle brackets", () => {
    expect(normalizeAddress("  <JANE@Corp.COM> ")).toBe("jane@corp.com");
  });
});

describe("splitAddress", () => {
  it("splits a normal address", () => {
    expect(splitAddress("jane@corp.com")).toEqual({ localPart: "jane", domain: "corp.com" });
  });

  it("splits at the last @ when the local part contains one", () => {
    expect(splitAddress("jane@old@corp.com")).toEqual({
      localPart: "jane@old",
      domain: "corp.com",
    });
  });

  it("returns empty parts for input with no usable @", () => {
    for (const input of ["", "notanemail", "@corp.com", "jane@"]) {
      expect(splitAddress(input)).toEqual({ localPart: "", domain: "" });
    }
  });
});

describe("matchesSenderPattern", () => {
  it("matches a domain pattern with a leading @", () => {
    expect(matchesSenderPattern("prof@northeastern.edu", "@northeastern.edu")).toBe(true);
    expect(matchesSenderPattern("prof@mit.edu", "@northeastern.edu")).toBe(false);
  });

  it("matches subdomains of a domain pattern", () => {
    // Universities and ATS vendors route through subdomains constantly.
    expect(matchesSenderPattern("prof@cs.northeastern.edu", "@northeastern.edu")).toBe(true);
    expect(matchesSenderPattern("x@mail.substack.com", "@substack.com")).toBe(true);
  });

  it("does not match a domain that merely ends with the pattern text", () => {
    // notnortheastern.edu must not match @northeastern.edu
    expect(matchesSenderPattern("x@notnortheastern.edu", "@northeastern.edu")).toBe(false);
  });

  it("matches a bare domain pattern the same as a leading-@ one", () => {
    expect(matchesSenderPattern("x@substack.com", "substack.com")).toBe(true);
    expect(matchesSenderPattern("x@mail.substack.com", "substack.com")).toBe(true);
  });

  it("matches a local-part pattern on any domain", () => {
    expect(matchesSenderPattern("careers@bigco.com", "careers@")).toBe(true);
    expect(matchesSenderPattern("careers@startup.io", "careers@")).toBe(true);
  });

  it("requires the local part to match exactly, not as a prefix", () => {
    // "careers-noreply@" is a different mailbox than "careers@".
    expect(matchesSenderPattern("careers-noreply@bigco.com", "careers@")).toBe(false);
    expect(matchesSenderPattern("careersandmore@bigco.com", "careers@")).toBe(false);
  });

  it("matches an exact full address", () => {
    expect(matchesSenderPattern("noreply@medium.com", "noreply@medium.com")).toBe(true);
    expect(matchesSenderPattern("other@medium.com", "noreply@medium.com")).toBe(false);
  });

  it("is case insensitive on both sides", () => {
    expect(matchesSenderPattern("PROF@Northeastern.EDU", "@NORTHEASTERN.edu")).toBe(true);
  });

  it("returns false for empty address or pattern", () => {
    expect(matchesSenderPattern("", "@corp.com")).toBe(false);
    expect(matchesSenderPattern("jane@corp.com", "")).toBe(false);
    expect(matchesSenderPattern("jane@corp.com", "   ")).toBe(false);
  });
});
