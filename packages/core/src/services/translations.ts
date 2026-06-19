import {
  DEFAULT_NAMESPACE,
  type Translation,
  type TranslationKey,
  type TranslationStatus,
} from "@turjuman/schema";
import { notFound } from "@turjuman/schema";
import type { Actor } from "@turjuman/schema";
import type { BulkSetResult } from "@turjuman/schema";
import { BaseService } from "./base.js";
import type {
  BundleEntry,
  BundlePage,
  KeyPage,
  SetTranslationInput,
  TranslationPage,
} from "./types.js";

export class TranslationsService extends BaseService {
  async listForKey(
    actor: Actor,
    projectId: string,
    name: string,
    namespace = DEFAULT_NAMESPACE,
  ): Promise<Translation[]> {
    await this.authorizeProject(actor, projectId, "translation.read");
    return this.repo.listTranslationsByKey(projectId, namespace, name);
  }

  async listForLocale(
    actor: Actor,
    projectId: string,
    code: string,
  ): Promise<Translation[]> {
    await this.authorizeProject(actor, projectId, "translation.read");
    await this.requireLocaleExists(projectId, code);
    return this.repo.listTranslationsByLocale(projectId, code);
  }

  /**
   * One page of a locale's raw translations, so a large locale doesn't force a
   * full-partition read on every call. `cursor` is the opaque `nextCursor` from a
   * prior page; omit both `limit` and `cursor` and callers should use
   * `listForLocale` instead.
   */
  async listForLocalePage(
    actor: Actor,
    projectId: string,
    code: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<TranslationPage> {
    await this.authorizeProject(actor, projectId, "translation.read");
    await this.requireLocaleExists(projectId, code);
    return this.repo.listTranslationsByLocalePage(projectId, code, opts);
  }

  /**
   * Export a locale as adapter-ready entries: each key's deliverable value plus
   * the key's description and plural flag (joined from the key metadata). Used by
   * the CLI `pull`/`build` so file formats can carry comments and plurals.
   *
   * By default this ships each key's **approved** value (the `approvedValue`
   * snapshot), so in-progress or edited-since-approval work never leaks into
   * delivered output. `slot: "working"` ships the live `value` instead (preview /
   * staging). The base locale always ships its `value` — it is the source of
   * truth. When an approved value is missing, `fallback: "source"` (default)
   * fills from the base value; `fallback: "omit"` drops the key.
   */
  async exportBundle(
    actor: Actor,
    projectId: string,
    code: string,
    opts: {
      slot?: "approved" | "working";
      fallback?: "source" | "omit";
      excludeStale?: boolean;
    } = {},
  ): Promise<BundleEntry[]> {
    const { project } = await this.authorizeProject(actor, projectId, "translation.read");
    await this.requireLocaleExists(projectId, code);
    const slot = opts.slot ?? "approved";
    const fallback = opts.fallback ?? "source";
    const isBase = code === project.baseLocale;
    const [keys, translations] = await Promise.all([
      this.repo.listKeys(projectId),
      this.repo.listTranslationsByLocale(projectId, code),
    ]);
    // Base values feed source-fallback and stale detection.
    const needBase = !isBase && (fallback === "source" || opts.excludeStale === true);
    const baseValues = needBase
      ? new Map(
          (await this.repo.listTranslationsByLocale(projectId, project.baseLocale)).map((t) => [
            `${t.namespace}#${t.keyName}`,
            t.value,
          ]),
        )
      : new Map<string, string>();
    // Active keys only — deprecated keys are retained but never exported.
    const keyMeta = new Map(
      keys.filter((k) => k.state !== "deprecated").map((k) => [`${k.namespace}#${k.name}`, k]),
    );
    return this.toBundleEntries(translations, { isBase, slot, fallback, keyMeta, baseValues, excludeStale: opts.excludeStale });
  }

  /**
   * Like `exportBundle`, but returns one page of entries plus an opaque
   * `nextCursor`, so the export never materializes a whole locale (and its
   * key/base-value joins) at once. The key metadata and base values needed by a
   * page are fetched scoped to just that page's keys — bounding per-request work.
   * Omit `limit`/`cursor` to walk the whole locale via `exportBundle` instead.
   */
  async exportBundlePage(
    actor: Actor,
    projectId: string,
    code: string,
    opts: {
      slot?: "approved" | "working";
      fallback?: "source" | "omit";
      excludeStale?: boolean;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<BundlePage> {
    const { project } = await this.authorizeProject(actor, projectId, "translation.read");
    await this.requireLocaleExists(projectId, code);
    const slot = opts.slot ?? "approved";
    const fallback = opts.fallback ?? "source";
    const isBase = code === project.baseLocale;
    const page = await this.repo.listTranslationsByLocalePage(projectId, code, {
      limit: opts.limit,
      cursor: opts.cursor,
    });
    // Resolve the joins for only this page's keys, in parallel.
    const distinct = [
      ...new Map(page.translations.map((t) => [`${t.namespace}#${t.keyName}`, t])).values(),
    ];
    const needBase = !isBase && (fallback === "source" || opts.excludeStale === true);
    const keyMeta = new Map<string, TranslationKey>();
    const baseValues = new Map<string, string>();
    await Promise.all(
      distinct.map(async (t) => {
        const id = `${t.namespace}#${t.keyName}`;
        const [key, base] = await Promise.all([
          this.repo.getKey(projectId, t.namespace, t.keyName),
          needBase
            ? this.repo.getTranslation(projectId, project.baseLocale, t.namespace, t.keyName)
            : Promise.resolve(undefined),
        ]);
        // Active keys only — deprecated keys are retained but never exported.
        if (key && key.state !== "deprecated") keyMeta.set(id, key);
        if (base) baseValues.set(id, base.value);
      }),
    );
    const entries = this.toBundleEntries(page.translations, {
      isBase,
      slot,
      fallback,
      keyMeta,
      baseValues,
      excludeStale: opts.excludeStale,
    });
    return { entries, nextCursor: page.nextCursor };
  }

  /** Shared per-translation transform for the whole and paged bundle exports. */
  private toBundleEntries(
    translations: Translation[],
    ctx: {
      isBase: boolean;
      slot: "approved" | "working";
      fallback: "source" | "omit";
      keyMeta: Map<string, TranslationKey>;
      baseValues: Map<string, string>;
      excludeStale?: boolean;
    },
  ): BundleEntry[] {
    const out: BundleEntry[] = [];
    for (const t of translations) {
      const id = `${t.namespace}#${t.keyName}`;
      const meta = ctx.keyMeta.get(id);
      if (!meta) continue; // deprecated or deleted key
      if (
        ctx.excludeStale &&
        !ctx.isBase &&
        t.sourceRef !== undefined &&
        t.sourceRef !== ctx.baseValues.get(id)
      ) {
        continue; // stale: the source moved on since this was written
      }
      let value = ctx.isBase || ctx.slot === "working" ? t.value : t.approvedValue ?? "";
      if (value === "" && ctx.fallback === "source" && !ctx.isBase) value = ctx.baseValues.get(id) ?? "";
      if (value === "") continue;
      out.push({
        key: t.keyName,
        namespace: t.namespace,
        value,
        description: meta.description,
        plural: meta.plural,
      });
    }
    return out;
  }

  /** Keys with no value (or an empty value) for the given locale. */
  async listUntranslated(
    actor: Actor,
    projectId: string,
    code: string,
  ): Promise<TranslationKey[]> {
    await this.authorizeProject(actor, projectId, "translation.read");
    await this.requireLocaleExists(projectId, code);
    const [keys, translations] = await Promise.all([
      this.repo.listKeys(projectId),
      this.repo.listTranslationsByLocale(projectId, code),
    ]);
    const filled = new Set(
      translations.filter((t) => t.value.trim() !== "").map((t) => `${t.namespace}#${t.keyName}`),
    );
    return keys.filter((k) => k.state !== "deprecated" && !filled.has(`${k.namespace}#${k.name}`));
  }

  /**
   * One page of a locale's untranslated keys, so a large project doesn't force a
   * full-project + full-locale read on every call. Pages the key partition via
   * the cursor and resolves each page key's value with a point read; like
   * {@link KeysService.listPage}, a page may return fewer than `limit` keys
   * (already-translated and deprecated keys are filtered out) while still
   * yielding a `nextCursor` to continue.
   */
  async listUntranslatedPage(
    actor: Actor,
    projectId: string,
    code: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<KeyPage> {
    await this.authorizeProject(actor, projectId, "translation.read");
    await this.requireLocaleExists(projectId, code);
    const page = await this.repo.listKeysPage(projectId, { limit: opts.limit, cursor: opts.cursor });
    const active = page.keys.filter((k) => k.state !== "deprecated");
    const values = await Promise.all(
      active.map((k) => this.repo.getTranslation(projectId, code, k.namespace, k.name)),
    );
    const keys = active.filter((_, i) => {
      const t = values[i];
      return !t || t.value.trim() === "";
    });
    return { keys, nextCursor: page.nextCursor };
  }

  /**
   * Keys whose translation for the locale was written against a base value that
   * has since changed — the source moved on, so the target is stale and should be
   * re-translated. The base locale (the source) is never stale.
   */
  async listStale(actor: Actor, projectId: string, code: string): Promise<TranslationKey[]> {
    const { project } = await this.authorizeProject(actor, projectId, "translation.read");
    await this.requireLocaleExists(projectId, code);
    if (code === project.baseLocale) return [];
    const [keys, translations, baseTranslations] = await Promise.all([
      this.repo.listKeys(projectId),
      this.repo.listTranslationsByLocale(projectId, code),
      this.repo.listTranslationsByLocale(projectId, project.baseLocale),
    ]);
    const baseValue = new Map(baseTranslations.map((t) => [`${t.namespace}#${t.keyName}`, t.value]));
    const stale = new Set(
      translations
        .filter(
          (t) =>
            t.sourceRef !== undefined &&
            t.sourceRef !== baseValue.get(`${t.namespace}#${t.keyName}`),
        )
        .map((t) => `${t.namespace}#${t.keyName}`),
    );
    return keys.filter((k) => k.state !== "deprecated" && stale.has(`${k.namespace}#${k.name}`));
  }

  /**
   * One page of a locale's stale keys, bounding per-request work the same way as
   * {@link listUntranslatedPage}. The base locale is the source, so it is never
   * stale and returns an empty page. Pages the key partition and point-reads each
   * page key's target and base value; a page may return fewer than `limit` keys
   * (current and deprecated keys are filtered out) while still yielding a `nextCursor`.
   */
  async listStalePage(
    actor: Actor,
    projectId: string,
    code: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<KeyPage> {
    const { project } = await this.authorizeProject(actor, projectId, "translation.read");
    await this.requireLocaleExists(projectId, code);
    if (code === project.baseLocale) return { keys: [], nextCursor: undefined };
    const page = await this.repo.listKeysPage(projectId, { limit: opts.limit, cursor: opts.cursor });
    const active = page.keys.filter((k) => k.state !== "deprecated");
    const pairs = await Promise.all(
      active.map(async (k) => {
        const [target, base] = await Promise.all([
          this.repo.getTranslation(projectId, code, k.namespace, k.name),
          this.repo.getTranslation(projectId, project.baseLocale, k.namespace, k.name),
        ]);
        return { target, base };
      }),
    );
    const keys = active.filter((_, i) => {
      const { target, base } = pairs[i]!;
      return target?.sourceRef !== undefined && target.sourceRef !== base?.value;
    });
    return { keys, nextCursor: page.nextCursor };
  }

  /** Current base-locale value for a key, used to stamp a target's sourceRef. */
  private async baseValueOf(
    projectId: string,
    baseLocale: string,
    namespace: string,
    name: string,
  ): Promise<string | undefined> {
    return (await this.repo.getTranslation(projectId, baseLocale, namespace, name))?.value;
  }

  async set(
    actor: Actor,
    projectId: string,
    code: string,
    input: SetTranslationInput,
  ): Promise<Translation> {
    const status = input.status ?? "translated";
    const { project } = await this.authorizeProject(
      actor,
      projectId,
      status === "approved" ? "translation.review" : "translation.write",
    );
    await this.requireLocaleExists(projectId, code);
    const namespace = input.namespace ?? DEFAULT_NAMESPACE;
    if (!(await this.repo.getKey(projectId, namespace, input.name))) {
      throw notFound(`Key ${namespace}/${input.name} not found`);
    }
    const existing = await this.repo.getTranslation(projectId, code, namespace, input.name);
    const translation: Translation = {
      projectId,
      localeCode: code,
      namespace,
      keyName: input.name,
      value: input.value,
      status,
      // Promote on approval; otherwise keep the last approved snapshot intact.
      approvedValue: status === "approved" ? input.value : existing?.approvedValue,
      // Stamp the base value this target was written against, so we can later
      // detect when the source has moved on (staleness). The base locale is the
      // source itself, so it carries no sourceRef.
      sourceRef:
        code === project.baseLocale
          ? undefined
          : await this.baseValueOf(projectId, project.baseLocale, namespace, input.name),
      origin: input.origin ?? existing?.origin,
      updatedBy: actor.userId,
      updatedAt: new Date().toISOString(),
    };
    return this.repo.putTranslation(translation);
  }

  /** Set many translations for one locale in a single call (LLM bulk-fill). */
  async bulkSet(
    actor: Actor,
    projectId: string,
    code: string,
    entries: SetTranslationInput[],
  ): Promise<BulkSetResult> {
    const needsReview = entries.some((e) => (e.status ?? "translated") === "approved");
    const { project } = await this.authorizeProject(
      actor,
      projectId,
      needsReview ? "translation.review" : "translation.write",
    );
    await this.requireLocaleExists(projectId, code);

    // Validate against only the namespaces present in this batch, so a large
    // project isn't fully scanned on every bulk write.
    const namespaces = new Set(entries.map((e) => e.namespace ?? DEFAULT_NAMESPACE));
    const knownKeys = new Set<string>();
    await Promise.all(
      [...namespaces].map(async (ns) => {
        for (const k of await this.repo.listKeys(projectId, ns)) knownKeys.add(`${ns}#${k.name}`);
      }),
    );
    // Existing values for this locale, so a non-approving write preserves the
    // last approved snapshot (and prior origin) for each key.
    const prevByKey = new Map(
      (await this.repo.listTranslationsByLocale(projectId, code)).map((t) => [
        `${t.namespace}#${t.keyName}`,
        t,
      ]),
    );
    // Base values, to stamp each target's sourceRef (skipped when writing the
    // base locale itself, which is the source).
    const isBase = code === project.baseLocale;
    const baseByKey = isBase
      ? new Map<string, string>()
      : new Map(
          (await this.repo.listTranslationsByLocale(projectId, project.baseLocale)).map((t) => [
            `${t.namespace}#${t.keyName}`,
            t.value,
          ]),
        );
    const now = new Date().toISOString();
    const toWrite: Translation[] = [];
    const skipped: string[] = [];
    for (const e of entries) {
      const namespace = e.namespace ?? DEFAULT_NAMESPACE;
      const id = `${namespace}#${e.name}`;
      if (!knownKeys.has(id)) {
        skipped.push(id);
        continue;
      }
      const status = e.status ?? "translated";
      const prev = prevByKey.get(id);
      toWrite.push({
        projectId,
        localeCode: code,
        namespace,
        keyName: e.name,
        value: e.value,
        status,
        approvedValue: status === "approved" ? e.value : prev?.approvedValue,
        sourceRef: isBase ? undefined : baseByKey.get(id),
        origin: e.origin ?? prev?.origin,
        updatedBy: actor.userId,
        updatedAt: now,
      });
    }
    await this.repo.putTranslations(toWrite);
    return { written: toWrite.length, skipped };
  }

  async setStatus(
    actor: Actor,
    projectId: string,
    code: string,
    name: string,
    status: TranslationStatus,
    namespace = DEFAULT_NAMESPACE,
  ): Promise<Translation> {
    await this.authorizeProject(
      actor,
      projectId,
      status === "approved" ? "translation.review" : "translation.write",
    );
    const existing = await this.repo.getTranslation(projectId, code, namespace, name);
    if (!existing) throw notFound(`No ${code} translation for ${namespace}/${name}`);
    const updated: Translation = {
      ...existing,
      status,
      // Approving promotes the current working value into the approved snapshot;
      // any other transition leaves the last approved snapshot untouched.
      approvedValue: status === "approved" ? existing.value : existing.approvedValue,
      updatedBy: actor.userId,
      updatedAt: new Date().toISOString(),
    };
    return this.repo.putTranslation(updated);
  }
}
