---
"@turjuman/api": patch
---

The OpenAPI document's `info.version` is now the API **contract** version (`1.0.0`, with its major tracking the `/v1` path prefix) instead of the npm package version. This follows the common convention (Stripe/Kubernetes/Google Cloud) and keeps the committed `docs/api-reference/openapi.json` snapshot from churning on every release. The deployed package version is still reported at runtime by the `GET /` service-metadata endpoint.
