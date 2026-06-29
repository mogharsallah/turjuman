import type { Actor, Comment } from "@turjuman/schema";
import { MAIN_BRANCH_ID, newId, requireText } from "@turjuman/schema";
import type { RepositoryApi } from "../repository/index.js";
import { BaseService } from "./base.js";
import { resolveKeyRef } from "./keyref.js";
import type { NamespaceService } from "./namespaces.js";

export interface AddCommentInput {
	namespace?: string;
	body: string;
	/** Parent comment id for threading; absent = a root comment. */
	parentId?: string;
}

/**
 * Threaded discussion on a `(key, locale)` string — where humans record the
 * judgment a lifecycle flag can't carry (why a string is off, an agreed
 * phrasing). Branch-free: a comment attaches to the string, shared across
 * branches, so it is always resolved and stored on `main`.
 */
export class CommentService extends BaseService {
	constructor(
		repo: RepositoryApi,
		private readonly namespaces: NamespaceService,
	) {
		super(repo);
	}

	async add(
		actor: Actor,
		projectId: string,
		code: string,
		name: string,
		input: AddCommentInput,
	): Promise<Comment> {
		await this.authorizeProject(actor, projectId, "translation.write");
		await this.requireLocaleExists(projectId, code);
		const { keyId } = await resolveKeyRef(
			this.repo,
			this.namespaces,
			projectId,
			MAIN_BRANCH_ID,
			name,
			input.namespace,
		);
		return this.repo.putComment({
			id: newId("cmt"),
			projectId,
			keyId,
			locale: code,
			authorId: actor.userId,
			body: requireText(input.body, "body"),
			parentId: input.parentId,
			createdAt: new Date().toISOString(),
		});
	}

	async list(
		actor: Actor,
		projectId: string,
		code: string,
		name: string,
		opts: { namespace?: string } = {},
	): Promise<Comment[]> {
		await this.authorizeProject(actor, projectId, "translation.read");
		const { keyId } = await resolveKeyRef(
			this.repo,
			this.namespaces,
			projectId,
			MAIN_BRANCH_ID,
			name,
			opts.namespace,
		);
		const comments = await this.repo.listComments(projectId, keyId, code);
		return comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
}
