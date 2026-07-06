/**
 * The context cascade — the pure fold algebra at the heart of the model.
 *
 * Context is a **grid**: three nested scope tiers (`project ⊃ namespace ⊃ key`)
 * run vertically and `locale` runs across them. Resolving a `key × locale` cell
 * folds every in-scope context entity down the precedence ladder, per the merge
 * operator of each entity's *kind*:
 *
 * - **override** (voice, length, format) — the narrowest populated tier wins,
 *   field-by-field. A narrower tier refining a broader one is a *cross-tier
 *   override*: recorded in provenance and it **raises review depth**.
 * - **union** (glossary, examples) — every tier contributes.
 * - **restrict** (compliance / any `hard` rule) — every tier's rule applies (AND);
 *   a contradiction is a structural **escalation** (surfaced as a `conflict`).
 *
 * **Locale is orthogonal**: within each scope tier the locale-specific cell
 * outranks the all-locales cell, so the 6-rung ladder already encodes the locale
 * overlay. **Locale shaping** (plural categories, RTL) is *not* a cascade
 * operator — it's a deterministic post-step driven by the locale code alone.
 *
 * This module is **pure** (no I/O, no AWS, no clock): the service loads the
 * context entities and calls {@link resolveCascade}. That keeps the whole algebra
 * unit-testable against hand-authored expected bundles.
 */

import type {
	CascadeTier,
	ContextRule,
	ContextRuleKind,
	Example,
	ExampleQuality,
	GlossaryTerm,
	LocaleShape,
	ProvenanceEntry,
	ResolvedContext,
	Scope,
} from "./domain.js";

/** The override precedence ladder, highest→lowest (scope-major / locale-minor). */
export const CASCADE_LADDER: readonly CascadeTier[] = [
	"key×locale",
	"key×all",
	"namespace×locale",
	"namespace×all",
	"project×locale",
	"project×all",
];

const rankOf = (tier: CascadeTier): number => CASCADE_LADDER.indexOf(tier);

/** The cell being briefed: a key's coordinates plus the target locale. */
export interface CascadeTarget {
	projectId: string;
	namespaceId?: string;
	keyId: string;
	locale: string;
}

export interface CascadeInput extends CascadeTarget {
	rules: ContextRule[];
	glossary: GlossaryTerm[];
	examples: Example[];
}

/**
 * Which ladder rung a `scope` occupies for `target`, or `null` when it does not
 * apply (a different key/namespace, or a locale-specific cell for another
 * locale). Tier is the narrowest populated of `{ keyId, namespaceId, project }`;
 * a locale-specific scope must match the target locale, an absent locale is the
 * all-locales rung.
 */
export function tierOf(
	scope: Scope | undefined,
	target: CascadeTarget,
): CascadeTier | null {
	// Project-wide (no scope at all) is the broadest all-locales rung.
	if (!scope) return "project×all";
	// Locale orthogonality: a locale-pinned cell only applies to that locale.
	if (scope.locale !== undefined && scope.locale !== target.locale) return null;
	const localed = scope.locale !== undefined;
	if (scope.keyId !== undefined) {
		if (scope.keyId !== target.keyId) return null;
		return localed ? "key×locale" : "key×all";
	}
	if (scope.namespaceId !== undefined) {
		if (scope.namespaceId !== target.namespaceId) return null;
		return localed ? "namespace×locale" : "namespace×all";
	}
	return localed ? "project×locale" : "project×all";
}

const QUALITY_RANK: Record<ExampleQuality, number> = { gold: 0, accepted: 1 };

/**
 * Deterministic example retrieval: in-scope, active, target-locale examples
 * ranked by **scope-proximity → quality → recency** (no embeddings). Shared by
 * the resolver and the `find_examples` operation so there is one ranking.
 */
export function rankExamples(
	examples: Example[],
	target: CascadeTarget,
): Example[] {
	return examples
		.filter((e) => (e.lifecycle ?? "active") === "active")
		.filter((e) => e.locale === target.locale)
		.map((e) => ({ e, tier: tierOf(e.scope, target) }))
		.filter((x): x is { e: Example; tier: CascadeTier } => x.tier !== null)
		.sort(
			(a, b) =>
				rankOf(a.tier) - rankOf(b.tier) ||
				QUALITY_RANK[a.e.quality] - QUALITY_RANK[b.e.quality] ||
				b.e.updatedAt.localeCompare(a.e.updatedAt) ||
				a.e.id.localeCompare(b.e.id),
		)
		.map((x) => x.e);
}

const RTL_LANGUAGES = new Set([
	"ar",
	"he",
	"fa",
	"ur",
	"ps",
	"sd",
	"yi",
	"dv",
	"ckb",
	"ug",
]);

/**
 * The deterministic locale-shaping post-step: the plural categories and writing
 * direction the agent must produce, derived from the locale code alone (via the
 * runtime's CLDR data — no authored context, no in-app model).
 */
export function shapeForLocale(locale: string): LocaleShape {
	const lang = (locale.toLowerCase().split(/[-_]/)[0] ?? locale) || locale;
	let pluralCategories: string[];
	try {
		pluralCategories = [
			...new Intl.PluralRules(locale).resolvedOptions().pluralCategories,
		].sort();
	} catch {
		pluralCategories = ["other"];
	}
	return { locale, pluralCategories, rtl: RTL_LANGUAGES.has(lang) };
}

/** A compliance contradiction across `restrict` rules: a token both required and
 * forbidden. Returns a human-readable conflict message, or `null`. */
function complianceConflict(rules: ContextRule[]): string | null {
	const asArray = (v: unknown): string[] =>
		Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
	const include = new Set<string>();
	const avoid = new Set<string>();
	for (const r of rules) {
		for (const t of asArray(r.payload.mustInclude)) include.add(t);
		for (const t of asArray(r.payload.mustAvoid)) avoid.add(t);
	}
	const clash = [...include].filter((t) => avoid.has(t)).sort();
	return clash.length
		? `compliance conflict: ${clash.join(", ")} both required and forbidden`
		: null;
}

/** The effective merge operator of a rule: `hard` always forces `restrict`. */
const effectiveOperator = (r: ContextRule) =>
	r.hard ? "restrict" : r.operator;

/**
 * Fold the whole cascade for one `key × locale` into a resolved bundle:
 * voice + constraints (from {@link ContextRule}s), glossary + examples (union),
 * provenance, restrict conflicts, the review-depth signal, and locale shaping.
 */
export function resolveCascade(input: CascadeInput): ResolvedContext {
	const target: CascadeTarget = {
		projectId: input.projectId,
		namespaceId: input.namespaceId,
		keyId: input.keyId,
		locale: input.locale,
	};

	// In-scope, active rules tagged with their rung, narrowest→broadest.
	const tagged = input.rules
		.filter((r) => (r.lifecycle ?? "active") === "active")
		.map((r) => ({ r, tier: tierOf(r.scope, target) }))
		.filter((x): x is { r: ContextRule; tier: CascadeTier } => x.tier !== null)
		.sort((a, b) => rankOf(a.tier) - rankOf(b.tier));

	const byKind = new Map<
		ContextRuleKind,
		{ r: ContextRule; tier: CascadeTier }[]
	>();
	for (const t of tagged) {
		const list = byKind.get(t.r.kind);
		if (list) list.push(t);
		else byKind.set(t.r.kind, [t]);
	}

	const provenance: ProvenanceEntry[] = [];
	const conflicts: string[] = [];
	let reviewRaised = false;
	let voice: Record<string, unknown> | undefined;
	const constraints: ContextRule[] = [];

	for (const [kind, items] of byKind) {
		const restrict = items.some((i) => effectiveOperator(i.r) === "restrict");
		const union = !restrict && items.every((i) => i.r.operator === "union");
		if (restrict) {
			// Every rung's rule applies; a contradiction is a structural escalation.
			for (const i of items) constraints.push(i.r);
			if (kind === "compliance") {
				const clash = complianceConflict(items.map((i) => i.r));
				if (clash) {
					conflicts.push(clash);
					reviewRaised = true;
				}
			}
		} else if (union) {
			for (const i of items) constraints.push(i.r);
		} else {
			// Override: narrowest wins, field-by-field (broadest applied first).
			const merged: Record<string, unknown> = {};
			for (let k = items.length - 1; k >= 0; k--)
				Object.assign(merged, items[k]?.r.payload);
			const narrowest = items[0];
			if (!narrowest) continue;
			const crossTier = items.length > 1;
			if (crossTier) reviewRaised = true;
			provenance.push({
				field: kind,
				tier: narrowest.tier,
				...(crossTier ? { crossTierOverride: true } : {}),
			});
			if (kind === "voice") voice = merged;
			else constraints.push({ ...narrowest.r, payload: merged });
		}
	}

	const glossary = input.glossary
		.filter((g) => (g.lifecycle ?? "active") === "active")
		.filter((g) => tierOf(g.scope, target) !== null);

	const examples = rankExamples(input.examples, target);

	return {
		scope: {
			projectId: input.projectId,
			...(input.namespaceId ? { namespaceId: input.namespaceId } : {}),
			keyId: input.keyId,
			locale: input.locale,
		},
		...(voice ? { voice } : {}),
		constraints,
		glossary,
		examples,
		provenance,
		orphanedContext: [],
		shape: shapeForLocale(input.locale),
		reviewDepth: reviewRaised ? "raised" : "normal",
		conflicts,
	};
}
