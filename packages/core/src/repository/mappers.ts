// ---- item <-> domain mapping ------------------------------------------------
//
// One mapper per entity: unpack a raw single-table Item into its domain shape,
// and (for the multi-key entities) pack a domain value into its stored Item.
// They are deliberately per-entity (no shared abstraction) so each entity's
// stored attributes are explicit and independently changeable.

import type {
	ApiKey,
	Branch,
	BranchStatus,
	CellLifecycle,
	Comment,
	ContextLifecycle,
	ContextOperator,
	ContextRule,
	ContextRuleKind,
	Escalation,
	EscalationStatus,
	Example,
	ExampleQuality,
	FieldReport,
	FieldReportStatus,
	GlobalRole,
	GlossaryTerm,
	KeyState,
	Locale,
	Membership,
	Namespace,
	Placement,
	Project,
	ProjectRole,
	QaConfig,
	QaIgnoreRule,
	Release,
	ReleaseEntry,
	ReleaseStatus,
	RunStatus,
	RunTrigger,
	Scope,
	Translation,
	TranslationKey,
	TranslationOrigin,
	TranslationRun,
	TranslationVersion,
	User,
	Webhook,
} from "@turjuman/schema";
import type { Item } from "./item.js";
import {
	cellGSI3PK,
	cellGSI3SK,
	cellPK,
	cellSK,
	keyDefPK,
	keyDefSK,
	keyNameSK,
	releaseEntryPK,
	releaseEntrySK,
	versionSK,
} from "./keys.js";

// ---- item builders (multi-row / indexed entities) ---------------------------

/** The live, mutable translation cell — carries the "by key" GSI3 projection. */
export function cellItem(t: Translation): Item {
	return {
		PK: cellPK(t.projectId, t.branchId, t.locale),
		SK: cellSK(t.keyId),
		GSI3PK: cellGSI3PK(t.projectId, t.branchId, t.keyId),
		GSI3SK: cellGSI3SK(t.locale),
		entityType: "Translation",
		...t,
	};
}

/** An append-only accepted-value commit. Co-located with its cell; no GSI3. */
export function versionItem(v: TranslationVersion): Item {
	return {
		PK: cellPK(v.projectId, v.branchId, v.locale),
		SK: versionSK(v.keyId, v.seq),
		entityType: "TranslationVersion",
		...v,
	};
}

/** A key definition on one branch (addressed by opaque `keyId`). */
export function keyDefItem(branchId: string, k: TranslationKey): Item {
	return {
		PK: keyDefPK(k.projectId, branchId),
		SK: keyDefSK(k.id),
		entityType: "TranslationKey",
		...k,
	};
}

/** The `(namespace, name) -> keyId` lookup row for a key on one branch. */
export function keyNameItem(branchId: string, k: TranslationKey): Item {
	return {
		PK: keyDefPK(k.projectId, branchId),
		SK: keyNameSK(k.namespaceId, k.name),
		entityType: "KeyName",
		keyId: k.id,
	};
}

/** A release's pinned entry row, co-located in the release's own partition. */
export function releaseEntryItem(
	projectId: string,
	releaseId: string,
	e: ReleaseEntry,
): Item {
	return {
		PK: releaseEntryPK(projectId, releaseId),
		SK: releaseEntrySK(e.keyId, e.locale),
		entityType: "ReleaseEntry",
		projectId,
		releaseId,
		...e,
	};
}

// ---- item readers -----------------------------------------------------------

export function toUser(i: Item): User {
	return {
		id: i.id as string,
		orgId: i.orgId as string,
		email: i.email as string,
		name: i.name as string,
		globalRole: i.globalRole as GlobalRole,
		createdAt: i.createdAt as string,
		updatedAt: i.updatedAt as string,
	};
}

export function toApiKey(i: Item): ApiKey {
	return {
		id: i.id as string,
		orgId: i.orgId as string,
		userId: i.userId as string,
		name: i.name as string,
		hash: i.hash as string,
		prefix: i.prefix as string,
		createdAt: i.createdAt as string,
		lastUsedAt: i.lastUsedAt as string | undefined,
		expiresAt: i.expiresAt as string | undefined,
		readOnly: i.readOnly as boolean | undefined,
	};
}

export function toProject(i: Item): Project {
	return {
		id: i.id as string,
		orgId: i.orgId as string,
		name: i.name as string,
		slug: i.slug as string,
		description: i.description as string | undefined,
		baseLocale: i.baseLocale as string,
		contextRevision: (i.contextRevision as number | undefined) ?? 0,
		requireHumanAccept: Boolean(i.requireHumanAccept),
		createdAt: i.createdAt as string,
		updatedAt: i.updatedAt as string,
	};
}

export function toMembership(i: Item): Membership {
	return {
		projectId: i.projectId as string,
		userId: i.userId as string,
		role: i.role as ProjectRole,
		createdAt: i.createdAt as string,
	};
}

export function toLocale(i: Item): Locale {
	return {
		projectId: i.projectId as string,
		code: i.code as string,
		name: i.name as string | undefined,
		lifecycle: (i.lifecycle as KeyState | undefined) ?? "active",
		createdAt: i.createdAt as string,
	};
}

export function toNamespace(i: Item): Namespace {
	return {
		id: i.id as string,
		projectId: i.projectId as string,
		name: i.name as string,
		title: i.title as string | undefined,
		description: i.description as string | undefined,
		lifecycle: (i.lifecycle as KeyState | undefined) ?? "active",
		createdAt: i.createdAt as string,
		updatedAt: i.updatedAt as string,
	};
}

export function toKey(i: Item): TranslationKey {
	return {
		id: i.id as string,
		projectId: i.projectId as string,
		namespaceId: i.namespaceId as string | undefined,
		name: i.name as string,
		description: i.description as string | undefined,
		plural: Boolean(i.plural),
		maxLength: i.maxLength as number | undefined,
		tags: (i.tags as string[] | undefined) ?? [],
		state: (i.state as KeyState | undefined) ?? "active",
		noTranslate: i.noTranslate as boolean | undefined,
		sourceRevision: (i.sourceRevision as string | undefined) ?? "",
		introducedOnBranchId: i.introducedOnBranchId as string | undefined,
		placements: i.placements as Placement[] | undefined,
		lastSeenAt: i.lastSeenAt as string | undefined,
		createdAt: i.createdAt as string,
		updatedAt: i.updatedAt as string,
	};
}

export function toBranch(i: Item): Branch {
	return {
		id: i.id as string,
		projectId: i.projectId as string,
		name: i.name as string,
		parentBranchId: (i.parentBranchId as string | null | undefined) ?? null,
		forkPoint: i.forkPoint as string | undefined,
		status: i.status as BranchStatus,
		createdBy: i.createdBy as string,
		createdAt: i.createdAt as string,
		mergedAt: i.mergedAt as string | undefined,
	};
}

export function toWebhook(i: Item): Webhook {
	return {
		projectId: i.projectId as string,
		id: i.id as string,
		url: i.url as string,
		events: (i.events as Webhook["events"] | undefined) ?? ["*"],
		secret: i.secret as string,
		createdAt: i.createdAt as string,
	};
}

export function toGlossaryTerm(i: Item): GlossaryTerm {
	return {
		projectId: i.projectId as string,
		id: i.id as string,
		scope: i.scope as Scope | undefined,
		term: i.term as string,
		translations: (i.translations as Record<string, string> | undefined) ?? {},
		caseSensitive: Boolean(i.caseSensitive),
		doNotTranslate: Boolean(i.doNotTranslate),
		notes: i.notes as string | undefined,
		lifecycle: (i.lifecycle as ContextLifecycle | undefined) ?? "active",
		createdAt: i.createdAt as string,
		updatedAt: i.updatedAt as string,
	};
}

// ---- context layer + review records -----------------------------------------

export function toContextRule(i: Item): ContextRule {
	return {
		id: i.id as string,
		projectId: i.projectId as string,
		scope: i.scope as Scope,
		kind: i.kind as ContextRuleKind,
		operator: i.operator as ContextOperator,
		payload: (i.payload as Record<string, unknown> | undefined) ?? {},
		hard: i.hard as boolean | undefined,
		lifecycle: (i.lifecycle as ContextLifecycle | undefined) ?? "active",
		createdBy: i.createdBy as string,
		createdAt: i.createdAt as string,
		updatedAt: i.updatedAt as string,
	};
}

export function toExample(i: Item): Example {
	return {
		id: i.id as string,
		projectId: i.projectId as string,
		scope: i.scope as Scope,
		locale: i.locale as string,
		sourceText: i.sourceText as string,
		targetText: i.targetText as string,
		quality: i.quality as ExampleQuality,
		origin: i.origin as TranslationOrigin | undefined,
		lifecycle: (i.lifecycle as ContextLifecycle | undefined) ?? "active",
		createdAt: i.createdAt as string,
		updatedAt: i.updatedAt as string,
	};
}

export function toComment(i: Item): Comment {
	return {
		id: i.id as string,
		projectId: i.projectId as string,
		keyId: i.keyId as string,
		locale: i.locale as string,
		authorId: i.authorId as string,
		body: i.body as string,
		parentId: i.parentId as string | undefined,
		createdAt: i.createdAt as string,
	};
}

export function toEscalation(i: Item): Escalation {
	return {
		id: i.id as string,
		projectId: i.projectId as string,
		branchId: i.branchId as string,
		keyId: i.keyId as string,
		locale: i.locale as string,
		reason: i.reason as string,
		assigneeUserId: i.assigneeUserId as string | undefined,
		claimedBy: i.claimedBy as string | undefined,
		claimedAt: i.claimedAt as string | undefined,
		status: i.status as EscalationStatus,
		openedAt: i.openedAt as string,
		resolvedAt: i.resolvedAt as string | undefined,
		resolution: i.resolution as Escalation["resolution"],
	};
}

// ---- releases + field reports -----------------------------------------------

/** The release metadata row. `entries` are stored as separate rows in the
 * release's own partition, so a metadata read leaves them empty; the repository
 * fills them from those rows on {@link Repository.getRelease}. */
export function toRelease(i: Item): Release {
	return {
		id: i.id as string,
		projectId: i.projectId as string,
		branchId: i.branchId as string,
		label: i.label as string,
		locales: (i.locales as string[] | undefined) ?? [],
		status: i.status as ReleaseStatus,
		createdBy: i.createdBy as string,
		createdAt: i.createdAt as string,
		entries: [],
	};
}

export function toReleaseEntry(i: Item): ReleaseEntry {
	return {
		keyId: i.keyId as string,
		locale: i.locale as string,
		versionRef: i.versionRef as number,
	};
}

export function toFieldReport(i: Item): FieldReport {
	return {
		id: i.id as string,
		projectId: i.projectId as string,
		branchId: i.branchId as string,
		keyId: i.keyId as string,
		locale: i.locale as string,
		releaseRef: i.releaseRef as string | undefined,
		description: i.description as string,
		status: i.status as FieldReportStatus,
		reportedBy: i.reportedBy as string,
		createdAt: i.createdAt as string,
		resolvedAt: i.resolvedAt as string | undefined,
		resolution: i.resolution as FieldReport["resolution"],
	};
}

export function toCell(i: Item): Translation {
	return {
		projectId: i.projectId as string,
		branchId: i.branchId as string,
		keyId: i.keyId as string,
		locale: i.locale as string,
		value: i.value as string,
		head: i.head as number | undefined,
		lifecycle: i.lifecycle as CellLifecycle,
		stale: Boolean(i.stale),
		sourceRef: i.sourceRef as string | undefined,
		origin: i.origin as TranslationOrigin | undefined,
		lockedByRunId: i.lockedByRunId as string | undefined,
		updatedBy: i.updatedBy as string,
		updatedAt: i.updatedAt as string,
	};
}

export function toVersion(i: Item): TranslationVersion {
	return {
		projectId: i.projectId as string,
		branchId: i.branchId as string,
		keyId: i.keyId as string,
		locale: i.locale as string,
		seq: i.seq as number,
		value: i.value as string,
		origin: i.origin as TranslationOrigin | undefined,
		acceptedAt: i.acceptedAt as string,
		acceptedBy: i.acceptedBy as string | undefined,
		runRef: i.runRef as string | undefined,
		sourceRevision: i.sourceRevision as string | undefined,
		prevVersionRef: i.prevVersionRef as number | undefined,
		supersededBy: i.supersededBy as number | undefined,
	};
}

export function toRun(i: Item): TranslationRun {
	return {
		id: i.id as string,
		projectId: i.projectId as string,
		branchId: i.branchId as string,
		trigger: i.trigger as RunTrigger,
		valueSource: i.valueSource as string,
		status: i.status as RunStatus,
		idempotencyKey: i.idempotencyKey as string | undefined,
		budgetSpent: i.budgetSpent as number | undefined,
		cellsTotal: i.cellsTotal as number,
		cellsDone: i.cellsDone as number,
		errors: (i.errors as string[] | undefined) ?? [],
		startedAt: i.startedAt as string,
		finishedAt: i.finishedAt as string | undefined,
	};
}

export function toQaConfig(i: Item): QaConfig {
	return {
		projectId: i.projectId as string,
		checks: (i.checks as QaConfig["checks"] | undefined) ?? {},
		ignore: (i.ignore as QaIgnoreRule[] | undefined) ?? [],
		updatedBy: i.updatedBy as string,
		updatedAt: i.updatedAt as string,
	};
}

export function isConditionalFailure(err: unknown): boolean {
	const name = (err as { name?: string })?.name ?? "";
	return (
		name === "ConditionalCheckFailedException" ||
		name === "TransactionCanceledException"
	);
}
