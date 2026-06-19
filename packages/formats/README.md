# @turjuman/formats

Localization **file-format adapters** for [Turjuman](https://github.com/mogharsallah/turjuman) —
open-source, self-hosted translation management.

Each adapter converts between an on-disk file and a canonical list of translation entries whose
`value` is always an **ICU MessageFormat** string (plurals included). Supported formats:

- JSON (flat and nested)
- YAML
- Java `.properties`
- ARB (Flutter)
- CSV
- Android `strings.xml` (`<plurals>`)
- iOS `.strings` and `.stringsdict`

```ts
import { getAdapter, listFormats } from "@turjuman/formats";

const adapter = getAdapter("json-nested");
const entries = adapter.parse(fileContents);
const out = adapter.serialize(entries);
```

Plural handling and the shared domain model come from
[`@turjuman/schema`](https://github.com/mogharsallah/turjuman/tree/main/packages/schema). This package is
used by the [`turjuman` CLI](https://github.com/mogharsallah/turjuman/tree/main/packages/cli) for
`pull`/`push`/`build`.

## License

MIT
