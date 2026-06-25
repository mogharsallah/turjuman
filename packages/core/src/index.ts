// The pure domain model, schemas, RBAC policy, ICU helpers and QA engine live in
// @turjuman/schema now; re-export them so server-side consumers (mcp-server, api,
// deploy) keep importing everything from @turjuman/core unchanged.
export * from "@turjuman/schema";
export * from "./auth.js";
export { logInfo, logError, errorInfo, maskError, type MaskedError } from "./logging.js";
export { Repository, type RepositoryOptions } from "./repository/index.js";
export {
  TurjumanService,
  ProjectsService,
  LocalesService,
  KeysService,
  TranslationsService,
  GlossaryService,
  TranslationMemoryService,
  QaService,
  type RunChecksOptions,
  type SetQaConfigInput,
  ScoringService,
  type ScorePromptSelection,
  WebhooksService,
  MembersService,
  UsersService,
  ApiKeysService,
  type CreateProjectInput,
  type CreateKeyInput,
  type UpdateKeyInput,
  type SetTranslationInput,
  type ScoreInput,
  type SetScoreConfigInput,
  type ReviewResult,
  type ScorePrompt,
  type KeyWithTranslations,
  type KeyPage,
  type BundleEntry,
  type AddGlossaryTermInput,
  type UpdateGlossaryTermInput,
  type TmMatch,
  type AddWebhookInput,
} from "./services/index.js";

import { Repository } from "./repository/index.js";

/**
 * Construct a Repository from the environment. `TURJUMAN_TABLE` is set on each
 * Lambda by the deploy stack; falls back to "Turjuman" for local use.
 */
export function repositoryFromEnv(): Repository {
  return new Repository({ tableName: process.env.TURJUMAN_TABLE ?? "Turjuman" });
}
