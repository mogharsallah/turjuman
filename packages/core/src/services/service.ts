import type { RepositoryApi } from "../repository/index.js";
import { ApiKeysService } from "./api-keys.js";
import { BranchService } from "./branches.js";
import { CommentService } from "./comments.js";
import { ContextService } from "./context.js";
import { EscalationService } from "./escalations.js";
import { ExampleService } from "./examples.js";
import { FieldReportService } from "./field-reports.js";
import { GlossaryService } from "./glossary.js";
import { KeysService } from "./keys.js";
import { LocalesService } from "./locales.js";
import { MembersService } from "./members.js";
import { NamespaceService } from "./namespaces.js";
import { ProjectsService } from "./projects.js";
import { QaService } from "./qa.js";
import { ReleaseService } from "./releases.js";
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
	readonly context: ContextService;
	readonly examples: ExampleService;
	readonly escalations: EscalationService;
	readonly comments: CommentService;
	readonly releases: ReleaseService;
	readonly fieldReports: FieldReportService;
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
		// The context service owns the staleness fan-out; glossary/example/escalation
		// writes route through it, so build it before them.
		this.context = new ContextService(repo, this.namespaces);
		this.projects = new ProjectsService(repo, this.branches);
		this.locales = new LocalesService(repo);
		this.keys = new KeysService(repo, this.namespaces);
		this.translations = new TranslationsService(repo, this.namespaces);
		this.runs = new RunService(repo);
		this.glossary = new GlossaryService(repo, this.context);
		this.examples = new ExampleService(repo, this.context, this.namespaces);
		this.escalations = new EscalationService(
			repo,
			this.namespaces,
			this.context,
		);
		this.comments = new CommentService(repo, this.namespaces);
		this.releases = new ReleaseService(repo);
		this.fieldReports = new FieldReportService(
			repo,
			this.namespaces,
			this.context,
		);
		this.qa = new QaService(repo, this.namespaces);
		this.webhooks = new WebhooksService(repo);
		this.members = new MembersService(repo);
		this.users = new UsersService(repo);
		this.apiKeys = new ApiKeysService(repo);
	}
}
