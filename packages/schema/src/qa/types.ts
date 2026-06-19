import type {
  GlossaryTerm,
  QaSeverity,
  TranslationKey,
  TranslationOrigin,
  TranslationStatus,
} from "../domain.js";
import type { QaFindingShape, QaReportCountsShape, QaReportShape } from "../wire.js";

export type { QaSeverity };

// The report shapes are defined once as zod schemas in `wire.ts` (so the MCP
// `run_qa_checks` output schema and the REST `POST /checks` response schema
// share one definition) and surfaced here under their canonical names.
export type QaFinding = QaFindingShape;
export type QaReportCounts = QaReportCountsShape;
export type QaReport = QaReportShape;

/**
 * Automated QA checks — the deterministic quality layer.
 *
 * The engine is **pure**: every check is a function over a {@link QaContext}
 * value snapshot and knows nothing about persistence, RBAC, the lifecycle state
 * machine, or how a value is stored/delivered. All I/O and all lifecycle
 * coupling live in `services/qa.ts`, which builds the contexts and applies the
 * per-project config. If the state model evolves, only that one seam changes —
 * never the checks here.
 */

/**
 * One unit of work handed to every check: a single target translation paired
 * with its base-locale sibling (the source of truth for placeholder/markup/
 * punctuation comparisons). Built once per (active key, target locale) by the
 * service.
 */
export interface QaContext {
  baseLocale: string;
  /** The target locale being checked. */
  localeCode: string;
  key: Pick<TranslationKey, "namespace" | "name" | "plural" | "maxLength" | "tags" | "description">;
  /** Current base-locale value for this key — the source of truth. */
  baseValue: string | undefined;
  /** The value under test: the working `value`, or `approvedValue` when slot="approved". */
  targetValue: string | undefined;
  /** Raw status, for messages. Logic should prefer {@link expectsValue}. */
  targetStatus: TranslationStatus | undefined;
  /**
   * Derived by the service from status: true when the translation is expected to
   * carry a value (translated/approved). Insulates checks from the status enum.
   */
  expectsValue: boolean;
  /** Derived by the service: the source moved on since this value was written. */
  stale: boolean;
  /** How the current value was produced (provenance), for reviewer-facing reports. */
  origin: TranslationOrigin | undefined;
  /** All glossary terms for the project (shared across contexts; read-only). */
  glossary: readonly GlossaryTerm[];
  /** Within this target locale: value -> the `namespace#name` ids that share it (duplicate detection). */
  localeIndex: ReadonlyMap<string, readonly string[]>;
}

/** A deterministic check over a single {@link QaContext}. Pure — no side effects. */
export interface QaCheck {
  id: string;
  description: string;
  /** Built-in default severity; a project's config may override it. */
  severity: QaSeverity;
  run(ctx: QaContext): QaFinding[];
}

