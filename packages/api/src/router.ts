import "zod-openapi/extend";
import { randomUUID } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { describeRoute, openAPIRouteHandler, resolver, validator } from "hono-openapi";
import { z } from "zod";
import * as formats from "@turjuman/formats";
import {
  type Actor,
  BEARER_CHALLENGE,
  TurjumanService,
  Repository,
  addLocaleBodySchema,
  authenticate,
  bulkSetResultSchema,
  bundleEntrySchema,
  errorEnvelopeSchema,
  errorStatus,
  importKeysBodySchema,
  importKeysResultSchema,
  importTranslationsBodySchema,
  keyPageSchema,
  localeSchema,
  logInfo,
  maskError,
  parseBearer,
  projectSchema,
  qaConfigBodySchema,
  reviewTranslationsBodySchema,
  runChecksBodySchema,
  scoreConfigBodySchema,
  scorePromptSchema,
  scoreTranslationBodySchema,
  translationKeySchema,
  translationSchema,
  type User,
  validation,
} from "@turjuman/core";
import { OPERATIONS_BY_NAME, type OpContext } from "@turjuman/sdk";

/**
 * REST API as a Hono app. Endpoints are the deterministic operations a
 * developer/CI needs and that should NOT be left to an LLM: list projects/
 * locales/keys, export a locale, and bulk push keys and translations. All
 * management beyond this happens through the MCP server.
 *
 * Request bodies are validated with the shared zod schemas (core ./validation)
 * via hono-openapi's `validator`, which also documents them — the OpenAPI spec
 * is served at GET /v1/openapi.json. AppError is mapped to the platform's
 * { error, code } envelope and HTTP status by a single onError handler.
 */

export interface RouterDeps {
  repo: Repository;
  service: TurjumanService;
}

/** Hono environment: middleware stashes the resolved actor, the per-request id,
 * the authenticated key id (for the access log), and the request start time. */
type Env = {
  Variables: { actor: Actor; user: User; requestId: string; keyId?: string; startedAt?: number };
};

import pkg from "../package.json" with { type: "json" };

const META = { name: "turjuman", version: pkg.version };

// The OpenAPI document's version is the *API contract* version, not the npm
// package version — its major tracks the `/v1` path prefix and only changes when
// the REST contract changes (the convention used by Stripe/Kubernetes/Google
// Cloud). Decoupling it from `pkg.version` keeps the committed openapi.json
// snapshot from churning on every release. The deployed package version is still
// reported at runtime by the `GET /` service-metadata endpoint (`META`).
const API_VERSION = "1.0.0";

/** Turn a Standard Schema validation failure into the platform's VALIDATION error. */
function onInvalid(
  result: { success: boolean; error?: readonly { message: string }[] },
  _c: Context,
): void {
  if (!result.success) {
    throw validation(result.error?.[0]?.message ?? "Invalid request body");
  }
}

/** Parse a `limit` query param to a positive integer, rejecting a non-numeric
 * value with a 400 (`VALIDATION`) rather than letting `NaN` reach DynamoDB's
 * `Limit` and surface as a 500. Returns `undefined` when the param is absent. */
function queryLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw validation("limit must be a positive integer");
  return n;
}

/**
 * Build an OpenAPI `responses` entry whose body is documented by `schema`.
 * `resolver` turns the shared core zod schema into the spec's JSON Schema, so the
 * documented response and what the handler returns share one definition.
 */
function jsonResponse(schema: z.ZodTypeAny, description: string) {
  return { description, content: { "application/json": { schema: resolver(schema) } } };
}

/** The error responses every authenticated route can return, documented once with
 * the shared {@link errorEnvelopeSchema}. */
const errorResponses = {
  400: jsonResponse(errorEnvelopeSchema, "Validation error"),
  401: jsonResponse(errorEnvelopeSchema, "Missing or invalid API key"),
  403: jsonResponse(errorEnvelopeSchema, "Insufficient permissions"),
  404: jsonResponse(errorEnvelopeSchema, "Resource not found"),
} as const;

// REST presentation envelopes for the locale-scoped lists: the same core entity
// schemas, wrapped with the `locale` (and `nextCursor` when paged) the REST shape
// returns. Composed from core schemas so the entities never drift.
const localeTranslationsResponseSchema = z.object({
  locale: z.string(),
  translations: z.array(translationSchema),
  nextCursor: z.string().optional(),
});
const bundleResponseSchema = z.object({
  locale: z.string(),
  entries: z.array(bundleEntrySchema),
  nextCursor: z.string().optional(),
});
const forReviewResponseSchema = z.object({
  locale: z.string(),
  keys: z.array(translationKeySchema),
  nextCursor: z.string().optional(),
});

// REST list envelopes for projects/locales: the same core entity schemas wrapped
// in the `{ projects }` / `{ locales }` object the REST routes return (MCP returns
// the bare arrays). Composed from core schemas so the entities never drift.
const projectListResponseSchema = z.object({ projects: z.array(projectSchema) });
const localeListResponseSchema = z.object({ locales: z.array(localeSchema) });

// Response shapes for the public meta endpoints. Defined here (not in core) since
// they describe the API service itself, not a domain entity. `FileFormat` mirrors
// the return type of core's `formats.listFormats()`.
const serviceMetaResponseSchema = z
  .object({ name: z.string(), version: z.string() })
  .openapi({ ref: "ServiceMeta" });
const formatListResponseSchema = z.object({
  formats: z.array(
    z
      .object({ id: z.string(), label: z.string(), extensions: z.array(z.string()) })
      .openapi({ ref: "FileFormat" }),
  ),
});

export function createApp(deps: RouterDeps): Hono<Env> {
  const app = new Hono<Env>();
  const svc = deps.service;

  // One structured access-log line per request — the REST mirror of the MCP
  // server's `mcp_request` line, so a single CloudWatch Insights query spans both
  // transports. The happy path logs here after `next()`; thrown requests (AppError
  // 4xx and unexpected 500s) are logged once in `onError`, where their final HTTP
  // status is decided. `next()` rejects on a thrown handler, so the line below is
  // skipped on that path — exactly one line per request, never two.
  const accessLog = (c: Context<Env>, status: number): void => {
    logInfo({
      msg: "api_request",
      requestId: c.get("requestId"),
      method: c.req.method,
      path: c.req.path,
      status,
      keyId: c.get("keyId"),
      ms: Date.now() - (c.get("startedAt") ?? Date.now()),
    });
  };

  // Tag every request with an id, echoed in the X-Request-Id response header and
  // in error envelopes, so a client report can be tied to a server-side log line.
  app.use("*", async (c, next) => {
    const requestId = c.req.header("x-request-id") ?? randomUUID();
    c.set("requestId", requestId);
    c.set("startedAt", Date.now());
    c.header("x-request-id", requestId);
    await next();
    accessLog(c, c.res.status);
  });

  // Map typed AppErrors to the { error, code } envelope + HTTP status; anything
  // else is an unexpected 500. This is the single place HTTP status is decided —
  // and where thrown requests get their one access-log line.
  app.onError((err, c) => {
    const requestId = c.get("requestId");
    // One masking policy across every transport boundary (core's `maskError`): an
    // AppError surfaces its code + message; anything else is logged server-side
    // (request id + stack) and returned as a generic body, never leaking internals.
    const masked = maskError(err, { msg: "api_unhandled", requestId });
    if (masked.isAppError) {
      const status = errorStatus(masked.code);
      accessLog(c, status);
      return c.json({ error: masked.message, code: masked.code, requestId }, status as ContentfulStatusCode);
    }
    accessLog(c, 500);
    return c.json({ error: "Internal error", code: "INTERNAL", requestId }, 500);
  });

  // ---- unauthenticated meta endpoints ---------------------------------------
  app.get(
    "/",
    describeRoute({
      summary: "Service metadata",
      description: "Returns the service name and version. Public — no auth required.",
      tags: ["Meta"],
      security: [],
      responses: { 200: jsonResponse(serviceMetaResponseSchema, "Service name and version") },
    }),
    (c) => c.json(META),
  );
  app.get(
    "/v1/formats",
    describeRoute({
      summary: "List supported file formats",
      description: "The locale file formats the CLI can read/write. Public — no auth required.",
      tags: ["Meta"],
      security: [],
      responses: { 200: jsonResponse(formatListResponseSchema, "Supported formats") },
    }),
    (c) => c.json({ formats: formats.listFormats() }),
  );

  // ---- authenticated project API --------------------------------------------
  // A sub-app so the bearer check applies to every /v1/projects route at once.
  const projects = new Hono<Env>();

  const requireAuth: MiddlewareHandler<Env> = async (c, next) => {
    const auth = await authenticate(deps.repo, parseBearer(c.req.header("authorization")));
    if (!auth) {
      c.header("www-authenticate", BEARER_CHALLENGE);
      return c.json(
        { error: "Invalid or missing API key", code: "UNAUTHENTICATED", requestId: c.get("requestId") },
        401,
      );
    }
    c.set("actor", auth.actor);
    c.set("user", auth.user);
    c.set("keyId", auth.keyId);
    await next();
  };
  projects.use("*", requireAuth);

  // ---- SDK operation projection ---------------------------------------------
  // Project a `@turjuman/sdk` Operation onto a REST route: same handler (so core
  // business logic + RBAC are identical to the MCP tool), with the operation's
  // canonical `output` documenting the response and a reused, ref-annotated body
  // schema documenting the request. Path params map onto operation input fields;
  // the validated JSON body supplies the rest. Reusing the shared schemas keeps
  // each component emitted once under `components.schemas` and `$ref`'d for both
  // request and response. Only operations that carry an `http` binding AND map
  // cleanly are projected here; the rest stay bespoke (CLI push/pull surface).
  interface ProjectionConfig {
    summary: string;
    description?: string;
    tags: string[];
    /** Reused, ref-annotated request-body schema. Omit for GET routes. */
    body?: z.ZodTypeAny;
    /** Success status code (default 200). */
    status?: ContentfulStatusCode;
    responseDescription: string;
  }

  const PROJECTS_PREFIX = "/v1/projects";

  const projectOperation = (name: string, cfg: ProjectionConfig): void => {
    const op = OPERATIONS_BY_NAME.get(name);
    if (!op?.http || !op.output) {
      throw new Error(`Operation "${name}" has no http binding or output schema to project`);
    }
    const { method, path, params = {} } = op.http;
    // This sub-app is mounted at /v1/projects, so a binding outside that prefix
    // can't be projected here — fail loud at startup rather than silently mount it
    // at the wrong URL.
    if (path !== PROJECTS_PREFIX && !path.startsWith(`${PROJECTS_PREFIX}/`)) {
      throw new Error(`Operation "${name}" path "${path}" is not under ${PROJECTS_PREFIX}; cannot project it onto the projects router`);
    }
    const subPath = path.slice(PROJECTS_PREFIX.length) || "/";
    // A param maps onto the URL as a `:name` path segment when it appears in the
    // path, otherwise as a query param (per the HttpBinding contract).
    const paramSources = Object.entries(params).map(([urlName, field]) => ({
      urlName,
      field,
      fromPath: path.includes(`:${urlName}`),
    }));
    const status = cfg.status ?? 200;
    const spec = describeRoute({
      summary: cfg.summary,
      ...(cfg.description ? { description: cfg.description } : {}),
      tags: cfg.tags,
      responses: { [status]: jsonResponse(op.output, cfg.responseDescription), ...errorResponses },
    });
    const handler = async (c: Context<Env>) => {
      const ctx: OpContext = {
        service: svc,
        actor: c.get("actor"),
        user: c.get("user"),
        requestId: c.get("requestId"),
      };
      const merged: Record<string, unknown> = {};
      for (const p of paramSources) {
        const raw = p.fromPath ? c.req.param(p.urlName) : c.req.query(p.urlName);
        if (raw !== undefined) merged[p.field] = raw;
      }
      if (cfg.body) Object.assign(merged, (c.req.valid as (t: "json") => Record<string, unknown>)("json"));
      // Re-validate the assembled input against the operation's OWN schema, so the
      // REST surface enforces exactly the constraints MCP and the sandbox do (the
      // body schema only documents/validates the body sub-shape; the op input may
      // be stricter, e.g. an array `.max(...)`). A failure maps to a 400 VALIDATION.
      let input: unknown;
      try {
        input = op.input.parse(merged);
      } catch (e) {
        throw validation(e instanceof z.ZodError ? (e.errors[0]?.message ?? "Invalid request") : "Invalid request");
      }
      return c.json(await op.handler(input, ctx), status);
    };
    if (cfg.body) {
      projects.on(method.toUpperCase(), subPath, spec, validator("json", cfg.body, onInvalid), handler);
    } else {
      projects.on(method.toUpperCase(), subPath, spec, handler);
    }
  };

  projects.get(
    "/",
    describeRoute({
      summary: "List projects",
      description: "Projects the authenticated caller can access.",
      tags: ["Projects"],
      responses: {
        200: jsonResponse(projectListResponseSchema, "Projects the caller can access"),
        ...errorResponses,
      },
    }),
    async (c) => c.json({ projects: await svc.projects.list(c.get("actor")) }),
  );

  // Projected from the `get_project` operation (same handler as the MCP tool).
  projectOperation("get_project", {
    summary: "Get a project",
    tags: ["Projects"],
    responseDescription: "The project",
  });

  projects.get(
    "/:id/locales",
    describeRoute({
      summary: "List a project's locales",
      tags: ["Locales"],
      responses: {
        200: jsonResponse(localeListResponseSchema, "The project's locales"),
        ...errorResponses,
      },
    }),
    async (c) => c.json({ locales: await svc.locales.list(c.get("actor"), c.req.param("id")) }),
  );

  projectOperation("add_locale", {
    summary: "Add a target locale to a project",
    tags: ["Locales"],
    body: addLocaleBodySchema,
    status: 201,
    responseDescription: "The created locale",
  });

  projects.get(
    "/:id/keys",
    describeRoute({
      summary: "List keys",
      description: "List a project's keys; paginate with limit + cursor.",
      tags: ["Keys"],
      parameters: [
        { in: "query", name: "namespace", schema: { type: "string" }, description: "Filter to a namespace" },
        { in: "query", name: "limit", schema: { type: "integer" }, description: "Page size; enables pagination" },
        { in: "query", name: "cursor", schema: { type: "string" }, description: "Opaque cursor from a previous page" },
      ],
      responses: {
        200: jsonResponse(keyPageSchema, "Keys (and nextCursor when paginated)"),
        ...errorResponses,
      },
    }),
    async (c) => {
      const actor = c.get("actor");
      const projectId = c.req.param("id");
      const namespace = c.req.query("namespace");
      const cursor = c.req.query("cursor");
      const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
      if (limit !== undefined || cursor) {
        const page = await svc.keys.listPage(actor, projectId, { namespace, limit, cursor });
        return c.json({ keys: page.keys, nextCursor: page.nextCursor });
      }
      return c.json({ keys: await svc.keys.list(actor, projectId, { namespace }) });
    },
  );

  projects.post(
    "/:id/keys/import",
    describeRoute({
      summary: "Create/update keys and base-locale values (CLI push)",
      tags: ["Keys"],
      responses: {
        200: jsonResponse(importKeysResultSchema, "Import summary (counts of what changed)"),
        ...errorResponses,
      },
    }),
    validator("json", importKeysBodySchema, onInvalid),
    async (c) => {
      const b = c.req.valid("json");
      return c.json(
        await svc.keys.import(c.get("actor"), c.req.param("id")!, b.entries, b.namespace, {
          prune: b.prune,
          deprecateAbsent: b.deprecate,
        }),
      );
    },
  );

  projects.get(
    "/:id/translations",
    describeRoute({
      summary: "List translations for a locale",
      description: "All translations for a locale; paginate with limit + cursor.",
      tags: ["Translations"],
      parameters: [
        { in: "query", name: "locale", required: true, schema: { type: "string" }, description: "Locale code" },
        { in: "query", name: "limit", schema: { type: "integer" }, description: "Page size; enables pagination" },
        { in: "query", name: "cursor", schema: { type: "string" }, description: "Opaque cursor from a previous page" },
      ],
      responses: {
        200: jsonResponse(localeTranslationsResponseSchema, "Translations (and nextCursor when paginated)"),
        ...errorResponses,
      },
    }),
    async (c) => {
      const actor = c.get("actor");
      const projectId = c.req.param("id");
      const locale = c.req.query("locale");
      if (!locale) throw validation("Missing required query parameter: locale");
      const cursor = c.req.query("cursor");
      const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
      if (limit !== undefined || cursor) {
        const page = await svc.translations.listForLocalePage(actor, projectId, locale, { limit, cursor });
        return c.json({ locale, translations: page.translations, nextCursor: page.nextCursor });
      }
      return c.json({ locale, translations: await svc.translations.listForLocale(actor, projectId, locale) });
    },
  );

  projects.get(
    "/:id/bundle",
    describeRoute({
      summary: "Export a delivery bundle for a locale",
      description: "Approved values by default; pass slot=working to ship drafts. Paginate with limit + cursor.",
      tags: ["Translations"],
      parameters: [
        { in: "query", name: "locale", required: true, schema: { type: "string" }, description: "Locale code" },
        { in: "query", name: "slot", schema: { type: "string", enum: ["working"] }, description: "working = ship drafts instead of approved" },
        { in: "query", name: "fallback", schema: { type: "string", enum: ["omit"] }, description: "omit = drop keys with no value instead of source fallback" },
        { in: "query", name: "excludeStale", schema: { type: "string", enum: ["1"] }, description: "1 = exclude stale translations" },
        { in: "query", name: "limit", schema: { type: "integer" }, description: "Page size; enables pagination" },
        { in: "query", name: "cursor", schema: { type: "string" }, description: "Opaque cursor from a previous page" },
      ],
      responses: {
        200: jsonResponse(bundleResponseSchema, "Bundle entries (and nextCursor when paginated)"),
        ...errorResponses,
      },
    }),
    async (c) => {
      const actor = c.get("actor");
      const projectId = c.req.param("id");
      const locale = c.req.query("locale");
      if (!locale) throw validation("Missing required query parameter: locale");
      const slot = c.req.query("slot") === "working" ? "working" : undefined;
      const fallback = c.req.query("fallback") === "omit" ? "omit" : undefined;
      const excludeStale = c.req.query("excludeStale") === "1";
      const cursor = c.req.query("cursor");
      const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
      if (limit !== undefined || cursor) {
        const page = await svc.translations.exportBundlePage(actor, projectId, locale, {
          slot,
          fallback,
          excludeStale,
          limit,
          cursor,
        });
        return c.json({ locale, entries: page.entries, nextCursor: page.nextCursor });
      }
      return c.json({
        locale,
        entries: await svc.translations.exportBundle(actor, projectId, locale, { slot, fallback, excludeStale }),
      });
    },
  );

  projects.post(
    "/:id/translations/import",
    describeRoute({
      summary: "Bulk-write translation values for a locale (CLI push)",
      tags: ["Translations"],
      responses: {
        200: jsonResponse(bulkSetResultSchema, "Write summary (count written, keys skipped)"),
        ...errorResponses,
      },
    }),
    validator("json", importTranslationsBodySchema, onInvalid),
    async (c) => {
      const b = c.req.valid("json");
      return c.json(
        await svc.translations.bulkSet(
          c.get("actor"),
          c.req.param("id")!,
          b.locale,
          b.entries.map((e) => ({ ...e, origin: "import" as const })),
        ),
      );
    },
  );

  projectOperation("run_qa_checks", {
    summary: "Run advisory QA checks on a project's translations",
    tags: ["QA"],
    body: runChecksBodySchema,
    responseDescription: "QA report (findings grouped by locale + rollup counts)",
  });

  projectOperation("get_qa_config", {
    summary: "Get the project's QA configuration",
    tags: ["QA"],
    responseDescription: "The project's QA configuration",
  });

  projectOperation("set_qa_config", {
    summary: "Set the project's QA configuration",
    tags: ["QA"],
    body: qaConfigBodySchema,
    responseDescription: "The updated QA configuration",
  });

  // ---- AI scoring + review --------------------------------------------------
  // The grading runs in the connected agent; these REST routes let a non-MCP CI
  // agent fetch the methodology (score-prompt) and submit scores, in parity with
  // the MCP tools/prompts.

  projectOperation("score_translation", {
    summary: "Submit an AI quality score for one translation",
    description:
      "Record an MQM 0–100 score and route the translation (needs_review / translated / approved).",
    tags: ["Scoring"],
    body: scoreTranslationBodySchema,
    responseDescription: "The updated translation, with its new status and score",
  });

  projectOperation("review_translations", {
    summary: "Submit AI quality scores for many translations in a locale",
    tags: ["Scoring"],
    body: reviewTranslationsBodySchema,
    responseDescription: "Review summary (written/approved/flagged + skipped keys)",
  });

  projects.get(
    "/:id/translations/for-review",
    describeRoute({
      summary: "List keys flagged needs_review for a locale",
      description: "Keys whose translation scored below the project threshold. Paginate with limit + cursor.",
      tags: ["Scoring"],
      parameters: [
        { in: "query", name: "locale", required: true, schema: { type: "string" }, description: "Locale code" },
        { in: "query", name: "limit", schema: { type: "integer" }, description: "Page size; enables pagination" },
        { in: "query", name: "cursor", schema: { type: "string" }, description: "Opaque cursor from a previous page" },
      ],
      responses: {
        200: jsonResponse(forReviewResponseSchema, "Flagged keys (and nextCursor when paginated)"),
        ...errorResponses,
      },
    }),
    async (c) => {
      const actor = c.get("actor");
      const projectId = c.req.param("id");
      const locale = c.req.query("locale");
      if (!locale) throw validation("Missing required query parameter: locale");
      const cursor = c.req.query("cursor");
      const limit = queryLimit(c.req.query("limit"));
      const page = await svc.scoring.listForReviewPage(actor, projectId, locale, { limit, cursor });
      return c.json({ locale, keys: page.keys, nextCursor: page.nextCursor });
    },
  );

  projects.get(
    "/:id/translations/score-prompt",
    describeRoute({
      summary: "Fetch the assembled MQM scoring prompt for a locale",
      description:
        "Returns the rubric + project guidance + glossary + source/target for one key (pass name) or a page of the locale (omit name). Grade it, then POST the score back.",
      tags: ["Scoring"],
      parameters: [
        { in: "query", name: "locale", required: true, schema: { type: "string" }, description: "Locale code" },
        { in: "query", name: "name", schema: { type: "string" }, description: "Key name (single-string prompt); omit for a page" },
        { in: "query", name: "namespace", schema: { type: "string" }, description: "Key namespace (with name)" },
        { in: "query", name: "limit", schema: { type: "integer" }, description: "Page size for the batch form" },
        { in: "query", name: "cursor", schema: { type: "string" }, description: "Opaque cursor for the batch form" },
      ],
      responses: {
        200: jsonResponse(scorePromptSchema, "The assembled scoring prompt (messages + promptVersion)"),
        ...errorResponses,
      },
    }),
    async (c) => {
      const actor = c.get("actor");
      const projectId = c.req.param("id");
      const locale = c.req.query("locale");
      if (!locale) throw validation("Missing required query parameter: locale");
      const name = c.req.query("name");
      const cursor = c.req.query("cursor");
      const limit = queryLimit(c.req.query("limit"));
      const sel = name
        ? { name, namespace: c.req.query("namespace") }
        : { limit, cursor };
      return c.json(await svc.scoring.buildScorePrompt(actor, projectId, locale, sel));
    },
  );

  projectOperation("get_score_config", {
    summary: "Get the project's AI-scoring configuration",
    tags: ["Scoring"],
    responseDescription: "The project's AI-scoring configuration",
  });

  projectOperation("set_score_config", {
    summary: "Set the project's AI-scoring configuration",
    tags: ["Scoring"],
    body: scoreConfigBodySchema,
    responseDescription: "The updated AI-scoring configuration",
  });

  app.route("/v1/projects", projects);

  // ---- OpenAPI spec (unauthenticated, like the other meta endpoints) --------
  // The served document is canonical: description, servers, and the Bearer
  // security scheme live here (not in any snapshot tooling), so every consumer
  // of GET /v1/openapi.json — Mintlify, codegen, agents — gets the same spec.
  app.get(
    "/v1/openapi.json",
    openAPIRouteHandler(app, {
      documentation: {
        openapi: "3.1.0",
        info: {
          title: "Turjuman API",
          version: API_VERSION,
          description:
            "Deterministic REST API for the Turjuman developer CLI and CI sync.\n\n" +
            "**Base URL:** your own deployment's `ApiUrl` (printed by `turjuman deploy`); " +
            "replace the server below with it.\n\n" +
            "**Auth:** every `/v1/projects` route requires `Authorization: Bearer <api-key>`. " +
            "The meta endpoints (`/`, `/v1/formats`, `/v1/openapi.json`) are public.",
        },
        servers: [
          {
            url: "https://your-turjuman-api.example.com",
            description: "Your deployed Turjuman API URL (the ApiUrl from `turjuman deploy`)",
          },
        ],
        components: {
          securitySchemes: {
            bearerAuth: { type: "http", scheme: "bearer", description: "Your Turjuman API key" },
          },
        },
        security: [{ bearerAuth: [] }],
      },
    }),
  );

  return app;
}
