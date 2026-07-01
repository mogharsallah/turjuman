import {
	localeCode,
	type Operation,
	op,
	projectId,
	releaseSchema,
	z,
} from "../base.js";

/** Releases: immutable shipped snapshots. Cutting one pins a branch's accepted
 * view at a moment; "live" is the latest release, and CI pulls a release to build
 * a reproducible bundle. */
export const releaseOps: Operation[] = [
	op({
		name: "create_release",
		description:
			"Cut an immutable release: pin a branch's accepted view (own cells + fall-through) as a fixed snapshot. Supersedes the prior open release on the same branch. `locales` defaults to every project locale.",
		input: z.object({
			projectId,
			label: z.string().describe("Human label, e.g. a version."),
			branch: z.string().optional().describe("Branch to pin (default main)."),
			locales: z
				.array(localeCode)
				.optional()
				.describe("Locales to include (default all)."),
		}),
		output: releaseSchema,
		handler: ({ projectId: id, ...input }, { service, actor }) =>
			service.releases.create(actor, id, input),
	}),
	op({
		name: "list_releases",
		description:
			"List the project's releases (metadata only; use get_release for one release's pinned entries).",
		input: z.object({ projectId }),
		output: z.array(releaseSchema),
		annotations: { readOnlyHint: true },
		handler: (a, { service, actor }) =>
			service.releases.list(actor, a.projectId),
	}),
	op({
		name: "get_release",
		description:
			"Get one release with its full pinned entries — the `(keyId, locale) → version` snapshot of what shipped.",
		input: z.object({ projectId, releaseId: z.string() }),
		output: releaseSchema,
		annotations: { readOnlyHint: true },
		handler: (a, { service, actor }) =>
			service.releases.get(actor, a.projectId, a.releaseId),
	}),
];
