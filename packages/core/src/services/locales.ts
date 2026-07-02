import type { Actor, Locale } from "@turjuman/schema";
import { conflict, requireLocale } from "@turjuman/schema";
import { BaseService } from "./base.js";

export class LocalesService extends BaseService {
	async list(actor: Actor, projectId: string): Promise<Locale[]> {
		await this.authorizeProject(actor, projectId, "locale.read");
		return this.repo.listLocales(projectId);
	}

	async add(
		actor: Actor,
		projectId: string,
		code: string,
		name?: string,
	): Promise<Locale> {
		await this.authorizeProject(actor, projectId, "locale.manage");
		const validCode = requireLocale(code, "code");
		if (await this.repo.getLocale(projectId, validCode)) {
			throw conflict(`Locale ${validCode} already exists`);
		}
		const locale: Locale = {
			projectId,
			code: validCode,
			name: name ?? validCode,
			lifecycle: "active",
			createdAt: new Date().toISOString(),
		};
		return this.repo.putLocale(locale);
	}
}
