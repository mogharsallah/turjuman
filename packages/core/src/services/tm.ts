import type { Actor } from "@turjuman/schema";
import { BaseService } from "./base.js";
import { dice, normalizeTm } from "./tm-helpers.js";
import type { TmMatch } from "./types.js";

export class TranslationMemoryService extends BaseService {
  /**
   * Suggest prior translations for `text` in `locale`, by matching the source
   * (base-locale) values of keys that already have a translation in `locale`.
   * Exact and normalized matches rank highest; the rest fall back to a character
   * bigram similarity. No separate TM store — this is computed on demand, so it
   * reads the project's base- and target-locale translations (inherent to the
   * single-table design; there is deliberately no TM index).
   */
  async lookup(
    actor: Actor,
    projectId: string,
    code: string,
    text: string,
    limit = 5,
  ): Promise<TmMatch[]> {
    const { project } = await this.authorizeProject(actor, projectId, "translation.read");
    await this.requireLocaleExists(projectId, code);
    const [baseTranslations, targetTranslations] = await Promise.all([
      this.repo.listTranslationsByLocale(projectId, project.baseLocale),
      this.repo.listTranslationsByLocale(projectId, code),
    ]);
    const targetByKey = new Map(
      targetTranslations.map((t) => [`${t.namespace}#${t.keyName}`, t.value]),
    );
    const query = normalizeTm(text);
    const matches: TmMatch[] = [];
    for (const base of baseTranslations) {
      if (base.value === "") continue;
      const target = targetByKey.get(`${base.namespace}#${base.keyName}`);
      if (!target) continue;
      const score =
        base.value === text ? 1 : normalizeTm(base.value) === query ? 0.95 : dice(query, normalizeTm(base.value));
      if (score >= 0.5) {
        matches.push({
          source: base.value,
          target,
          score: Math.round(score * 100) / 100,
          key: base.keyName,
          namespace: base.namespace,
        });
      }
    }
    matches.sort((a, b) => b.score - a.score);
    return matches.slice(0, limit);
  }
}
