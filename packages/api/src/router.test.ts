import { describe, expect, it } from "vitest";
import { type RouterDeps, createApp } from "./router.js";

// Meta endpoints are unauthenticated, and a missing token is rejected before any
// repository call — so an empty deps object is enough to exercise these routes.
const app = createApp({} as RouterDeps);

describe("REST router", () => {
  it("serves an unauthenticated health root", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "turjuman" });
  });

  it("lists formats without auth", async () => {
    const res = await app.request("/v1/formats");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { formats: { id: string }[] };
    expect(body.formats.map((f) => f.id)).toContain("json-nested");
  });

  it("returns 401 with WWW-Authenticate and a typed envelope when the key is missing", async () => {
    const res = await app.request("/v1/projects");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    // The 401 uses the same { error, code, requestId } envelope as every other error.
    const body = (await res.json()) as { error: string; code: string; requestId: string };
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(body.requestId).toBeTruthy();
  });

  it("tags every response with an X-Request-Id header", async () => {
    const res = await app.request("/");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("echoes a caller-supplied X-Request-Id", async () => {
    const res = await app.request("/v1/projects", { headers: { "x-request-id": "trace-123" } });
    expect(res.headers.get("x-request-id")).toBe("trace-123");
    expect((await res.json()) as { requestId: string }).toMatchObject({ requestId: "trace-123" });
  });

  it("serves an OpenAPI spec describing the project routes", async () => {
    const res = await app.request("/v1/openapi.json");
    expect(res.status).toBe(200);
    const spec = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(spec.openapi).toBeDefined();
    expect(Object.keys(spec.paths)).toContain("/v1/projects/{id}/keys/import");
  });

  it("documents shared schemas once under components and $refs them from routes", async () => {
    const res = await app.request("/v1/openapi.json");
    const spec = (await res.json()) as {
      components: { schemas: Record<string, unknown> };
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    // The shared shapes — responses, request bodies, and meta — are each emitted
    // once as named components, not inlined.
    const schemaNames = Object.keys(spec.components.schemas);
    expect(schemaNames).toEqual(
      expect.arrayContaining([
        "ErrorEnvelope",
        "Project",
        "TranslationKey",
        "AddLocaleBody",
        "ServiceMeta",
      ]),
    );
    // Routes reference them by $ref. The error envelope is reused on every error
    // status, so listing projects must $ref it rather than repeat the shape inline.
    const listErr = spec.paths["/v1/projects"]?.get?.responses?.["404"] as {
      content: { "application/json": { schema: { $ref?: string } } };
    };
    expect(listErr.content["application/json"].schema.$ref).toBe(
      "#/components/schemas/ErrorEnvelope",
    );
  });
});
