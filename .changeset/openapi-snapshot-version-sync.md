---
"@turjuman/api": patch
---

Keep the committed OpenAPI snapshot (`docs/api-reference/openapi.json`) in sync with the release version. `version-packages` now rebuilds and regenerates the snapshot, so its `info.version` no longer lags a release and trips CI's OpenAPI drift check on the following PR.
