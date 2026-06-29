import type { Actor, TurjumanService, User } from "@turjuman/core";
import type { OpContext } from "../base.js";

/**
 * Independent oracle for the L0 handler arg-mapping contract (see TESTING.md and
 * `../handlers.contract.test.ts`).
 *
 * Every entry is **hand-authored** — it does NOT derive from the handler bodies
 * it checks, so the contract test is a real `(input) → (service call)` oracle and
 * not an `X === X` tautology. The discipline each fixture follows:
 *
 *  - `input` carries a **distinct sentinel per top-level string field** (e.g.
 *    `name:"N_name"`, `namespace:"NS_ns"`), so a positional `name`↔`namespace`
 *    swap in a handler can't pass. Values are chosen to be invariant under the
 *    input schema's transforms (already-trimmed, already-lowercase) so the parsed
 *    input equals the authored input — the meta-test enforces that.
 *  - `calls` is the exact, ordered list of service methods the handler must fire,
 *    with each positional argument spelled out (the {@link ACTOR} sentinel in the
 *    actor slot). The contract test asserts these and nothing else fired.
 *  - `returns` is the canned value the spied service method resolves to — needed
 *    by handlers that re-wrap the result (`list_untranslated`, `create_api_key`),
 *    which would otherwise read fields off `undefined`.
 *  - `result`, when present, is the hand-authored expected handler return value —
 *    the oracle for the ~9 ops that synthesize a response instead of passing the
 *    service result straight through.
 *
 * Branchy ops (`list_keys`, `get_translations`, `search_keys` default-limit) are
 * an **array of named variants**, one per branch; the throw branch of
 * `get_translations` is a bespoke `it` in the test file.
 */

/** The authenticated caller threaded through every handler. A fixed sentinel so
 * expected `calls` can assert "the actor was forwarded into slot 0" by identity. */
export const ACTOR: Actor = {
	userId: "actor-sentinel",
	orgId: "org-sentinel",
	globalRole: "OWNER",
};

const USER: User = {
	id: "user-sentinel",
	orgId: "org-sentinel",
	email: "user-sentinel@ex.co",
	name: "User Sentinel",
	globalRole: "OWNER",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

/** Build a fresh OpContext around a spy service. */
export function makeCtx(service: TurjumanService): OpContext {
	return { service, actor: ACTOR, user: USER, requestId: "req-sentinel" };
}

/**
 * A call-recording stand-in for `TurjumanService`: every `service.<sub>.<method>`
 * access resolves to a function that records `{ method: "<sub>.<method>", args }`
 * and returns `Promise.resolve(returns)`. No business logic — this layer only
 * proves the handler's wiring, so a pure recorder is exactly the right oracle.
 */
export function spyService(returns: unknown): {
	service: TurjumanService;
	calls: { method: string; args: unknown[] }[];
} {
	const calls: { method: string; args: unknown[] }[] = [];
	const service = new Proxy(
		{},
		{
			get(_t, sub) {
				if (typeof sub !== "string") return undefined;
				return new Proxy(
					{},
					{
						get(_t2, method) {
							if (typeof method !== "string") return undefined;
							return (...args: unknown[]) => {
								calls.push({ method: `${sub}.${method}`, args });
								return Promise.resolve(returns);
							};
						},
					},
				);
			},
		},
	) as unknown as TurjumanService;
	return { service, calls };
}

export interface ExpectedCall {
	/** "<subService>.<method>", e.g. "projects.get". */
	method: string;
	/** The exact positional args the handler must pass (ACTOR sentinel in slot 0). */
	args: unknown[];
}

export interface OpFixture {
	/** Display label for a branch variant (omit for single-fixture ops). */
	variant?: string;
	input: Record<string, unknown>;
	/** Canned service return; defaults to undefined. */
	returns?: unknown;
	/** The exact, ordered service calls the handler must make. */
	calls: ExpectedCall[];
	/** Hand-authored expected handler return — set only for synthesized responses. */
	result?: unknown;
}

/** A canned page returned by the paged list/queue services that re-wrap their result. */
const PAGE = { keys: ["K1", "K2"], nextCursor: "NC_next" };
const PAGE_RESULT = (locale: string) => ({
	locale,
	count: 2,
	keys: ["K1", "K2"],
	nextCursor: "NC_next",
});

export const OP_FIXTURES: Record<string, OpFixture | OpFixture[]> = {
	// ---- projects + locales ----------------------------------------------------
	list_projects: {
		input: {},
		calls: [{ method: "projects.list", args: [ACTOR] }],
	},
	get_project: {
		input: { projectId: "P_projectId" },
		calls: [{ method: "projects.get", args: [ACTOR, "P_projectId"] }],
	},
	create_project: {
		input: { name: "N_name", baseLocale: "zz", description: "D_description" },
		calls: [
			{
				method: "projects.create",
				args: [
					ACTOR,
					{ name: "N_name", baseLocale: "zz", description: "D_description" },
				],
			},
		],
	},
	update_project: {
		input: {
			projectId: "P_projectId",
			name: "N_name",
			description: "D_description",
			baseLocale: "zz",
			requireHumanAccept: true,
		},
		calls: [
			{
				method: "projects.update",
				args: [
					ACTOR,
					"P_projectId",
					{
						name: "N_name",
						description: "D_description",
						baseLocale: "zz",
						requireHumanAccept: true,
					},
				],
			},
		],
	},
	list_locales: {
		input: { projectId: "P_projectId" },
		calls: [{ method: "locales.list", args: [ACTOR, "P_projectId"] }],
	},
	add_locale: {
		input: { projectId: "P_projectId", code: "zz", name: "N_name" },
		calls: [
			{ method: "locales.add", args: [ACTOR, "P_projectId", "zz", "N_name"] },
		],
	},

	// ---- branches --------------------------------------------------------------
	list_branches: {
		input: { projectId: "P_projectId" },
		calls: [{ method: "branches.list", args: [ACTOR, "P_projectId"] }],
	},
	get_branch: {
		input: { projectId: "P_projectId", branch: "BR_branch" },
		calls: [
			{ method: "branches.get", args: [ACTOR, "P_projectId", "BR_branch"] },
		],
	},

	// ---- namespaces ------------------------------------------------------------
	list_namespaces: {
		input: { projectId: "P_projectId" },
		calls: [{ method: "namespaces.list", args: [ACTOR, "P_projectId"] }],
	},
	get_namespace: {
		input: { projectId: "P_projectId", namespaceId: "NSID_namespaceId" },
		calls: [
			{
				method: "namespaces.get",
				args: [ACTOR, "P_projectId", "NSID_namespaceId"],
			},
		],
	},
	create_namespace: {
		input: {
			projectId: "P_projectId",
			name: "NS_ns",
			title: "TI_title",
			description: "D_description",
		},
		calls: [
			{
				method: "namespaces.create",
				args: [
					ACTOR,
					"P_projectId",
					{ name: "NS_ns", title: "TI_title", description: "D_description" },
				],
			},
		],
	},
	update_namespace: {
		input: {
			projectId: "P_projectId",
			namespaceId: "NSID_namespaceId",
			name: "NS_ns",
			title: "TI_title",
			description: "D_description",
			lifecycle: "active",
		},
		calls: [
			{
				method: "namespaces.update",
				args: [
					ACTOR,
					"P_projectId",
					"NSID_namespaceId",
					{
						name: "NS_ns",
						title: "TI_title",
						description: "D_description",
						lifecycle: "active",
					},
				],
			},
		],
	},

	// ---- keys ------------------------------------------------------------------
	list_keys: [
		{
			variant: "paged (limit/cursor present)",
			input: {
				projectId: "P_projectId",
				namespace: "NS_ns",
				branch: "BR_branch",
				tag: "T_tag",
				limit: 7,
				cursor: "CUR_cursor",
			},
			calls: [
				{
					method: "keys.listPage",
					args: [
						ACTOR,
						"P_projectId",
						{
							branch: "BR_branch",
							namespace: "NS_ns",
							tag: "T_tag",
							limit: 7,
							cursor: "CUR_cursor",
						},
					],
				},
			],
		},
		{
			variant: "unpaged (no limit/cursor, no branch)",
			input: { projectId: "P_projectId", namespace: "NS_ns", tag: "T_tag" },
			calls: [
				{
					method: "keys.list",
					args: [
						ACTOR,
						"P_projectId",
						{ branch: undefined, namespace: "NS_ns", tag: "T_tag" },
					],
				},
			],
		},
	],
	search_keys: [
		{
			variant: "explicit limit + branch",
			input: {
				projectId: "P_projectId",
				query: "Q_query",
				branch: "BR_branch",
				limit: 7,
				cursor: "CUR_cursor",
			},
			calls: [
				{
					method: "keys.searchPage",
					args: [
						ACTOR,
						"P_projectId",
						"Q_query",
						{ branch: "BR_branch", limit: 7, cursor: "CUR_cursor" },
					],
				},
			],
		},
		{
			variant: "default limit (?? 100), no branch",
			input: {
				projectId: "P_projectId",
				query: "Q_query",
				cursor: "CUR_cursor",
			},
			calls: [
				{
					method: "keys.searchPage",
					args: [
						ACTOR,
						"P_projectId",
						"Q_query",
						{ branch: undefined, limit: 100, cursor: "CUR_cursor" },
					],
				},
			],
		},
	],
	get_key: {
		input: {
			projectId: "P_projectId",
			name: "N_name",
			namespace: "NS_ns",
			branch: "BR_branch",
		},
		calls: [
			{
				method: "keys.get",
				args: [ACTOR, "P_projectId", "N_name", "NS_ns", "BR_branch"],
			},
		],
	},
	create_key: {
		input: {
			projectId: "P_projectId",
			name: "N_name",
			namespace: "NS_ns",
			branch: "BR_branch",
			description: "D_description",
			plural: true,
			maxLength: 99,
			tags: ["TG_tag1"],
			baseValue: "BV_baseValue",
		},
		calls: [
			{
				method: "keys.create",
				args: [
					ACTOR,
					"P_projectId",
					{
						name: "N_name",
						namespace: "NS_ns",
						branch: "BR_branch",
						description: "D_description",
						plural: true,
						maxLength: 99,
						tags: ["TG_tag1"],
						baseValue: "BV_baseValue",
					},
				],
			},
		],
	},
	update_key: {
		input: {
			projectId: "P_projectId",
			name: "N_name",
			namespace: "NS_ns",
			branch: "BR_branch",
			description: "D_description",
			plural: true,
			maxLength: 99,
			tags: ["TG_tag1"],
			noTranslate: true,
		},
		calls: [
			{
				method: "keys.update",
				args: [
					ACTOR,
					"P_projectId",
					"N_name",
					{
						description: "D_description",
						plural: true,
						maxLength: 99,
						tags: ["TG_tag1"],
						noTranslate: true,
					},
					"NS_ns",
					"BR_branch",
				],
			},
		],
	},
	rename_key: {
		input: {
			projectId: "P_projectId",
			name: "N_name",
			namespace: "NS_ns",
			branch: "BR_branch",
			newName: "NN_newName",
			newNamespace: "NNS_newNamespace",
		},
		calls: [
			{
				method: "keys.rename",
				args: [
					ACTOR,
					"P_projectId",
					"N_name",
					{ name: "NN_newName", namespace: "NNS_newNamespace" },
					"NS_ns",
					"BR_branch",
				],
			},
		],
	},
	delete_key: {
		input: {
			projectId: "P_projectId",
			name: "N_name",
			namespace: "NS_ns",
			branch: "BR_branch",
			confirm: true,
		},
		calls: [
			{
				method: "keys.delete",
				args: [ACTOR, "P_projectId", "N_name", true, "NS_ns", "BR_branch"],
			},
		],
		result: { deleted: "N_name" },
	},

	// ---- translations ----------------------------------------------------------
	get_translations: [
		{
			variant: "by key (name present)",
			input: {
				projectId: "P_projectId",
				name: "N_name",
				namespace: "NS_ns",
				branch: "BR_branch",
			},
			calls: [
				{
					method: "translations.listForKey",
					args: [ACTOR, "P_projectId", "N_name", "NS_ns", "BR_branch"],
				},
			],
		},
		{
			variant: "by locale (paged, no branch)",
			input: {
				projectId: "P_projectId",
				locale: "zz",
				limit: 7,
				cursor: "CUR_cursor",
			},
			calls: [
				{
					method: "translations.listForLocalePage",
					args: [
						ACTOR,
						"P_projectId",
						"zz",
						{ branch: undefined, limit: 7, cursor: "CUR_cursor" },
					],
				},
			],
		},
	],
	list_untranslated: {
		input: {
			projectId: "P_projectId",
			locale: "zz",
			branch: "BR_branch",
			limit: 7,
			cursor: "CUR_cursor",
		},
		returns: PAGE,
		calls: [
			{
				method: "translations.listUntranslatedPage",
				args: [
					ACTOR,
					"P_projectId",
					"zz",
					{ branch: "BR_branch", limit: 7, cursor: "CUR_cursor" },
				],
			},
		],
		result: PAGE_RESULT("zz"),
	},
	list_stale: {
		input: {
			projectId: "P_projectId",
			locale: "zz",
			branch: "BR_branch",
			limit: 7,
			cursor: "CUR_cursor",
		},
		returns: PAGE,
		calls: [
			{
				method: "translations.listStalePage",
				args: [
					ACTOR,
					"P_projectId",
					"zz",
					{ branch: "BR_branch", limit: 7, cursor: "CUR_cursor" },
				],
			},
		],
		result: PAGE_RESULT("zz"),
	},
	set_translation: {
		input: {
			projectId: "P_projectId",
			locale: "zz",
			name: "N_name",
			namespace: "NS_ns",
			branch: "BR_branch",
			value: "V_value",
		},
		calls: [
			{
				method: "translations.set",
				args: [
					ACTOR,
					"P_projectId",
					"zz",
					{
						name: "N_name",
						namespace: "NS_ns",
						branch: "BR_branch",
						value: "V_value",
						origin: "agent",
					},
				],
			},
		],
	},
	bulk_set_translations: {
		input: {
			projectId: "P_projectId",
			locale: "zz",
			branch: "BR_branch",
			entries: [{ name: "N_name", namespace: "NS_ns", value: "V_value" }],
		},
		calls: [
			{
				method: "translations.bulkSet",
				args: [
					ACTOR,
					"P_projectId",
					"zz",
					[
						{
							name: "N_name",
							namespace: "NS_ns",
							value: "V_value",
							origin: "agent",
						},
					],
					"BR_branch",
				],
			},
		],
	},
	accept_translation: {
		input: {
			projectId: "P_projectId",
			locale: "zz",
			name: "N_name",
			namespace: "NS_ns",
			branch: "BR_branch",
			runRef: "RR_runRef",
		},
		calls: [
			{
				method: "translations.accept",
				args: [
					ACTOR,
					"P_projectId",
					"zz",
					"N_name",
					{ namespace: "NS_ns", branch: "BR_branch", runRef: "RR_runRef" },
				],
			},
		],
	},

	// ---- runs ------------------------------------------------------------------
	start_run: {
		input: {
			projectId: "P_projectId",
			branch: "BR_branch",
			trigger: "manual",
			valueSource: "VS_valueSource",
			idempotencyKey: "IK_idem",
			cellsTotal: 3,
		},
		calls: [
			{
				method: "runs.start",
				args: [
					ACTOR,
					"P_projectId",
					{
						branch: "BR_branch",
						trigger: "manual",
						valueSource: "VS_valueSource",
						idempotencyKey: "IK_idem",
						cellsTotal: 3,
					},
				],
			},
		],
	},
	get_run: {
		input: { projectId: "P_projectId", runId: "R_runId" },
		calls: [{ method: "runs.get", args: [ACTOR, "P_projectId", "R_runId"] }],
	},
	list_runs: {
		input: { projectId: "P_projectId", branch: "BR_branch" },
		calls: [{ method: "runs.list", args: [ACTOR, "P_projectId", "BR_branch"] }],
	},
	finish_run: {
		input: {
			projectId: "P_projectId",
			runId: "R_runId",
			status: "done",
			cellsDone: 2,
			cellsTotal: 3,
			errors: ["E_err"],
			budgetSpent: 5,
		},
		calls: [
			{
				method: "runs.finish",
				args: [
					ACTOR,
					"P_projectId",
					"R_runId",
					{
						status: "done",
						cellsDone: 2,
						cellsTotal: 3,
						errors: ["E_err"],
						budgetSpent: 5,
					},
				],
			},
		],
	},
	cancel_run: {
		input: { projectId: "P_projectId", runId: "R_runId" },
		calls: [{ method: "runs.cancel", args: [ACTOR, "P_projectId", "R_runId"] }],
	},

	// ---- glossary --------------------------------------------------------------
	list_glossary: {
		input: { projectId: "P_projectId" },
		calls: [{ method: "glossary.list", args: [ACTOR, "P_projectId"] }],
	},
	add_glossary_term: {
		input: {
			projectId: "P_projectId",
			term: "TERM_term",
			translations: { zz: "TR_zz" },
			caseSensitive: true,
			doNotTranslate: false,
			notes: "NO_notes",
		},
		calls: [
			{
				method: "glossary.add",
				args: [
					ACTOR,
					"P_projectId",
					{
						term: "TERM_term",
						translations: { zz: "TR_zz" },
						caseSensitive: true,
						doNotTranslate: false,
						notes: "NO_notes",
					},
				],
			},
		],
	},
	update_glossary_term: {
		input: {
			projectId: "P_projectId",
			termId: "TID_termId",
			term: "TERM_term",
			translations: { zz: "TR_zz" },
			caseSensitive: true,
			doNotTranslate: false,
			notes: "NO_notes",
		},
		calls: [
			{
				method: "glossary.update",
				args: [
					ACTOR,
					"P_projectId",
					"TID_termId",
					{
						term: "TERM_term",
						translations: { zz: "TR_zz" },
						caseSensitive: true,
						doNotTranslate: false,
						notes: "NO_notes",
					},
				],
			},
		],
	},
	remove_glossary_term: {
		input: { projectId: "P_projectId", termId: "TID_termId" },
		calls: [
			{ method: "glossary.remove", args: [ACTOR, "P_projectId", "TID_termId"] },
		],
		result: { removed: "TID_termId" },
	},

	// ---- qa --------------------------------------------------------------------
	run_qa_checks: {
		input: {
			projectId: "P_projectId",
			locale: "zz",
			checks: ["CK_check"],
			slot: "working",
		},
		calls: [
			{
				// Note the deliberate field rename: input `checks` → service `checkIds`.
				method: "qa.run",
				args: [
					ACTOR,
					"P_projectId",
					{ locale: "zz", checkIds: ["CK_check"], slot: "working" },
				],
			},
		],
	},
	get_qa_config: {
		input: { projectId: "P_projectId" },
		calls: [{ method: "qa.getConfig", args: [ACTOR, "P_projectId"] }],
	},
	set_qa_config: {
		input: {
			projectId: "P_projectId",
			checks: { CFG_check: { enabled: true, severity: "error" } },
			ignore: [
				{
					checkId: "ICK_check",
					namespace: "NS_ns",
					keyName: "KN_key",
					locale: "zz",
				},
			],
		},
		calls: [
			{
				method: "qa.setConfig",
				args: [
					ACTOR,
					"P_projectId",
					{
						checks: { CFG_check: { enabled: true, severity: "error" } },
						ignore: [
							{
								checkId: "ICK_check",
								namespace: "NS_ns",
								keyName: "KN_key",
								locale: "zz",
							},
						],
					},
				],
			},
		],
	},

	// ---- webhooks + destructive lifecycle -------------------------------------
	list_webhooks: {
		input: { projectId: "P_projectId" },
		calls: [{ method: "webhooks.list", args: [ACTOR, "P_projectId"] }],
	},
	add_webhook: {
		input: {
			projectId: "P_projectId",
			url: "https://h.example/wh",
			events: ["key.created"],
		},
		calls: [
			{
				method: "webhooks.add",
				args: [
					ACTOR,
					"P_projectId",
					{ url: "https://h.example/wh", events: ["key.created"] },
				],
			},
		],
	},
	remove_webhook: {
		input: { projectId: "P_projectId", webhookId: "WH_webhookId" },
		calls: [
			{
				method: "webhooks.remove",
				args: [ACTOR, "P_projectId", "WH_webhookId"],
			},
		],
		result: { removed: "WH_webhookId" },
	},
	delete_project: {
		input: { projectId: "P_projectId", confirm: true },
		calls: [{ method: "projects.delete", args: [ACTOR, "P_projectId", true] }],
	},

	// ---- admin -----------------------------------------------------------------
	list_users: { input: {}, calls: [{ method: "users.list", args: [ACTOR] }] },
	create_user: {
		input: { email: "owner_email@ex.co", name: "N_name", globalRole: "ADMIN" },
		calls: [
			{
				method: "users.create",
				args: [
					ACTOR,
					{ email: "owner_email@ex.co", name: "N_name", globalRole: "ADMIN" },
				],
			},
		],
	},
	set_user_role: {
		input: { userId: "U_userId", globalRole: "ADMIN" },
		calls: [
			{ method: "users.setGlobalRole", args: [ACTOR, "U_userId", "ADMIN"] },
		],
		result: { userId: "U_userId", globalRole: "ADMIN" },
	},
	list_members: {
		input: { projectId: "P_projectId" },
		calls: [{ method: "members.list", args: [ACTOR, "P_projectId"] }],
	},
	add_member: {
		input: {
			projectId: "P_projectId",
			userId: "U_userId",
			email: "owner_email@ex.co",
			name: "N_name",
			role: "EDITOR",
		},
		calls: [
			{
				method: "members.add",
				args: [
					ACTOR,
					"P_projectId",
					{ userId: "U_userId", email: "owner_email@ex.co", name: "N_name" },
					"EDITOR",
				],
			},
		],
	},
	set_member_role: {
		input: { projectId: "P_projectId", userId: "U_userId", role: "EDITOR" },
		calls: [
			{
				method: "members.setRole",
				args: [ACTOR, "P_projectId", "U_userId", "EDITOR"],
			},
		],
	},
	remove_member: {
		input: { projectId: "P_projectId", userId: "U_userId" },
		calls: [
			{ method: "members.remove", args: [ACTOR, "P_projectId", "U_userId"] },
		],
		result: { removed: "U_userId" },
	},
	create_api_key: {
		input: {
			name: "N_name",
			userId: "U_userId",
			readOnly: true,
			expiresAt: "2099-01-01T00:00:00.000Z",
		},
		returns: {
			apiKey: {
				id: "key_id",
				name: "AK_name",
				prefix: "pfx_",
				readOnly: true,
				expiresAt: "2099-01-01T00:00:00.000Z",
			},
			secret: "SECRET_secret",
		},
		calls: [
			{
				method: "apiKeys.create",
				args: [
					ACTOR,
					{
						name: "N_name",
						userId: "U_userId",
						readOnly: true,
						expiresAt: "2099-01-01T00:00:00.000Z",
					},
				],
			},
		],
		result: {
			id: "key_id",
			name: "AK_name",
			prefix: "pfx_",
			readOnly: true,
			expiresAt: "2099-01-01T00:00:00.000Z",
			secret: "SECRET_secret",
		},
	},
	list_api_keys: {
		input: { userId: "U_userId" },
		calls: [{ method: "apiKeys.list", args: [ACTOR, "U_userId"] }],
	},
	revoke_api_key: {
		input: { apiKeyId: "K_apiKeyId", userId: "U_userId" },
		calls: [
			{ method: "apiKeys.revoke", args: [ACTOR, "K_apiKeyId", "U_userId"] },
		],
	},
};
