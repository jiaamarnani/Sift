/**
 * Parsing for RFC 5322 `From` headers.
 *
 * Gmail hands back the raw header (`"Doe, Jane" <jane@corp.com>`), but every
 * rule and every sender-history lookup needs the bare address. Kept as its own
 * module with its own tests because address parsing is where quiet bugs live —
 * a mis-parse silently breaks both the priority-sender rule and
 * get_sender_history(), and neither failure is loud.
 *
 * Deliberately not a full RFC 5322 parser. Group syntax, comments, and
 * multiple addresses in one header don't appear in practice on inbound mail,
 * and a hand-rolled approximation of the full grammar would be worse than an
 * honest subset.
 */

export interface ParsedAddress {
  /** Display name with quotes stripped, or null when the header had none. */
  displayName: string | null;
  /** Lowercased bare address, or "" when nothing parseable was found. */
  address: string;
}

/**
 * Lowercase and strip whitespace plus any surrounding angle brackets.
 * Case-folding the whole address (not just the domain) is technically
 * over-normalising — the local part is case-sensitive per spec — but no real
 * mail provider treats it that way, and folding makes comparisons reliable.
 */
export function normalizeAddress(raw: string): string {
  return raw.trim().replace(/^<|>$/g, "").trim().toLowerCase();
}

/**
 * Pull the display name and address out of a `From` header.
 *
 * Handles the shapes that actually arrive:
 *   `jane@corp.com`
 *   `<jane@corp.com>`
 *   `Jane Doe <jane@corp.com>`
 *   `"Doe, Jane" <jane@corp.com>`
 *   `Jane Doe <JANE@Corp.COM>`  -> address lowercased
 */
export function parseFromHeader(raw: string | null | undefined): ParsedAddress {
  if (!raw) return { displayName: null, address: "" };

  const header = raw.trim();

  // Angle-bracket form: everything before `<` is the display name. Use the
  // last `<...>` pair so a display name containing angle brackets can't
  // capture the address.
  const open = header.lastIndexOf("<");
  const close = header.lastIndexOf(">");
  if (open !== -1 && close > open) {
    const address = normalizeAddress(header.slice(open + 1, close));
    const name = stripQuotes(header.slice(0, open).trim());
    return { displayName: name.length > 0 ? name : null, address };
  }

  // Bare address, no display name.
  return { displayName: null, address: normalizeAddress(header) };
}

function stripQuotes(value: string): string {
  const quoted = /^"(.*)"$/s.exec(value);
  // Unescape \" and \\ inside a quoted string, per RFC 5322 quoted-pair.
  if (quoted?.[1] !== undefined) return quoted[1].replace(/\\(.)/g, "$1");
  return value;
}

export interface AddressParts {
  localPart: string;
  domain: string;
}

/**
 * Split a normalized address at the last `@`.
 * Returns empty strings for an unparseable address so callers never need a
 * null check before comparing.
 */
export function splitAddress(address: string): AddressParts {
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return { localPart: "", domain: "" };
  return { localPart: address.slice(0, at), domain: address.slice(at + 1) };
}

/**
 * Match an address against one of three configured pattern shapes:
 *
 *   `"@northeastern.edu"` / `"northeastern.edu"`
 *        domain match, including subdomains — also matches
 *        `mail.northeastern.edu`, because universities and ATS vendors route
 *        through subdomains constantly.
 *   `"careers@"`
 *        local-part match on any domain — `careers@anycorp.com`.
 *   `"noreply@medium.com"`
 *        exact address match.
 *
 * One function used by both the blocklist and the priority-sender list, so the
 * two can never diverge in how they interpret a pattern.
 */
export function matchesSenderPattern(address: string, pattern: string): boolean {
  const addr = normalizeAddress(address);
  const pat = pattern.trim().toLowerCase();
  if (addr === "" || pat === "") return false;

  const { localPart, domain } = splitAddress(addr);

  // `careers@` — local part only.
  if (pat.endsWith("@")) {
    return localPart !== "" && localPart === pat.slice(0, -1);
  }

  // `@northeastern.edu` — domain, plus subdomains.
  if (pat.startsWith("@")) {
    const bare = pat.slice(1);
    return domain !== "" && (domain === bare || domain.endsWith(`.${bare}`));
  }

  // Contains `@` in the middle — exact address.
  if (pat.includes("@")) return addr === pat;

  // Bare domain, e.g. `substack.com`.
  return domain !== "" && (domain === pat || domain.endsWith(`.${pat}`));
}
