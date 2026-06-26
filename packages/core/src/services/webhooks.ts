import { randomBytes } from "node:crypto";
import type { Actor, Webhook } from "@turjuman/schema";
import { newId, validation } from "@turjuman/schema";
import { BaseService } from "./base.js";
import type { AddWebhookInput } from "./types.js";

export class WebhooksService extends BaseService {
	async list(actor: Actor, projectId: string): Promise<Webhook[]> {
		await this.authorizeProject(actor, projectId, "webhook.manage");
		return this.repo.listWebhooks(projectId);
	}

	async add(
		actor: Actor,
		projectId: string,
		input: AddWebhookInput,
	): Promise<Webhook> {
		await this.authorizeProject(actor, projectId, "webhook.manage");
		const url = (input.url ?? "").trim();
		if (!/^https?:\/\/.+/.test(url))
			throw validation("Webhook url must be http(s)");
		const webhook: Webhook = {
			projectId,
			id: newId("wh"),
			url,
			events: input.events && input.events.length > 0 ? input.events : ["*"],
			secret: `whsec_${randomBytes(24).toString("base64url")}`,
			createdAt: new Date().toISOString(),
		};
		return this.repo.putWebhook(webhook);
	}

	async remove(actor: Actor, projectId: string, id: string): Promise<void> {
		await this.authorizeProject(actor, projectId, "webhook.manage");
		await this.repo.deleteWebhook(projectId, id);
	}
}
