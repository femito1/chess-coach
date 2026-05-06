/**
 * Pure-logic helper: given the Clerk identity of a freshly-signed-in
 * user, propose 1–3 candidate Chess.com usernames worth trying against
 * `/pub/player/{candidate}`.
 *
 * The actual API check + "Is this you?" confirmation lives in the
 * onboarding page; this module only produces the *list* of strings to
 * try. Keeping it pure makes the rules trivially unit-testable and lets
 * the onboarding page stay focused on UI.
 *
 * Rules (in order; first non-empty wins for ties):
 *
 *  1. `clerk.username` — the user's Clerk-side username, if they set
 *     one. Most likely match because GitHub OAuth sign-ups auto-fill
 *     this with the GitHub handle, and devs usually reuse handles.
 *  2. `clerk.firstName` (lowercased) — common when a user signs up via
 *     Google but their Chess.com handle happens to match their first
 *     name (less reliable than (1), but cheap to try).
 *  3. The local-part of the user's primary email address — the segment
 *     before `@`. Often matches for users who sign up with the same
 *     handle everywhere.
 *
 * Output is de-duplicated (lowercased compare) and trimmed. Strings
 * shorter than 3 characters are dropped — Chess.com handles are 3+
 * characters and short strings would just produce noisy 404s that we'd
 * have to filter anyway.
 */
export interface ClerkIdentityForSuggestion {
  username?: string | null;
  firstName?: string | null;
  primaryEmailLocalPart?: string | null;
}

const MIN_HANDLE_LEN = 3;

export function suggestUsernameCandidates(id: ClerkIdentityForSuggestion): string[] {
  const raw = [
    id.username,
    id.firstName ? id.firstName.toLowerCase() : undefined,
    id.primaryEmailLocalPart,
  ];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (!v) continue;
    const trimmed = v.trim();
    if (trimmed.length < MIN_HANDLE_LEN) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * Pull the local-part of an email ("alice" out of "alice@example.com").
 * Defensive — returns undefined for malformed input so callers don't
 * have to litter their code with try/catch around URL parsing.
 */
export function emailLocalPart(email: string | null | undefined): string | undefined {
  if (!email) return undefined;
  const at = email.indexOf('@');
  if (at <= 0) return undefined;
  const local = email.slice(0, at).trim();
  return local.length > 0 ? local : undefined;
}
