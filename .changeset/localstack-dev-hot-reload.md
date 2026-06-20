---
"@turjuman/aws-cdk": minor
---

Add a dev/LocalStack-only `hotReload` prop to the `Turjuman` construct. When set, each function's code is served from LocalStack's magic `hot-reload` S3 bucket (via `Code.fromBucket`) instead of a packaged asset, so a watching bundler can update the running Lambda without a redeploy. It is inert when unset, so production deploys are unaffected. This powers the `npm run dev` local dev loop.
