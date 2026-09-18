/**
 * Turning what a person typed into exactly one thing, or refusing.
 *
 * People hand an agent a reference the way they say it out loud — `PEE-1`, "the
 * assignee one", "Peek: Feedback". Demanding a canonical address pushes the
 * guesswork onto whoever is least equipped to do it, so matching has to be
 * generous. Generous matching is also how an agent ends up confidently reporting
 * on the wrong ticket.
 *
 * **So: match generously, and refuse when generosity produced more than one.**
 *
 * The refusal is the load-bearing half. Silently taking the first of several
 * matches produces an answer that is indistinguishable from a correct one — the
 * person sees a plausible issue, believes it is the one they meant, and nothing
 * afterwards reveals otherwise. Refusing costs one more question. Guessing costs
 * somebody's afternoon and their trust in every answer that came before.
 *
 * ## Why this is a shared function rather than a rule people follow
 *
 * It was a rule people follow, and it lasted two implementations. `findIssue`
 * and `findTopic` both refused ambiguity carefully; the project filter beside
 * them was written with `.find()` and quietly returned the first match for over
 * a week (PEEK-162). Measured on prod, `--project "Feedback"` matched three
 * projects and answered about the wrong one without a word.
 *
 * A rule enforced in two places out of three is worse than no rule, because a
 * reader assumes it holds everywhere. This module exists so the fourth caller
 * cannot forget.
 *
 * Deliberately generic: it names no kind, no tag and no object type, so it
 * belongs on the app-agnostic side of the seam.
 */
import { BadRequest } from './cli'

export interface Resolvable<T> {
  /** Singular noun for messages: `issue`, `topic`, `project`. */
  noun: string
  /**
   * Identifiers that must match the whole reference, case-insensitively.
   *
   * Checked before any substring match, and a single exact hit wins outright.
   * Without that precedence, an issue titled "Follow-up to PEE-1" would make
   * `PEE-1` ambiguous and render the original unreachable — a booby trap that
   * appears the day somebody files an ordinary follow-up.
   */
  exact: (item: T) => (string | undefined)[]
  /**
   * Identifiers a reference may name by a leading fragment — the `d` of an
   * address, so `42d82497` stands for the 110-character whole (MAK-1).
   *
   * Checked after `exact` and before `text`, and only for a reference of at
   * least `MIN_PREFIX` characters: below that a fragment is far more likely to
   * be the start of a word than the start of an id. Two ids sharing the
   * fragment is a refusal, not a fall-through to the title search, because the
   * person typed an identifier and the answer is "longer, please".
   */
  prefix?: (item: T) => (string | undefined)[]
  /** Free text searched by substring when no exact identifier matched. */
  text: (item: T) => string
  /** How a candidate is listed back when the reference was ambiguous. */
  label: (item: T) => string
  /** Appended to the "what did you mean" message, e.g. what forms are accepted. */
  hint?: string
}

/** How many candidates to name before it stops being a helpful list. */
const MAX_CANDIDATES = 8

/** Shortest fragment treated as the start of an id rather than of a word. */
const MIN_PREFIX = 4

/**
 * The first `SHORT` characters of an id, which is what listings print and
 * what `prefix` accepts back. Eight hex characters of a v4 uuid: 4 billion
 * values, so two colliding in a workspace of a few hundred is not a case worth
 * a variable-length scheme — and a collision is still refused, never guessed.
 */
export const SHORT = 8
export const short = (id: string): string => id.slice(0, SHORT)

/**
 * What one reference resolved to, without deciding whether that is an error.
 *
 * `show` has to ask the same question of two different kinds of object — is
 * this an issue, or is it a project — and only then decide. Asking with
 * `resolveOne` cannot work: a reference that is a perfectly good project name
 * throws on the issue attempt, and catching that would make "no issues match"
 * indistinguishable from "three issues match", which is the one distinction
 * this module exists to preserve.
 *
 * So the matching lives here once and the throwing lives in `resolveOne`. A
 * caller that needs to look in two places gets the same generosity and the same
 * refusals, rather than a fourth implementation of the rule.
 */
export type Resolution<T> = { found: T } | { ambiguous: string } | { none: true }

export function resolveMaybe<T>(items: T[], reference: string, how: Resolvable<T>): Resolution<T> {
  const needle = reference.trim().toLowerCase()
  if (!needle) return { ambiguous: `Which ${how.noun}?${how.hint ? ` ${how.hint}` : ''}` }

  const exact = items.filter((item) =>
    how.exact(item).some((value) => value?.toLowerCase() === needle),
  )
  if (exact.length === 1) return { found: exact[0] }

  const byPrefix =
    how.prefix && needle.length >= MIN_PREFIX && exact.length === 0
      ? items.filter((item) =>
          how.prefix!(item).some((value) => value?.toLowerCase().startsWith(needle)),
        )
      : []
  if (byPrefix.length === 1) return { found: byPrefix[0] }

  const partial =
    byPrefix.length > 1 ? [] : items.filter((item) => how.text(item).toLowerCase().includes(needle))
  if (partial.length === 1) return { found: partial[0] }

  if (partial.length > 1 || exact.length > 1 || byPrefix.length > 1) {
    /*
      Two exact matches is a genuine collision in the data rather than a vague
      question — display refs are not unique, and the workspace really does
      contain two `PEE-1`. Listing them is still the right answer: the caller
      needs to see that the identifier they trusted is not an identifier.
    */
    const collided = exact.length > 1 ? exact : byPrefix.length > 1 ? byPrefix : partial
    const candidates = collided.slice(0, MAX_CANDIDATES)
    const shown = candidates.map((item) => `  ${how.label(item)}`).join('\n')
    const total = collided.length
    const more = total > candidates.length ? `\n  …and ${total - candidates.length} more` : ''
    return { ambiguous: `"${reference}" matches ${total} ${how.noun}s:\n${shown}${more}` }
  }

  return { none: true }
}

export function resolveOne<T>(items: T[], reference: string, how: Resolvable<T>): T {
  const resolved = resolveMaybe(items, reference, how)
  if ('found' in resolved) return resolved.found
  if ('ambiguous' in resolved) throw new BadRequest(resolved.ambiguous)
  throw new BadRequest(`No ${how.noun} matches "${reference}".`)
}
