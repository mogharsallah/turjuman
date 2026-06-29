// The pure domain model, schemas, RBAC policy, ICU helpers and QA engine live in
// @turjuman/schema now; re-export them so server-side consumers (mcp-server, api,
// deploy) keep importing everything from @turjuman/core unchanged.
export * from "@turjuman/schema";
export * from "./auth.js";
export {
	errorInfo,
	logError,
	logInfo,
	type MaskedError,
	maskError,
} from "./logging.js";
export {
	Repository,
	type RepositoryApi,
	type RepositoryOptions,
} from "./repository/index.js";
export {
	type AddGlossaryTermInput,
	type AddWebhookInput,
	ApiKeysService,
	type BundleEntry,
	type CreateKeyInput,
	type CreateProjectInput,
	GlossaryService,
	type KeyPage,
	KeysService,
	type KeyWithTranslations,
	LocalesService,
	MembersService,
	ProjectsService,
	QaService,
	type RunChecksOptions,
	type SetQaConfigInput,
	type SetTranslationInput,
	type TmMatch,
	TranslationMemoryService,
	TranslationsService,
	TurjumanService,
	type UpdateGlossaryTermInput,
	type UpdateKeyInput,
	UsersService,
	WebhooksService,
} from "./services/index.js";

import { Repository } from "./repository/index.js";

/**
 * Construct a Repository from the environment. `TURJUMAN_TABLE` is set on each
 * Lambda by the deploy stack; falls back to "Turjuman" for local use.
 */
export function repositoryFromEnv(): Repository {
	return new Repository({
		tableName: process.env.TURJUMAN_TABLE ?? "Turjuman",
	});
}
