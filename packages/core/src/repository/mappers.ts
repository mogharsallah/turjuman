// ---- item <-> domain mapping ------------------------------------------------
//
// One mapper per entity: unpack a raw single-table Item into its domain shape.
// They are deliberately per-entity (no shared abstraction) so each entity's
// stored attributes are explicit and independently changeable.

import type {
	ApiKey,
	GlobalRole,
	GlossaryTerm,
	KeyState,
	Locale,
	Membership,
	Project,
	ProjectRole,
	QaConfig,
	QaIgnoreRule,
	ScoreConfig,
	Translation,
	TranslationKey,
	TranslationOrigin,
	TranslationStatus,
	User,
	Webhook,
} from "@turjuman/schema";
import type { Item } from "./item.js";
import { keyGSI3PK, keySK, locGSI3SK, transPK } from "./keys.js";

export function translationItem(t: Translation): Item {
	return {
		PK: transPK(t.projectId, t.localeCode),
		SK: keySK(t.namespace, t.keyName),
		GSI3PK: keyGSI3PK(t.projectId, t.namespace, t.keyName),
		GSI3SK: locGSI3SK(t.localeCode),
		entityType: "Translation",
		...t,
	};
}

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
		createdAt: i.createdAt as string,
	};
}

export function toKey(i: Item): TranslationKey {
	return {
		projectId: i.projectId as string,
		namespace: i.namespace as string,
		name: i.name as string,
		description: i.description as string | undefined,
		plural: Boolean(i.plural),
		maxLength: i.maxLength as number | undefined,
		tags: (i.tags as string[] | undefined) ?? [],
		state: (i.state as KeyState | undefined) ?? "active",
		lastSeenAt: i.lastSeenAt as string | undefined,
		createdAt: i.createdAt as string,
		updatedAt: i.updatedAt as string,
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
		term: i.term as string,
		translations: (i.translations as Record<string, string> | undefined) ?? {},
		caseSensitive: Boolean(i.caseSensitive),
		doNotTranslate: Boolean(i.doNotTranslate),
		notes: i.notes as string | undefined,
		createdAt: i.createdAt as string,
		updatedAt: i.updatedAt as string,
	};
}

export function toTranslation(i: Item): Translation {
	return {
		projectId: i.projectId as string,
		localeCode: i.localeCode as string,
		namespace: i.namespace as string,
		keyName: i.keyName as string,
		value: i.value as string,
		status: i.status as TranslationStatus,
		approvedValue: i.approvedValue as string | undefined,
		sourceRef: i.sourceRef as string | undefined,
		origin: i.origin as TranslationOrigin | undefined,
		score: i.score as number | undefined,
		scoreComment: i.scoreComment as string | undefined,
		scoredBy: i.scoredBy as string | undefined,
		scoredAt: i.scoredAt as string | undefined,
		scoreModel: i.scoreModel as string | undefined,
		promptVersion: i.promptVersion as string | undefined,
		updatedBy: i.updatedBy as string,
		updatedAt: i.updatedAt as string,
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

export function toScoreConfig(i: Item): ScoreConfig {
	return {
		projectId: i.projectId as string,
		threshold: (i.threshold as number | undefined) ?? 90,
		autoApprove: Boolean(i.autoApprove),
		guidance: i.guidance as string | undefined,
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
