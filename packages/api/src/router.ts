import "zod-openapi/extend";
import { randomUUID } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { describeRoute, openAPIRouteHandler, resolver, validator } from "hono-openapi";
import { z } from "zod";
import * as formats from "@turjuman/formats";
import {
  AppError,
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
  parseBearer,
  projectSchema,
  qaConfigBodySchema,
  qaConfigSchema,
  qaReportSchema,
  runChecksBodySchema,
  translationSchema,
  validation,
} from "@turjuman/core";

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

/** Hono environment: middleware stashes the resolved actor and a per-request id here. */
type Env = { Variables: { actor: Actor; requestId: string } };

import pkg from "../package.json" with { type: "json" };

const META = { name: "turjuman", version: pkg.version };

/** Turn a Standard Schema validation failure into the platform's VALIDATION error. */
function onInvalid(
  result: { success: boolean; error?: readonly { message: string }[] },
  _c: Context,
): void {
  if (!result.success) {
    throw validation(result.error?.[0]?.message ?? "Invalid request body");
  }
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

  // Tag every request with an id, echoed in the X-Request-Id response header and
  // in error envelopes, so a client report can be tied to a server-side log line.
  app.use("*", async (c, next) => {
    const requestId = c.req.header("x-request-id") ?? randomUUID();
    c.set("requestId", requestId);
    c.header("x-request-id", requestId);
    await next();
  });

  // Map typed AppErrors to the { error, code } envelope + HTTP status; anything
  // else is an unexpected 500. This is the single place HTTP status is decided.
  app.onError((err, c) => {
    const requestId = c.get("requestId");
    if (err instanceof AppError) {
      return c.json(
        { error: err.message, code: err.code, requestId },
        errorStatus(err.code) as ContentfulStatusCode,
      );
    }
    // Never leak an internal error's message to the client; log it (with the
    // request id) so it's traceable in CloudWatch, and return a generic body.
    console.error(`[${requestId}] unhandled error:`, err);
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
    await next();
  };
  projects.use("*", requireAuth);

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

  projects.get(
    "/:id",
    describeRoute({
      summary: "Get a project",
      tags: ["Projects"],
      responses: {
        200: jsonResponse(projectSchema, "The project"),
        ...errorResponses,
      },
    }),
    async (c) => c.json(await svc.projects.get(c.get("actor"), c.req.param("id"))),
  );

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

  projects.post(
    "/:id/locales",
    describeRoute({
      summary: "Add a target locale to a project",
      tags: ["Locales"],
      responses: {
        201: jsonResponse(localeSchema, "The created locale"),
        ...errorResponses,
      },
    }),
    validator("json", addLocaleBodySchema, onInvalid),
    async (c) => {
      const b = c.req.valid("json");
      return c.json(await svc.locales.add(c.get("actor"), c.req.param("id")!, b.code, b.name), 201);
    },
  );

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

  projects.post(
    "/:id/checks",
    describeRoute({
      summary: "Run advisory QA checks on a project's translations",
      tags: ["QA"],
      responses: {
        200: jsonResponse(qaReportSchema, "QA report (findings grouped by locale + rollup counts)"),
        ...errorResponses,
      },
    }),
    validator("json", runChecksBodySchema, onInvalid),
    async (c) => {
      const b = c.req.valid("json");
      return c.json(
        await svc.qa.run(c.get("actor"), c.req.param("id")!, {
          locale: b.locale,
          checkIds: b.checks,
          slot: b.slot,
        }),
      );
    },
  );

  projects.get(
    "/:id/qa-config",
    describeRoute({
      summary: "Get the project's QA configuration",
      tags: ["QA"],
      responses: {
        200: jsonResponse(qaConfigSchema, "The project's QA configuration"),
        ...errorResponses,
      },
    }),
    async (c) => c.json(await svc.qa.getConfig(c.get("actor"), c.req.param("id"))),
  );

  projects.put(
    "/:id/qa-config",
    describeRoute({
      summary: "Set the project's QA configuration",
      tags: ["QA"],
      responses: {
        200: jsonResponse(qaConfigSchema, "The updated QA configuration"),
        ...errorResponses,
      },
    }),
    validator("json", qaConfigBodySchema, onInvalid),
    async (c) => {
      const b = c.req.valid("json");
      return c.json(await svc.qa.setConfig(c.get("actor"), c.req.param("id")!, b));
    },
  );

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
          version: META.version,
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
