import { describe, expect, it } from "vitest";
import { fromJobData, jobIdFor, toJobData } from "./score-queue.js";
import type { TriageEmail } from "../core/types.js";

describe("job payload", () => {
  const email: TriageEmail = {
    gmailId: "18c2f0a1b2",
    threadId: null,
    sender: "A <a@b.com>",
    senderEmail: "a@b.com",
    subject: "hi",
    bodySnippet: null,
    receivedAt: new Date("2026-09-29T12:00:00Z"),
    headers: { "list-id": "<x>" },
  };

  it("round-trips through JSON with the Date intact", () => {
    const restored = fromJobData(JSON.parse(JSON.stringify(toJobData(email))));
    expect(restored).toEqual(email);
    expect(restored.receivedAt).toBeInstanceOf(Date);
  });

  it("derives a non-numeric job id from gmail_id, even for an all-digit id", () => {
    expect(jobIdFor("12345")).toBe("gmail-12345");
    expect(Number.isNaN(Number(jobIdFor("12345")))).toBe(true);
  });
});
