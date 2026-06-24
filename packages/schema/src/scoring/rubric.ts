/**
 * The MQM (Multidimensional Quality Metrics) rubric, the single source of the
 * grading methodology. Bumped whenever the wording materially changes — every
 * score records the `SCORE_PROMPT_VERSION` it was produced under (with a
 * `+custom` suffix when a project adds evaluation guidance), so provenance stays
 * auditable across rubric revisions.
 */
export const SCORE_PROMPT_VERSION = "mqm-core-1";

/**
 * MQM-Core: the seven error dimensions and the four severity levels. We do NOT
 * ask the model to compute the MQM penalty formula — it returns a single 0–100
 * score directly (GEMBA-MQM confirms direct scoring is valid). The dimensions
 * and severities are given so the score is grounded in a shared typology rather
 * than an arbitrary gut feel.
 */
export const MQM_RUBRIC = `Grade the target translation against the source using MQM-Core. Weigh issues across these seven dimensions:

1. Terminology — wrong/inconsistent domain terms; glossary violations.
2. Accuracy — mistranslation, addition, omission, untranslated text; the meaning must match the source.
3. Linguistic conventions — grammar, spelling, punctuation, and fluency in the target language.
4. Style — register, tone, and consistency with the product's voice.
5. Locale conventions — number/date/currency/address formats and other locale norms.
6. Audience appropriateness — suitability for the intended readers and context.
7. Design & markup — ICU placeholders, plural forms, HTML/markup tags, and length must be preserved.

Rate each issue you find by severity, and let severity drive the deductions:
- Neutral (0) — preference only; no penalty.
- Minor (1) — small, does not affect usability.
- Major (5) — affects meaning or usability; a user would notice.
- Critical (25) — breaks meaning, markup/placeholders, or is offensive/unsafe.

A flawless translation scores 100. Deduct more for higher-severity issues. A single critical issue (e.g. a broken placeholder, a reversed meaning, an untranslated string) should pull the score well below any reasonable approval threshold.`;
