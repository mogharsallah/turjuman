import type { TranslationKey } from "@turjuman/schema";
import { notFound } from "@turjuman/schema";
import type { RepositoryApi } from "../repository/index.js";
import type { NamespaceService } from "./namespaces.js";

/**
 * Resolve a `(namespace, name)` label to its key id + definition on a branch,
 * through the copy-on-write fall-through. Shared by the context, example,
 * escalation, and comment services, which all address strings by their human
 * label but operate on the opaque `keyId`. Throws NOT_FOUND if no such key.
 */
export async function resolveKeyRef(
	repo: RepositoryApi,
	namespaces: NamespaceService,
	projectId: string,
	branch: string,
	name: string,
	namespace?: string,
): Promise<{ keyId: string; key: TranslationKey }> {
	const nsId = await namespaces.idOf(projectId, namespace);
	if (namespace && !nsId) throw notFound(`Key ${namespace}/${name} not found`);
	const keyId = await repo.resolveKeyIdByName(projectId, branch, nsId, name);
	const key = keyId
		? await repo.getKeyDef(projectId, branch, keyId)
		: undefined;
	if (!keyId || !key) throw notFound(`Key ${name} not found`);
	return { keyId, key };
}
