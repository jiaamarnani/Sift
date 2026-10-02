import { describe, expect, it } from "vitest";
import { applyRules } from "./filter.js";
import type { FilterCriteria, TriageEmail } from "../core/types.js";

/* ---------------------------------------------------------------------------
 * Fixtures
 * ------------------------------------------------------------------------- */

/**
 * Build a TriageEmail with sensible defaults, overriding only what the test
 * cares about. `sender` is derived from `senderEmail` unless given, so most
 * tests set one field.
 */
function email(overrides: Partial<TriageEmail> = {}): TriageEmail {
  const senderEmail = overrides.senderEmail ?? "someone@example.com";
  return {
    gmailId: "msg_1",
    threadId: "thread_1",
    sender: overrides.sender ?? `Someone <${senderEmail}>`,
    senderEmail,
    subject: "Hello",
    bodySnippet: "Just checking in.",
    receivedAt: new Date("2026-09-29T12:00:00Z"),
    headers: {},
    ...overrides,
  };
}

const criteria: FilterCriteria = {
  blocklist: ["noreply@medium.com", "@substack.com"],
  prioritySenders: ["@northeastern.edu", "careers@"],
  keywords: ["interview", "co-op", "deadline", "recruiter", "c++"],
};

/** Criteria with no lists, for testing heuristics in isolation. */
const bareCriteria: FilterCriteria = { blocklist: [], prioritySenders: [], keywords: [] };

/* ---------------------------------------------------------------------------
 * Blocklist — highest precedence
 * ------------------------------------------------------------------------- */

describe("blocklist rule", () => {
  it("drops an exact blocklisted address", () => {
    const result = applyRules(email({ senderEmail: "noreply@medium.com" }), criteria);
    expect(result.filtered).toBe(true);
    expect(result).toMatchObject({ rule: "blocklist" });
  });

  it("drops a blocklisted domain, including subdomains", () => {
    expect(applyRules(email({ senderEmail: "x@substack.com" }), criteria).filtered).toBe(true);
    expect(applyRules(email({ senderEmail: "x@mail.substack.com" }), criteria).filtered).toBe(true);
  });

  it("reports which pattern matched, for debuggability", () => {
    const result = applyRules(email({ senderEmail: "x@substack.com" }), criteria);
    expect(result).toMatchObject({ detail: expect.stringContaining("@substack.com") });
  });

  it("outranks the keyword exemption: an explicit blocklist entry always wins", () => {
    // The user typed this address in. A keyword must not resurrect it.
    const result = applyRules(
      email({ senderEmail: "noreply@medium.com", subject: "Your interview deadline" }),
      criteria,
    );
    expect(result).toMatchObject({ filtered: true, rule: "blocklist" });
  });

  it("leaves a non-blocklisted sender alone", () => {
    expect(applyRules(email({ senderEmail: "jane@corp.com" }), criteria).filtered).toBe(false);
  });
});

/* ---------------------------------------------------------------------------
 * Priority senders — never filtered
 * ------------------------------------------------------------------------- */

describe("priority sender exemption", () => {
  it("keeps a priority sender that would otherwise be dropped as no-reply", () => {
    const result = applyRules(
      email({ senderEmail: "no-reply@northeastern.edu", headers: { "list-unsubscribe": "<x>" } }),
      criteria,
    );
    expect(result).toMatchObject({ filtered: false, exemptedBy: "priority_sender" });
  });

  it("keeps a priority local-part sender carrying bulk headers", () => {
    const result = applyRules(
      email({ senderEmail: "careers@bigco.com", headers: { "list-id": "<jobs.bigco.com>" } }),
      criteria,
    );
    expect(result).toMatchObject({ filtered: false, exemptedBy: "priority_sender" });
  });

  it("does not mark an ordinary passing email as exempted", () => {
    const result = applyRules(email({ senderEmail: "jane@corp.com" }), criteria);
    expect(result).toEqual({ filtered: false });
  });
});

/* ---------------------------------------------------------------------------
 * no_reply_sender heuristic
 * ------------------------------------------------------------------------- */

describe("no_reply_sender rule", () => {
  it.each([
    "noreply@corp.com",
    "no-reply@corp.com",
    "no_reply@corp.com",
    "no.reply@corp.com",
    "donotreply@corp.com",
    "do-not-reply@corp.com",
    "bounces@corp.com",
    "mailer-daemon@corp.com",
    "postmaster@corp.com",
  ])("drops %s", (senderEmail) => {
    const result = applyRules(email({ senderEmail }), bareCriteria);
    expect(result).toMatchObject({ filtered: true, rule: "no_reply_sender" });
  });

  it("drops a no-reply address with a plus or dash suffix", () => {
    expect(
      applyRules(email({ senderEmail: "no-reply+jobs@corp.com" }), bareCriteria).filtered,
    ).toBe(true);
  });

  it.each([
    // The critical negatives: these are real people and real ATS mailboxes.
    "notifications@greenhouse.io",
    "jobs-noreply-team@corp.com", // does not START with a no-reply token
    "replyto@corp.com",
    "jane@corp.com",
    "recruiting@corp.com",
    "automation-lead@corp.com",
  ])("keeps %s", (senderEmail) => {
    expect(applyRules(email({ senderEmail }), bareCriteria).filtered).toBe(false);
  });
});

/* ---------------------------------------------------------------------------
 * newsletter heuristic — header driven
 * ------------------------------------------------------------------------- */

describe("newsletter rule", () => {
  it("drops mail with a List-Unsubscribe header", () => {
    const result = applyRules(
      email({ headers: { "list-unsubscribe": "<mailto:unsub@corp.com>" } }),
      bareCriteria,
    );
    expect(result).toMatchObject({ filtered: true, rule: "newsletter" });
  });

  it("drops mail with a List-Id header", () => {
    const result = applyRules(
      email({ headers: { "list-id": "Weekly Digest <digest.corp.com>" } }),
      bareCriteria,
    );
    expect(result).toMatchObject({ filtered: true, rule: "newsletter" });
  });

  it.each(["bulk", "list", "junk", "  bulk  ", "BULK"])(
    "drops mail with Precedence: %s",
    (precedence) => {
      const result = applyRules(email({ headers: { precedence } }), bareCriteria);
      expect(result).toMatchObject({ filtered: true, rule: "newsletter" });
    },
  );

  it("keeps mail with Precedence: first-class or normal", () => {
    for (const precedence of ["first-class", "normal", "urgent"]) {
      expect(applyRules(email({ headers: { precedence } }), bareCriteria).filtered).toBe(false);
    }
  });

  it("does not treat Auto-Submitted as bulk, because calendar invites carry it", () => {
    // An interview invitation is very often a calendar invite.
    const result = applyRules(
      email({ headers: { "auto-submitted": "auto-generated" } }),
      bareCriteria,
    );
    expect(result.filtered).toBe(false);
  });

  it("does not drop one-to-one mail that merely mentions unsubscribing in the body", () => {
    const result = applyRules(
      email({ bodySnippet: "You can unsubscribe from these updates at any time." }),
      bareCriteria,
    );
    expect(result.filtered).toBe(false);
  });

  it("ignores an empty header value", () => {
    expect(applyRules(email({ headers: { "list-unsubscribe": "" } }), bareCriteria).filtered).toBe(
      false,
    );
  });
});

/* ---------------------------------------------------------------------------
 * receipt heuristic — subject driven
 * ------------------------------------------------------------------------- */

describe("receipt rule", () => {
  it.each([
    "Your receipt from Blue Bottle",
    "Order confirmation #12345",
    "Your order has shipped",
    "Your package is out for delivery",
    "Payment successful",
    "Thanks for your purchase!",
    "Your subscription renewed",
    "You've been charged $9.99",
  ])("drops subject: %s", (subject) => {
    const result = applyRules(email({ subject }), bareCriteria);
    expect(result).toMatchObject({ filtered: true, rule: "receipt" });
  });

  it.each([
    // Money arriving matters to a freelancer; these must survive.
    "Invoice #42 approved — paying this week",
    "Payment received for your contract work",
    "Re: your invoice",
    "Quick question about the project",
  ])("keeps subject: %s", (subject) => {
    expect(applyRules(email({ subject }), bareCriteria).filtered).toBe(false);
  });

  it("only looks at the subject, not the body", () => {
    const result = applyRules(
      email({ subject: "Following up", bodySnippet: "Here is your receipt for the order." }),
      bareCriteria,
    );
    expect(result.filtered).toBe(false);
  });
});

/* ---------------------------------------------------------------------------
 * Keyword exemption — the ATS safety net
 * ------------------------------------------------------------------------- */

describe("keyword exemption", () => {
  it("rescues a Greenhouse interview invite sent from a no-reply address", () => {
    // The single most important case in this file. Greenhouse, Lever, Workday
    // and Ashby all send from no-reply@ and often attach List-Unsubscribe.
    const result = applyRules(
      email({
        senderEmail: "no-reply@us.greenhouse-mail.io",
        subject: "Interview confirmation — Software Engineer Co-op",
        headers: { "list-unsubscribe": "<mailto:unsub@greenhouse.io>" },
      }),
      criteria,
    );
    expect(result).toMatchObject({ filtered: false, exemptedBy: "priority_keyword" });
  });

  it("explains which rule was overridden and which keyword saved it", () => {
    const result = applyRules(
      email({ senderEmail: "no-reply@corp.com", subject: "Interview request" }),
      criteria,
    );
    expect(result).toMatchObject({
      detail: expect.stringContaining("no_reply_sender"),
    });
    expect(result).toMatchObject({ detail: expect.stringContaining("interview") });
  });

  it("rescues a LinkedIn recruiter InMail notification", () => {
    // Regression test. LinkedIn sends recruiter InMail and "7 new profile
    // views" from the SAME no-reply address, so no sender rule separates
    // them — only the subject content does. This case was dropped twice
    // during development: first by a blocklist entry, then by
    // no_reply_sender once "recruiter" turned out to be missing from the
    // keyword list. Both are now covered.
    const result = applyRules(
      email({
        senderEmail: "no-reply@linkedin.com",
        subject: "A recruiter sent you a message about a Software Engineer role",
      }),
      criteria,
    );
    expect(result).toMatchObject({ filtered: false, exemptedBy: "priority_keyword" });
  });

  it("still drops LinkedIn social noise from that same address", () => {
    // The other half of the trade: no keyword, so the heuristic applies.
    const result = applyRules(
      email({
        senderEmail: "no-reply@linkedin.com",
        subject: "You have 7 new profile views this week",
      }),
      criteria,
    );
    expect(result).toMatchObject({ filtered: true, rule: "no_reply_sender" });
  });

  it("matches a keyword in the body when the subject is generic", () => {
    const result = applyRules(
      email({
        senderEmail: "no-reply@corp.com",
        subject: "Quick question",
        bodySnippet: "Following up on your co-op application.",
      }),
      criteria,
    );
    expect(result).toMatchObject({ filtered: false, exemptedBy: "priority_keyword" });
  });

  it("is case insensitive", () => {
    const result = applyRules(
      email({ senderEmail: "no-reply@corp.com", subject: "INTERVIEW REQUEST" }),
      criteria,
    );
    expect(result.filtered).toBe(false);
  });

  it("respects word boundaries so 'co-op' does not match 'cooperation'", () => {
    const result = applyRules(
      email({ senderEmail: "no-reply@corp.com", subject: "Thanks for your cooperation" }),
      criteria,
    );
    expect(result.filtered).toBe(true);
  });

  it("handles keywords containing regex metacharacters", () => {
    // "c++" would be an invalid regex if not escaped, and \b would never match
    // after the final '+'.
    const result = applyRules(
      email({ senderEmail: "no-reply@corp.com", subject: "C++ role available" }),
      criteria,
    );
    expect(result).toMatchObject({ filtered: false, exemptedBy: "priority_keyword" });
  });

  it("does not exempt when no keyword is present", () => {
    const result = applyRules(
      email({ senderEmail: "no-reply@corp.com", subject: "Weekly product update" }),
      criteria,
    );
    expect(result).toMatchObject({ filtered: true, rule: "no_reply_sender" });
  });

  it("accepts the cost of exempting marketing mail that happens to say 'deadline'", () => {
    // Documents the intended trade-off: this reaches the LLM and scores ~2/10.
    // One wasted API call is the correct price for never dropping an interview.
    const result = applyRules(
      email({
        senderEmail: "no-reply@shop.com",
        subject: "Last chance — deadline tonight for 50% off",
        headers: { "list-unsubscribe": "<x>" },
      }),
      criteria,
    );
    expect(result).toMatchObject({ filtered: false, exemptedBy: "priority_keyword" });
  });

  it("ignores empty and whitespace-only keywords in config", () => {
    const result = applyRules(email({ senderEmail: "no-reply@corp.com", subject: "Hi" }), {
      ...bareCriteria,
      keywords: ["", "   "],
    });
    expect(result).toMatchObject({ filtered: true, rule: "no_reply_sender" });
  });
});

/* ---------------------------------------------------------------------------
 * Precedence and edge cases
 * ------------------------------------------------------------------------- */

describe("rule precedence", () => {
  it("attributes to no_reply_sender before newsletter when both apply", () => {
    // Attribution order matters: /metrics breaks skips down by rule name.
    const result = applyRules(
      email({ senderEmail: "noreply@corp.com", headers: { "list-unsubscribe": "<x>" } }),
      bareCriteria,
    );
    expect(result).toMatchObject({ rule: "no_reply_sender" });
  });

  it("attributes to newsletter before receipt when both apply", () => {
    const result = applyRules(
      email({ subject: "Your order has shipped", headers: { "list-id": "<x>" } }),
      bareCriteria,
    );
    expect(result).toMatchObject({ rule: "newsletter" });
  });
});

describe("edge cases", () => {
  it("handles a null subject and null body", () => {
    const result = applyRules(email({ subject: null, bodySnippet: null }), criteria);
    expect(result.filtered).toBe(false);
  });

  it("handles an unparseable sender without throwing", () => {
    const result = applyRules(email({ senderEmail: "", sender: "garbage" }), criteria);
    expect(result.filtered).toBe(false);
  });

  it("is pure: the same input yields the same result and the input is unmodified", () => {
    const input = email({ senderEmail: "noreply@corp.com" });
    const snapshot = structuredClone({ ...input, receivedAt: input.receivedAt.toISOString() });

    const first = applyRules(input, criteria);
    const second = applyRules(input, criteria);

    expect(first).toEqual(second);
    expect({ ...input, receivedAt: input.receivedAt.toISOString() }).toEqual(snapshot);
  });
});
