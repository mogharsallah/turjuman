import type {
	Actor,
	Project,
	QaConfig,
	QaIgnoreRule,
	QaSeverity,
} from "@turjuman/schema";
import { MAIN_BRANCH_ID, validation } from "@turjuman/schema";
import type {
	QaContext,
	QaFinding,
	QaReport,
	QaReportCounts,
} from "@turjuman/schema/qa";
import {
	assertCheckIds,
	CHECKS,
	DEFAULT_DISABLED_CHECKS,
	runChecks,
} from "@turjuman/schema/qa";
import type { RepositoryApi } from "../repository/index.js";
import { BaseService } from "./base.js";
import type { NamespaceService } from "./namespaces.js";

export interface RunChecksOptions {
	/** Limit to one locale; omit to check every non-base locale. */
	locale?: string;
	/** Limit to specific check ids; omit to run every enabled check. */
	checkIds?: string[];
	/** Which value to validate: the working draft (default) or the accepted head. */
	slot?: "working" | "accepted";
}

export interface SetQaConfigInput {
	checks?: Record<string, { enabled?: boolean; severity?: QaSeverity }>;
	ignore?: QaIgnoreRule[];
}

/**
 * Runs the deterministic QA engine over a project's translations and owns the
 * per-project QA configuration. This is the **single seam** between the pure
 * `qa/` engine and the data model: it loads translations/keys/glossary, derives
 * the lifecycle-dependent context fields (`expectsValue`, `stale`), runs the
 * engine, then applies config (severity overrides + ignore rules). QA is
 * advisory — it never mutates translations or the acceptance state.
 */
export class QaService extends BaseService {
	constructor(
		repo: RepositoryApi,
		private readonly namespaces: NamespaceService,
	) {
		super(repo);
	}

	async getConfig(actor: Actor, projectId: string): Promise<QaConfig> {
		await this.authorizeProject(actor, projectId, "project.read");
		return (
			(await this.repo.getQaConfig(projectId)) ?? this.defaultConfig(projectId)
		);
	}

	async setConfig(
		actor: Actor,
		projectId: string,
		input: SetQaConfigInput,
	): Promise<QaConfig> {
		await this.authorizeProject(actor, projectId, "project.update");
		if (input.checks) assertCheckIds(Object.keys(input.checks));
		for (const rule of input.ignore ?? []) {
			if (rule.checkId !== undefined) assertCheckIds([rule.checkId]);
			if (!rule.checkId && !rule.namespace && !rule.keyName && !rule.locale) {
				throw validation(
					"An ignore rule must specify at least one of checkId/namespace/keyName/locale",
				);
			}
		}
		const existing =
			(await this.repo.getQaConfig(projectId)) ?? this.defaultConfig(projectId);
		const merged: QaConfig = {
			projectId,
			checks: input.checks ?? existing.checks,
			ignore: input.ignore ?? existing.ignore,
			updatedBy: actor.userId,
			updatedAt: new Date().toISOString(),
		};
		return this.repo.putQaConfig(merged);
	}

	async run(
		actor: Actor,
		projectId: string,
		opts: RunChecksOptions = {},
	): Promise<QaReport> {
		const { project } = await this.authorizeProject(
			actor,
			projectId,
			"translation.read",
		);
		if (opts.locale) await this.requireLocaleExists(projectId, opts.locale);
		if (opts.checkIds) assertCheckIds(opts.checkIds);

		const config =
			(await this.repo.getQaConfig(projectId)) ?? this.defaultConfig(projectId);
		const checkIds = opts.checkIds ?? this.enabledCheckIds(config);

		const { contexts, locales } = await this.buildContexts(project, opts);
		const raw = runChecks(contexts, { checkIds });
		const findings = this.applyConfig(raw, config);
		findings.sort(
			(a, b) =>
				a.localeCode.localeCompare(b.localeCode) ||
				a.namespace.localeCompare(b.namespace) ||
				a.keyName.localeCompare(b.keyName) ||
				a.checkId.localeCompare(b.checkId),
		);

		const counts: QaReportCounts = { error: 0, warning: 0, info: 0 };
		const byLocale: Record<string, QaFinding[]> = {};
		for (const code of locales) byLocale[code] = [];
		for (const f of findings) {
			counts[f.severity]++;
			(byLocale[f.localeCode] ??= []).push(f);
		}

		return {
			projectId,
			baseLocale: project.baseLocale,
			locales,
			checks: checkIds,
			counts,
			findings,
			byLocale,
		};
	}

	// ---- internals ------------------------------------------------------------

	private defaultConfig(projectId: string): QaConfig {
		return { projectId, checks: {}, ignore: [], updatedBy: "", updatedAt: "" };
	}

	/** Check ids enabled under `config` (coverage et al. are off unless opted in). */
	private enabledCheckIds(config: QaConfig): string[] {
		return CHECKS.filter(
			(c) =>
				config.checks[c.id]?.enabled ?? !DEFAULT_DISABLED_CHECKS.includes(c.id),
		).map((c) => c.id);
	}

	/** Apply per-check severity overrides, then drop findings matched by ignore rules. */
	private applyConfig(findings: QaFinding[], config: QaConfig): QaFinding[] {
		return findings
			.map((f) => {
				const override = config.checks[f.checkId]?.severity;
				return override ? { ...f, severity: override } : f;
			})
			.filter(
				(f) => !config.ignore.some((rule) => this.matchesIgnore(rule, f)),
			);
	}

	private matchesIgnore(rule: QaIgnoreRule, f: QaFinding): boolean {
		let any = false;
		if (rule.checkId !== undefined) {
			any = true;
			if (rule.checkId !== f.checkId) return false;
		}
		if (rule.namespace !== undefined) {
			any = true;
			if (rule.namespace !== f.namespace) return false;
		}
		if (rule.keyName !== undefined) {
			any = true;
			if (rule.keyName !== f.keyName) return false;
		}
		if (rule.locale !== undefined) {
			any = true;
			if (rule.locale !== f.localeCode) return false;
		}
		return any;
	}

	/**
	 * Load the data and build one context per (active key, target locale). This is
	 * the only place that reads the data model; everything lifecycle-specific
	 * (`expectsValue`, `stale`, slot selection) is resolved here so the checks stay
	 * pure. The base locale is the source of truth and is never itself a target.
	 */
	private async buildContexts(
		project: Project,
		opts: RunChecksOptions,
	): Promise<{ contexts: QaContext[]; locales: string[] }> {
		const projectId = project.id;
		const branch = MAIN_BRANCH_ID;
		const slot = opts.slot ?? "working";
		const [keys, glossary, baseCells, nsNames] = await Promise.all([
			this.repo.listKeyDefs(projectId, branch),
			this.repo.listGlossary(projectId),
			this.repo.listCellsByLocale(projectId, branch, project.baseLocale),
			this.namespaces.nameMap(projectId),
		]);
		const activeKeys = keys.filter((k) => k.state !== "deprecated");
		const keyById = new Map(activeKeys.map((k) => [k.id, k]));
		const baseValue = new Map(baseCells.map((c) => [c.keyId, c.value]));
		const nsNameOf = (namespaceId: string | undefined): string =>
			nsNames.get(namespaceId ?? "") ?? "";
		// Selected deliverable value: the working draft, or the accepted head (only
		// a cell that is itself `accepted` carries a current accepted value).
		const valueOf = (c: { value: string; lifecycle: string } | undefined) =>
			c
				? slot === "working"
					? c.value
					: c.lifecycle === "accepted"
						? c.value
						: undefined
				: undefined;

		const allTargets = opts.locale
			? [opts.locale]
			: (await this.repo.listLocales(projectId)).map((l) => l.code);
		const locales = allTargets.filter((c) => c !== project.baseLocale);

		const contexts: QaContext[] = [];
		for (const code of locales) {
			const cells = await this.repo.listCellsByLocale(projectId, branch, code);
			const byKey = new Map(cells.map((c) => [c.keyId, c]));

			const localeIndex = new Map<string, string[]>();
			for (const c of cells) {
				const v = valueOf(c);
				const k = keyById.get(c.keyId);
				if (v && v.trim() !== "" && k) {
					const id = `${nsNameOf(k.namespaceId)}#${k.name}`;
					(localeIndex.get(v) ?? localeIndex.set(v, []).get(v)!).push(id);
				}
			}

			for (const key of activeKeys) {
				const c = byKey.get(key.id);
				contexts.push({
					baseLocale: project.baseLocale,
					localeCode: code,
					namespace: nsNameOf(key.namespaceId),
					key,
					baseValue: baseValue.get(key.id),
					targetValue: valueOf(c),
					targetStatus: c?.lifecycle,
					expectsValue:
						c?.lifecycle === "proposed" ||
						c?.lifecycle === "accepted" ||
						c?.lifecycle === "escalated",
					stale:
						(c?.stale ?? false) ||
						(c?.sourceRef !== undefined && c.sourceRef !== key.sourceRevision),
					origin: c?.origin,
					glossary,
					localeIndex,
				});
			}
		}
		return { contexts, locales };
	}
}
