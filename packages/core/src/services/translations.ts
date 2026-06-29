import type { Actor, BulkSetResult, Project } from "@turjuman/schema";
import {
	forbidden,
	MAIN_BRANCH_ID,
	notFound,
	type Translation,
	type TranslationKey,
	validation,
} from "@turjuman/schema";
import type { RepositoryApi } from "../repository/index.js";
import { BaseService } from "./base.js";
import type { NamespaceService } from "./namespaces.js";
import { revisionOf } from "./revision.js";
import type {
	BundleEntry,
	BundlePage,
	KeyPage,
	SetTranslationInput,
	TranslationPage,
} from "./types.js";

/** How a deliverable value is chosen for export. */
type Slot = "accepted" | "working";

interface BundleCtx {
	projectId: string;
	branch: string;
	isBase: boolean;
	slot: Slot;
	fallback: "source" | "omit";
	keyMeta: Map<string, TranslationKey>;
	baseValues: Map<string, string>;
	nsNames: Map<string, string>;
	excludeStale?: boolean;
}

export class TranslationsService extends BaseService {
	constructor(
		repo: RepositoryApi,
		private readonly namespaces: NamespaceService,
	) {
		super(repo);
	}

	async listForKey(
		actor: Actor,
		projectId: string,
		name: string,
		namespace?: string,
		branch = MAIN_BRANCH_ID,
	): Promise<Translation[]> {
		await this.authorizeProject(actor, projectId, "translation.read");
		const { keyId } = await this.resolveKey(projectId, branch, name, namespace);
		return this.repo.listCellsByKey(projectId, branch, keyId);
	}

	async listForLocale(
		actor: Actor,
		projectId: string,
		code: string,
		branch = MAIN_BRANCH_ID,
	): Promise<Translation[]> {
		await this.authorizeProject(actor, projectId, "translation.read");
		await this.requireLocaleExists(projectId, code);
		return this.repo.listCellsByLocale(projectId, branch, code);
	}

	/** One page of a locale's raw cells, so a large locale doesn't force a
	 * full-partition read on every call. */
	async listForLocalePage(
		actor: Actor,
		projectId: string,
		code: string,
		opts: { branch?: string; limit?: number; cursor?: string } = {},
	): Promise<TranslationPage> {
		await this.authorizeProject(actor, projectId, "translation.read");
		await this.requireLocaleExists(projectId, code);
		const page = await this.repo.listCellsByLocalePage(
			projectId,
			opts.branch ?? MAIN_BRANCH_ID,
			code,
			{ limit: opts.limit, cursor: opts.cursor },
		);
		return { translations: page.cells, nextCursor: page.nextCursor };
	}

	/**
	 * Export a locale as adapter-ready entries: each key's deliverable value plus
	 * its description and plural flag. By default this ships the **accepted** value
	 * (the cell's head version), so in-progress drafts never leak into delivered
	 * output; `slot: "working"` ships the live draft value instead (preview /
	 * staging). The base locale always ships its value — it is the source. When no
	 * accepted value exists, `fallback: "source"` (default) fills from the base
	 * value; `fallback: "omit"` drops the key.
	 */
	async exportBundle(
		actor: Actor,
		projectId: string,
		code: string,
		opts: {
			branch?: string;
			slot?: Slot;
			fallback?: "source" | "omit";
			excludeStale?: boolean;
		} = {},
	): Promise<BundleEntry[]> {
		const { project } = await this.authorizeProject(
			actor,
			projectId,
			"translation.read",
		);
		await this.requireLocaleExists(projectId, code);
		const branch = opts.branch ?? MAIN_BRANCH_ID;
		const slot = opts.slot ?? "accepted";
		const fallback = opts.fallback ?? "source";
		const isBase = code === project.baseLocale;
		const [keys, cells, nsNames] = await Promise.all([
			this.repo.listKeyDefs(projectId, branch),
			this.repo.listCellsByLocale(projectId, branch, code),
			this.namespaces.nameMap(projectId),
		]);
		const keyMeta = new Map(
			keys.filter((k) => k.state !== "deprecated").map((k) => [k.id, k]),
		);
		const needBase =
			!isBase && (fallback === "source" || opts.excludeStale === true);
		const baseValues = needBase
			? new Map(
					(
						await this.repo.listCellsByLocale(
							projectId,
							branch,
							project.baseLocale,
						)
					).map((c) => [c.keyId, c.value]),
				)
			: new Map<string, string>();
		return this.toBundleEntries(cells, {
			projectId,
			branch,
			isBase,
			slot,
			fallback,
			keyMeta,
			baseValues,
			nsNames,
			excludeStale: opts.excludeStale,
		});
	}

	/** Like {@link exportBundle}, but one page at a time so the export never
	 * materializes a whole locale (and its joins) at once. */
	async exportBundlePage(
		actor: Actor,
		projectId: string,
		code: string,
		opts: {
			branch?: string;
			slot?: Slot;
			fallback?: "source" | "omit";
			excludeStale?: boolean;
			limit?: number;
			cursor?: string;
		} = {},
	): Promise<BundlePage> {
		const { project } = await this.authorizeProject(
			actor,
			projectId,
			"translation.read",
		);
		await this.requireLocaleExists(projectId, code);
		const branch = opts.branch ?? MAIN_BRANCH_ID;
		const slot = opts.slot ?? "accepted";
		const fallback = opts.fallback ?? "source";
		const isBase = code === project.baseLocale;
		const page = await this.repo.listCellsByLocalePage(
			projectId,
			branch,
			code,
			{
				limit: opts.limit,
				cursor: opts.cursor,
			},
		);
		const nsNames = await this.namespaces.nameMap(projectId);
		const needBase =
			!isBase && (fallback === "source" || opts.excludeStale === true);
		const keyMeta = new Map<string, TranslationKey>();
		const baseValues = new Map<string, string>();
		await Promise.all(
			page.cells.map(async (c) => {
				const [key, base] = await Promise.all([
					this.repo.getKeyDef(projectId, branch, c.keyId),
					needBase
						? this.repo.getCell(projectId, branch, c.keyId, project.baseLocale)
						: Promise.resolve(undefined),
				]);
				if (key && key.state !== "deprecated") keyMeta.set(c.keyId, key);
				if (base) baseValues.set(c.keyId, base.value);
			}),
		);
		const entries = await this.toBundleEntries(page.cells, {
			projectId,
			branch,
			isBase,
			slot,
			fallback,
			keyMeta,
			baseValues,
			nsNames,
			excludeStale: opts.excludeStale,
		});
		return { entries, nextCursor: page.nextCursor };
	}

	/** Per-cell transform shared by the whole and paged bundle exports. */
	private async toBundleEntries(
		cells: Translation[],
		ctx: BundleCtx,
	): Promise<BundleEntry[]> {
		const out: BundleEntry[] = [];
		for (const c of cells) {
			const meta = ctx.keyMeta.get(c.keyId);
			if (!meta) continue; // deprecated or deleted key
			if (
				ctx.excludeStale &&
				!ctx.isBase &&
				c.sourceRef !== undefined &&
				c.sourceRef !== meta.sourceRevision
			) {
				continue; // stale: the source moved on since this was accepted
			}
			let value: string | undefined;
			if (ctx.isBase || ctx.slot === "working") value = c.value;
			else value = await this.acceptedValue(ctx.projectId, ctx.branch, c);
			if (
				(value === undefined || value === "") &&
				ctx.fallback === "source" &&
				!ctx.isBase
			)
				value = ctx.baseValues.get(c.keyId) ?? "";
			if (value === undefined || value === "") continue;
			out.push({
				key: meta.name,
				namespace: ctx.nsNames.get(meta.namespaceId ?? "") ?? "",
				value,
				description: meta.description,
				plural: meta.plural,
			});
		}
		return out;
	}

	/** The cell's accepted (head) value: `cell.value` when the cell is itself
	 * accepted, else the head version's value, else `undefined` (never accepted). */
	private async acceptedValue(
		projectId: string,
		branch: string,
		cell: Translation,
	): Promise<string | undefined> {
		if (cell.head === undefined) return undefined;
		if (cell.lifecycle === "accepted") return cell.value;
		return (
			await this.repo.getVersion(
				projectId,
				branch,
				cell.keyId,
				cell.locale,
				cell.head,
			)
		)?.value;
	}

	/** Keys with no cell (or an empty value) for the given locale. */
	async listUntranslated(
		actor: Actor,
		projectId: string,
		code: string,
		branch = MAIN_BRANCH_ID,
	): Promise<TranslationKey[]> {
		await this.authorizeProject(actor, projectId, "translation.read");
		await this.requireLocaleExists(projectId, code);
		const [keys, cells] = await Promise.all([
			this.repo.listKeyDefs(projectId, branch),
			this.repo.listCellsByLocale(projectId, branch, code),
		]);
		const filled = new Set(
			cells.filter((c) => c.value.trim() !== "").map((c) => c.keyId),
		);
		return keys.filter((k) => k.state !== "deprecated" && !filled.has(k.id));
	}

	/** One page of a locale's untranslated keys. */
	async listUntranslatedPage(
		actor: Actor,
		projectId: string,
		code: string,
		opts: { branch?: string; limit?: number; cursor?: string } = {},
	): Promise<KeyPage> {
		await this.authorizeProject(actor, projectId, "translation.read");
		await this.requireLocaleExists(projectId, code);
		const branch = opts.branch ?? MAIN_BRANCH_ID;
		const page = await this.repo.listKeyDefsPage(projectId, branch, {
			limit: opts.limit,
			cursor: opts.cursor,
		});
		const active = page.keys.filter((k) => k.state !== "deprecated");
		const cells = await Promise.all(
			active.map((k) => this.repo.getCell(projectId, branch, k.id, code)),
		);
		const keys = active.filter((_, i) => {
			const c = cells[i];
			return !c || c.value.trim() === "";
		});
		return { keys, nextCursor: page.nextCursor };
	}

	/**
	 * Keys whose cell for the locale was translated against a base value that has
	 * since changed — the source moved on (`cell.sourceRef !== key.sourceRevision`),
	 * so the target is stale. The base locale is the source and is never stale.
	 */
	async listStale(
		actor: Actor,
		projectId: string,
		code: string,
		branch = MAIN_BRANCH_ID,
	): Promise<TranslationKey[]> {
		const { project } = await this.authorizeProject(
			actor,
			projectId,
			"translation.read",
		);
		await this.requireLocaleExists(projectId, code);
		if (code === project.baseLocale) return [];
		const [keys, cells] = await Promise.all([
			this.repo.listKeyDefs(projectId, branch),
			this.repo.listCellsByLocale(projectId, branch, code),
		]);
		const keyById = new Map(keys.map((k) => [k.id, k]));
		const staleIds = new Set(
			cells
				.filter((c) => {
					const k = keyById.get(c.keyId);
					return (
						k && c.sourceRef !== undefined && c.sourceRef !== k.sourceRevision
					);
				})
				.map((c) => c.keyId),
		);
		return keys.filter((k) => k.state !== "deprecated" && staleIds.has(k.id));
	}

	/** One page of a locale's stale keys. */
	async listStalePage(
		actor: Actor,
		projectId: string,
		code: string,
		opts: { branch?: string; limit?: number; cursor?: string } = {},
	): Promise<KeyPage> {
		const { project } = await this.authorizeProject(
			actor,
			projectId,
			"translation.read",
		);
		await this.requireLocaleExists(projectId, code);
		const branch = opts.branch ?? MAIN_BRANCH_ID;
		if (code === project.baseLocale) return { keys: [], nextCursor: undefined };
		const page = await this.repo.listKeyDefsPage(projectId, branch, {
			limit: opts.limit,
			cursor: opts.cursor,
		});
		const active = page.keys.filter((k) => k.state !== "deprecated");
		const cells = await Promise.all(
			active.map((k) => this.repo.getCell(projectId, branch, k.id, code)),
		);
		const keys = active.filter((k, i) => {
			const c = cells[i];
			return c?.sourceRef !== undefined && c.sourceRef !== k.sourceRevision;
		});
		return { keys, nextCursor: page.nextCursor };
	}

	/**
	 * Write a draft value for a key in a locale. A target write lands as
	 * `proposed` (awaiting acceptance) and records the base revision it was written
	 * against. Writing the base locale instead updates the source: it bumps the
	 * key's `sourceRevision` (staling dependents) and the cell is `accepted` source.
	 */
	async set(
		actor: Actor,
		projectId: string,
		code: string,
		input: SetTranslationInput,
	): Promise<Translation> {
		const { project } = await this.authorizeProject(
			actor,
			projectId,
			"translation.write",
		);
		await this.requireLocaleExists(projectId, code);
		const branch = input.branch ?? MAIN_BRANCH_ID;
		const { keyId, key } = await this.resolveKey(
			projectId,
			branch,
			input.name,
			input.namespace,
		);
		const now = new Date().toISOString();
		if (code === project.baseLocale) {
			const rev = revisionOf(input.value);
			if (rev !== key.sourceRevision)
				await this.repo.putKeyDef(branch, {
					...key,
					sourceRevision: rev,
					updatedAt: now,
				});
			return this.repo.putCell({
				projectId,
				branchId: branch,
				keyId,
				locale: code,
				value: input.value,
				lifecycle: "accepted",
				stale: false,
				origin: input.origin ?? "human",
				updatedBy: actor.userId,
				updatedAt: now,
			});
		}
		const existing = await this.repo.getCell(projectId, branch, keyId, code);
		return this.repo.putCell({
			projectId,
			branchId: branch,
			keyId,
			locale: code,
			value: input.value,
			head: existing?.head,
			lifecycle: "proposed",
			stale: false,
			sourceRef: key.sourceRevision,
			origin: input.origin ?? existing?.origin ?? "human",
			lockedByRunId: existing?.lockedByRunId,
			updatedBy: actor.userId,
			updatedAt: now,
		});
	}

	/** Set many draft values for one locale in a single call (bulk fill). */
	async bulkSet(
		actor: Actor,
		projectId: string,
		code: string,
		entries: SetTranslationInput[],
		branch = MAIN_BRANCH_ID,
	): Promise<BulkSetResult> {
		const { project } = await this.authorizeProject(
			actor,
			projectId,
			"translation.write",
		);
		await this.requireLocaleExists(projectId, code);
		const isBase = code === project.baseLocale;

		const allKeys = await this.repo.listKeyDefs(projectId, branch);
		const nsIds = new Map<string, string | undefined>();
		for (const ns of new Set(entries.map((e) => e.namespace ?? ""))) {
			nsIds.set(ns, await this.namespaces.idOf(projectId, ns));
		}
		const keyByLabel = new Map(
			allKeys.map((k) => [`${k.namespaceId ?? "_"}#${k.name}`, k]),
		);
		const prevByKey = new Map(
			(await this.repo.listCellsByLocale(projectId, branch, code)).map((c) => [
				c.keyId,
				c,
			]),
		);
		const now = new Date().toISOString();
		const toWrite: Translation[] = [];
		const baseKeyBumps: TranslationKey[] = [];
		const skipped: string[] = [];
		for (const e of entries) {
			const nsId = nsIds.get(e.namespace ?? "");
			const key = keyByLabel.get(`${nsId ?? "_"}#${e.name}`);
			if (!key) {
				skipped.push(e.namespace ? `${e.namespace}/${e.name}` : e.name);
				continue;
			}
			if (isBase) {
				const rev = revisionOf(e.value);
				if (rev !== key.sourceRevision)
					baseKeyBumps.push({ ...key, sourceRevision: rev, updatedAt: now });
				toWrite.push({
					projectId,
					branchId: branch,
					keyId: key.id,
					locale: code,
					value: e.value,
					lifecycle: "accepted",
					stale: false,
					origin: e.origin ?? "import",
					updatedBy: actor.userId,
					updatedAt: now,
				});
			} else {
				const prev = prevByKey.get(key.id);
				toWrite.push({
					projectId,
					branchId: branch,
					keyId: key.id,
					locale: code,
					value: e.value,
					head: prev?.head,
					lifecycle: "proposed",
					stale: false,
					sourceRef: key.sourceRevision,
					origin: e.origin ?? prev?.origin ?? "agent",
					lockedByRunId: prev?.lockedByRunId,
					updatedBy: actor.userId,
					updatedAt: now,
				});
			}
		}
		for (const k of baseKeyBumps) await this.repo.putKeyDef(branch, k);
		await this.repo.putCells(toWrite);
		return { written: toWrite.length, skipped };
	}

	/**
	 * Accept a cell's current draft as its new head version (the controlled write
	 * transition, via the repository's compare-and-swap). Reuses the
	 * `translation.review` permission. When the project requires human acceptance,
	 * a run-attributed accept (`runRef`) is rejected — only a person may flip it.
	 */
	async accept(
		actor: Actor,
		projectId: string,
		code: string,
		name: string,
		opts: { namespace?: string; branch?: string; runRef?: string } = {},
	): Promise<Translation> {
		const { project } = await this.authorizeProject(
			actor,
			projectId,
			"translation.review",
		);
		if (opts.runRef && project.requireHumanAccept)
			throw forbidden(
				"This project requires a human to accept; a run cannot self-accept.",
			);
		await this.requireLocaleExists(projectId, code);
		const branch = opts.branch ?? MAIN_BRANCH_ID;
		const { keyId, key } = await this.resolveKey(
			projectId,
			branch,
			name,
			opts.namespace,
		);
		const cell = await this.repo.getCell(projectId, branch, keyId, code);
		if (!cell) throw notFound(`No ${code} translation for ${name}`);
		if (cell.value.trim() === "")
			throw validation("Cannot accept an empty translation");
		return this.repo.acceptCell({
			projectId,
			branchId: branch,
			keyId,
			locale: code,
			value: cell.value,
			origin: cell.origin,
			sourceRevision: key.sourceRevision,
			acceptedBy: opts.runRef ? undefined : actor.userId,
			runRef: opts.runRef,
			expectedHead: cell.head,
			updatedBy: actor.userId,
		});
	}

	// ---- internals ------------------------------------------------------------

	private async resolveKey(
		projectId: string,
		branch: string,
		name: string,
		namespace?: string,
	): Promise<{ keyId: string; key: TranslationKey }> {
		const nsId = await this.namespaces.idOf(projectId, namespace);
		if (namespace && !nsId)
			throw notFound(`Key ${namespace}/${name} not found`);
		const keyId = await this.repo.resolveKeyIdByName(
			projectId,
			branch,
			nsId,
			name,
		);
		const key = keyId
			? await this.repo.getKeyDef(projectId, branch, keyId)
			: undefined;
		if (!keyId || !key) throw notFound(`Key ${name} not found`);
		return { keyId, key };
	}
}
