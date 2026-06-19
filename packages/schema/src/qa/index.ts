import { validation } from "../errors.js";
import { coverageCheck } from "./checks/coverage.js";
import { duplicateCheck } from "./checks/duplicate.js";
import { emptyCheck } from "./checks/empty.js";
import { glossaryCheck } from "./checks/glossary.js";
import { icuSyntaxCheck } from "./checks/icu-syntax.js";
import { lengthCheck } from "./checks/length.js";
import { markupCheck } from "./checks/markup.js";
import { placeholdersCheck } from "./checks/placeholders.js";
import { pluralFormsCheck } from "./checks/plural-forms.js";
import { punctuationCheck } from "./checks/punctuation.js";
import { staleCheck } from "./checks/stale.js";
import { whitespaceCheck } from "./checks/whitespace.js";
import type { QaCheck, QaContext, QaFinding } from "./types.js";

export * from "./types.js";

/**
 * The QA check registry, mirroring the format-adapter registry in `formats/`.
 * Order here is the order findings are produced per context (before the final
 * stable sort the service applies).
 */
export const CHECKS: QaCheck[] = [
  icuSyntaxCheck,
  placeholdersCheck,
  pluralFormsCheck,
  markupCheck,
  lengthCheck,
  whitespaceCheck,
  punctuationCheck,
  emptyCheck,
  glossaryCheck,
  duplicateCheck,
  staleCheck,
  coverageCheck,
];

/**
 * Checks that are off unless a project opts in. Incomplete translation is normal
 * mid-loop, so coverage should not fail CI by default. The engine still knows
 * about them; the service's default config disables them.
 */
export const DEFAULT_DISABLED_CHECKS: readonly string[] = ["coverage"];

const BY_ID = new Map(CHECKS.map((c) => [c.id, c]));

export function getCheck(id: string): QaCheck | undefined {
  return BY_ID.get(id);
}

export function listChecks(): { id: string; description: string; severity: QaCheck["severity"] }[] {
  return CHECKS.map(({ id, description, severity }) => ({ id, description, severity }));
}

/** Validate check ids against the registry, throwing on any unknown id. */
export function assertCheckIds(ids: readonly string[]): void {
  const unknown = ids.filter((id) => !BY_ID.has(id));
  if (unknown.length > 0) {
    throw validation(
      `Unknown QA check(s): ${unknown.join(", ")}. Available: ${[...BY_ID.keys()].join(", ")}`,
    );
  }
}

/**
 * Run the given checks over every context. Pure: severity overrides, ignore
 * rules, counting, and sorting are the service's job. `checkIds` selects which
 * checks run (validated against the registry); omit to run them all.
 */
export function runChecks(contexts: QaContext[], opts: { checkIds?: readonly string[] } = {}): QaFinding[] {
  let checks = CHECKS;
  if (opts.checkIds) {
    assertCheckIds(opts.checkIds);
    const wanted = new Set(opts.checkIds);
    checks = CHECKS.filter((c) => wanted.has(c.id));
  }
  const findings: QaFinding[] = [];
  for (const ctx of contexts) {
    for (const check of checks) findings.push(...check.run(ctx));
  }
  return findings;
}
