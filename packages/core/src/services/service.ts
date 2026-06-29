import type { RepositoryApi } from "../repository/index.js";
import { ApiKeysService } from "./api-keys.js";
import { BranchService } from "./branches.js";
import { GlossaryService } from "./glossary.js";
import { KeysService } from "./keys.js";
import { LocalesService } from "./locales.js";
import { MembersService } from "./members.js";
import { NamespaceService } from "./namespaces.js";
import { ProjectsService } from "./projects.js";
import { QaService } from "./qa.js";
import { RunService } from "./runs.js";
import { TranslationsService } from "./translations.js";
import { UsersService } from "./users.js";
import { WebhooksService } from "./webhooks.js";

/**
 * Service layer: the single home of business logic and authorization. The MCP
 * server and REST API are thin adapters over these methods, grouped by domain
 * (`service.projects.create(...)`, `service.keys.import(...)`, ...). Every
 * mutating method enforces RBAC before touching the repository. Field-format
 * validation (locale codes, key/namespace names, emails) lives in
 * ../validation.ts, shared with the transports.
 */
export class TurjumanService {
	readonly projects: ProjectsService;
	readonly branches: BranchService;
	readonly locales: LocalesService;
	readonly namespaces: NamespaceService;
	readonly keys: KeysService;
	readonly translations: TranslationsService;
	readonly runs: RunService;
	readonly glossary: GlossaryService;
	readonly qa: QaService;
	readonly webhooks: WebhooksService;
	readonly members: MembersService;
	readonly users: UsersService;
	readonly apiKeys: ApiKeysService;

	constructor(repo: RepositoryApi) {
		// Namespace/branch services are shared dependencies of the key/translation
		// services, so construct them first.
		this.namespaces = new NamespaceService(repo);
		this.branches = new BranchService(repo);
		this.projects = new ProjectsService(repo, this.branches);
		this.locales = new LocalesService(repo);
		this.keys = new KeysService(repo, this.namespaces);
		this.translations = new TranslationsService(repo, this.namespaces);
		this.runs = new RunService(repo);
		this.glossary = new GlossaryService(repo);
		this.qa = new QaService(repo, this.namespaces);
		this.webhooks = new WebhooksService(repo);
		this.members = new MembersService(repo);
		this.users = new UsersService(repo);
		this.apiKeys = new ApiKeysService(repo);
	}
}
