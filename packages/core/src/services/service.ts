import type { Repository } from "../repository/index.js";
import { ApiKeysService } from "./api-keys.js";
import { GlossaryService } from "./glossary.js";
import { KeysService } from "./keys.js";
import { LocalesService } from "./locales.js";
import { MembersService } from "./members.js";
import { ProjectsService } from "./projects.js";
import { QaService } from "./qa.js";
import { TranslationMemoryService } from "./tm.js";
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
  readonly locales: LocalesService;
  readonly keys: KeysService;
  readonly translations: TranslationsService;
  readonly glossary: GlossaryService;
  readonly tm: TranslationMemoryService;
  readonly qa: QaService;
  readonly webhooks: WebhooksService;
  readonly members: MembersService;
  readonly users: UsersService;
  readonly apiKeys: ApiKeysService;

  constructor(repo: Repository) {
    this.projects = new ProjectsService(repo);
    this.locales = new LocalesService(repo);
    this.keys = new KeysService(repo);
    this.translations = new TranslationsService(repo);
    this.glossary = new GlossaryService(repo);
    this.tm = new TranslationMemoryService(repo);
    this.qa = new QaService(repo);
    this.webhooks = new WebhooksService(repo);
    this.members = new MembersService(repo);
    this.users = new UsersService(repo);
    this.apiKeys = new ApiKeysService(repo);
  }
}
