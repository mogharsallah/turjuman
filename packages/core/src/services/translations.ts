import type { Actor, BulkSetResult } from "@turjuman/schema";
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
import { resolveKeyRef } from "./keyref.js";
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

/**
 * Whether a target cell is stale — the **union** of the two invalidation
 * triggers: an explicit `stale` flag (set by the context-change fan-out) or a
 * base revision that has since moved on (`sourceRef !== key.sourceRevision`).
 * The base locale is the source and is never evaluated here.
 */
export function isStale(cell: Translation, key: TranslationKey): boolean {
	return (
		cell.stale ||
		(cell.sourceRef !== undefined && cell.sourceRef !== key.sourceRevision)
	);
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
		const { keyId } = await resolveKeyRef(
			this.repo,
			this.namespaces,
			projectId,
			branch,
			name,
			namespace,
		);
		// Resolved: include cells inherited from the parent chain on a child branch.
		return this.repo.listCellsByKeyResolved(projectId, branch, keyId);
	}

	async listForLocale(
		actor: Actor,
		projectId: string,
		code: string,
		branch = MAIN_BRANCH_ID,
	): Promise<Translation[]> {
		await this.authorizeProject(actor, projectId, "translation.read");
		await this.requireLocaleExists(projectId, code);
		// Resolved: a child branch's locale view overlays inherited cells too.
		return this.repo.listCellsByLocaleResolved(projectId, branch, code);
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
		// Resolved lists: a child branch's export includes keys/cells inherited from
		// the parent chain, not just the rows the branch itself wrote.
		const [keys, cells, nsNames] = await Promise.all([
			this.repo.listKeyDefsResolved(projectId, branch),
			this.repo.listCellsByLocaleResolved(projectId, branch, code),
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
						await this.repo.listCellsByLocaleResolved(
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
			this.repo.listKeyDefsResolved(projectId, branch),
			this.repo.listCellsByLocaleResolved(projectId, branch, code),
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
			this.repo.listKeyDefsResolved(projectId, branch),
			this.repo.listCellsByLocaleResolved(projectId, branch, code),
		]);
		const keyById = new Map(keys.map((k) => [k.id, k]));
		const staleIds = new Set(
			cells
				.filter((c) => {
					const k = keyById.get(c.keyId);
					return k !== undefined && isStale(c, k);
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
			return c !== undefined && isStale(c, k);
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
		const { keyId, key } = await resolveKeyRef(
			this.repo,
			this.namespaces,
			projectId,
			branch,
			input.name,
			input.namespace,
		);
		const now = new Date().toISOString();
		if (code === project.baseLocale) {
			// Writing the source: bump the key's revision (staling dependents) and
			// append the value as a version, so the source carries a head→version
			// chain a release can pin (a plain overwrite would orphan the chain).
			const rev = revisionOf(input.value);
			if (rev !== key.sourceRevision)
				await this.repo.putKeyDef(branch, {
					...key,
					sourceRevision: rev,
					updatedAt: now,
				});
			return this.writeSourceValue({
				projectId,
				branchId: branch,
				keyId,
				locale: code,
				value: input.value,
				origin: input.origin ?? "human",
				userId: actor.userId,
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

		// Resolved key index: a child branch bulk-set also addresses inherited keys.
		const allKeys = await this.repo.listKeyDefsResolved(projectId, branch);
		// Resolve every referenced namespace name in a single read (repeated idOf
		// would run one full-partition query per distinct namespace).
		const idByName = await this.namespaces.idMap(projectId);
		const keyByLabel = new Map(
			allKeys.map((k) => [`${k.namespaceId ?? "_"}#${k.name}`, k]),
		);
		// Resolved cells: carry an inherited head so a draft on a child branch keeps
		// the parent's version chain, matching the singular set()'s fall-through.
		const prevByKey = new Map(
			(await this.repo.listCellsByLocaleResolved(projectId, branch, code)).map(
				(c) => [c.keyId, c],
			),
		);
		const now = new Date().toISOString();
		const toWrite: Translation[] = [];
		const baseKeyBumps: TranslationKey[] = [];
		const skipped: string[] = [];
		let baseWritten = 0;
		for (const e of entries) {
			const nsName = (e.namespace ?? "").trim();
			const nsId = nsName ? idByName.get(nsName) : undefined;
			// A named-but-unknown namespace is reported, never silently bucketed into
			// the no-namespace slot (where it could mis-match a namespace-less key).
			if (nsName && !nsId) {
				skipped.push(`${e.namespace}/${e.name}`);
				continue;
			}
			const key = keyByLabel.get(`${nsId ?? "_"}#${e.name}`);
			if (!key) {
				skipped.push(e.namespace ? `${e.namespace}/${e.name}` : e.name);
				continue;
			}
			if (isBase) {
				const rev = revisionOf(e.value);
				if (rev !== key.sourceRevision)
					baseKeyBumps.push({ ...key, sourceRevision: rev, updatedAt: now });
				// Append the source value (accept-append), like set()'s base path.
				await this.writeSourceValue({
					projectId,
					branchId: branch,
					keyId: key.id,
					locale: code,
					value: e.value,
					origin: e.origin ?? "import",
					userId: actor.userId,
				});
				baseWritten++;
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
					updatedBy: actor.userId,
					updatedAt: now,
				});
			}
		}
		for (const k of baseKeyBumps) await this.repo.putKeyDef(branch, k);
		await this.repo.putCells(toWrite);
		return { written: baseWritten + toWrite.length, skipped };
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
		// Enforce off the authenticated principal, never the caller-supplied runRef
		// (which is only attribution) — an agent key cannot accept under
		// requireHumanAccept even if it omits runRef.
		if (project.requireHumanAccept && actor.principal === "agent")
			throw forbidden(
				"This project requires a human to accept; an agent key cannot self-accept.",
			);
		await this.requireLocaleExists(projectId, code);
		const branch = opts.branch ?? MAIN_BRANCH_ID;
		const { keyId, key } = await resolveKeyRef(
			this.repo,
			this.namespaces,
			projectId,
			branch,
			name,
			opts.namespace,
		);
		// Materialize an inherited cell onto this branch so the accept compare-and-swap
		// targets a real child row (on main, or an owned cell, this is a plain read).
		const cell = await this.repo.materializeCell(
			projectId,
			branch,
			keyId,
			code,
		);
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
}
