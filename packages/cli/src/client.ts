import {
	type BundleEntry,
	importKeysBodySchema,
	importTranslationsBodySchema,
	type Locale,
	type Project,
	parse,
	type qa,
	runChecksBodySchema,
	type Translation,
	type TranslationKey,
} from "@turjuman/schema";
import type { z } from "zod";
import { apiError, CliError } from "./errors.js";

/**
 * Request-body types are derived from core's zod schemas (the single source of
 * truth shared with the REST API), so a schema change there breaks this build
 * rather than failing silently at runtime. Bodies are also validated locally
 * with the same schema before being sent.
 */
type ImportKeysBody = z.infer<typeof importKeysBodySchema>;
type ImportTranslationsBody = z.infer<typeof importTranslationsBodySchema>;
type RunChecksBody = z.infer<typeof runChecksBodySchema>;

/** Page size used when walking paginated list endpoints (see requestAllPages). */
const PAGE_SIZE = 500;

/** Validate a request body against its core schema, surfacing the platform's
 * VALIDATION message as a usage error (exit 2) before any network round-trip. */
function validateBody<T>(schema: z.ZodType<T>, value: unknown): T {
	try {
		return parse(schema, value);
	} catch (err) {
		throw new CliError(err instanceof Error ? err.message : String(err), 2);
	}
}

/** Thin REST client for the Turjuman API. */
export class ApiClient {
	constructor(
		private readonly baseUrl: string,
		private readonly apiKey: string,
		private readonly fetchImpl: typeof fetch = fetch,
	) {}

	private async request<T>(
		method: string,
		path: string,
		opts: { query?: Record<string, string>; body?: unknown } = {},
	): Promise<T> {
		const url = new URL(
			path.replace(/^\//, ""),
			this.baseUrl.endsWith("/") ? this.baseUrl : this.baseUrl + "/",
		);
		for (const [k, v] of Object.entries(opts.query ?? {}))
			url.searchParams.set(k, v);
		let res: Response;
		try {
			res = await this.fetchImpl(url, {
				method,
				headers: {
					authorization: `Bearer ${this.apiKey}`,
					...(opts.body ? { "content-type": "application/json" } : {}),
				},
				body: opts.body ? JSON.stringify(opts.body) : undefined,
			});
		} catch (err) {
			throw apiError(
				`Cannot reach ${url.origin}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		const text = await res.text();
		const data = text ? JSON.parse(text) : {};
		if (!res.ok) {
			const body = data as {
				error?: string;
				code?: string;
				requestId?: string;
			};
			// The API tags every response with a request id (body + X-Request-Id
			// header); surface it so a failure report ties back to a server log line.
			const requestId =
				body.requestId ?? res.headers.get("x-request-id") ?? undefined;
			const message = body.error ?? `HTTP ${res.status}`;
			throw apiError(
				requestId ? `${message} (request ${requestId})` : message,
				{
					code: body.code,
					requestId,
				},
			);
		}
		return data as T;
	}

	/**
	 * Walk every page of a paginated list endpoint and return the full array.
	 * The API paginates only when `limit`/`cursor` are sent, so passing a fixed
	 * page size keeps per-request work bounded on large projects while the CLI
	 * still assembles the complete set it needs to write whole files.
	 */
	private async requestAllPages<E>(
		path: string,
		key: "entries" | "keys" | "translations",
		query: Record<string, string> = {},
	): Promise<E[]> {
		const all: E[] = [];
		let cursor: string | undefined;
		do {
			const page = await this.request<Record<string, unknown>>("GET", path, {
				query: {
					...query,
					limit: String(PAGE_SIZE),
					...(cursor ? { cursor } : {}),
				},
			});
			all.push(...((page[key] as E[]) ?? []));
			cursor = (page.nextCursor as string | null | undefined) ?? undefined;
		} while (cursor);
		return all;
	}

	listProjects(): Promise<{ projects: Project[] }> {
		return this.request("GET", "v1/projects");
	}

	getProject(projectId: string): Promise<Project> {
		return this.request("GET", `v1/projects/${projectId}`);
	}

	listLocales(projectId: string): Promise<{ locales: Locale[] }> {
		return this.request("GET", `v1/projects/${projectId}/locales`);
	}

	async listKeys(
		projectId: string,
		namespace?: string,
	): Promise<{ keys: TranslationKey[] }> {
		const keys = await this.requestAllPages<TranslationKey>(
			`v1/projects/${projectId}/keys`,
			"keys",
			namespace ? { namespace } : {},
		);
		return { keys };
	}

	async exportLocale(
		projectId: string,
		locale: string,
	): Promise<{ translations: Translation[] }> {
		const translations = await this.requestAllPages<Translation>(
			`v1/projects/${projectId}/translations`,
			"translations",
			{ locale },
		);
		return { translations };
	}

	/** Adapter-ready export: deliverable values joined with key metadata. */
	async exportBundle(
		projectId: string,
		locale: string,
		opts: { working?: boolean; excludeStale?: boolean } = {},
	): Promise<{ entries: BundleEntry[] }> {
		const query: Record<string, string> = { locale };
		if (opts.working) query.slot = "working";
		if (opts.excludeStale) query.excludeStale = "1";
		const entries = await this.requestAllPages<BundleEntry>(
			`v1/projects/${projectId}/bundle`,
			"entries",
			query,
		);
		return { entries };
	}

	async importKeys(
		projectId: string,
		entries: ImportKeysBody["entries"],
		namespace?: string,
		opts: { prune?: boolean; deprecate?: boolean } = {},
	): Promise<{
		created: number;
		updated: number;
		reactivated: number;
		baseValuesSet: number;
		deleted: number;
		deprecated: number;
	}> {
		const body = validateBody(importKeysBodySchema, {
			namespace,
			entries,
			prune: opts.prune,
			deprecate: opts.deprecate,
		});
		return this.request("POST", `v1/projects/${projectId}/keys/import`, {
			body,
		});
	}

	async importTranslations(
		projectId: string,
		locale: string,
		entries: ImportTranslationsBody["entries"],
	): Promise<{ written: number; skipped: string[] }> {
		const body = validateBody(importTranslationsBodySchema, {
			locale,
			entries,
		});
		return this.request(
			"POST",
			`v1/projects/${projectId}/translations/import`,
			{ body },
		);
	}

	listFormats(): Promise<{
		formats: { id: string; label: string; extensions: string[] }[];
	}> {
		return this.request("GET", "v1/formats");
	}

	/** Run advisory QA checks; returns the report (findings + severity counts). */
	async runChecks(
		projectId: string,
		opts: {
			locale?: string;
			checks?: string[];
			slot?: "working" | "approved";
		} = {},
	): Promise<qa.QaReport> {
		const body: RunChecksBody = validateBody(runChecksBodySchema, {
			locale: opts.locale,
			checks: opts.checks,
			slot: opts.slot,
		});
		return this.request("POST", `v1/projects/${projectId}/checks`, { body });
	}
}
