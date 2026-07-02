// ---- key builders -----------------------------------------------------------
//
// The single-table PK/SK (and GSI) string layout. Every partition/sort key used
// by the Repository is built here so the access patterns live in one place.
//
// Layout families:
//   PROJECT#<id>                       project singletons (locales, members,
//                                       glossary, webhooks, qa-config, branches,
//                                       namespaces, runs).
//   PROJ#<id>#BR#<branch>              a branch's key definitions + name lookups.
//   PROJ#<id>#BR#<branch>#LOC#<code>  a branch×locale's translation cells and
//                                       their append-only version chains.
//
// Identity is opaque: a key is addressed by `keyId`, a translation by
// `(branchId, keyId, locale)`. `(namespaceId, name)` are renamable labels stored
// in a side `KEYNAME#` lookup row, never in identity.

export const userPK = (id: string) => `USER#${id}`;
export const emailPK = (email: string) => `USEREMAIL#${email.toLowerCase()}`;
/** Singleton marker reserving the single OWNER bootstrap slot for an org. Written
 * with `attribute_not_exists` so first-owner creation is atomic under concurrency. */
export const orgOwnerPK = (orgId: string) => `ORGOWNER#${orgId}`;
export const apiKeyPK = (hash: string) => `APIKEY#${hash}`;
export const orgGSI1PK = (orgId: string) => `ORG#${orgId}`;
export const projectPK = (id: string) => `PROJECT#${id}`;
export const memberSK = (userId: string) => `MEMBER#${userId}`;
export const localeSK = (code: string) => `LOCALE#${code}`;
export const glossarySK = (termId: string) => `GLOSSARY#${termId}`;
export const webhookSK = (id: string) => `WEBHOOK#${id}`;
/** Per-project QA config is a singleton under the project partition. */
export const qaConfigSK = () => "QACONFIG";

// ---- branches / namespaces / runs (project-partition singletons) ------------

/** A branch record lives under its project partition. */
export const branchSK = (branchId: string) => `BRANCH#${branchId}`;
/** A namespace (opaque-id grouping of keys) lives under its project partition. */
export const namespaceSK = (namespaceId: string) => `NS#${namespaceId}`;
/** A translation run (the agent write primitive) lives under its project partition. */
export const runSK = (runId: string) => `RUN#${runId}`;

// ---- context layer + review records (project-partition) ---------------------

/** A scoped, mergeable translation rule (voice / length / compliance). */
export const contextRuleSK = (id: string) => `CTXRULE#${id}`;
/** A translation example (the few-shot / translation-memory corpus). */
export const exampleSK = (id: string) => `EXAMPLE#${id}`;
/** A human escalation (the review router's terminal exit). */
export const escalationSK = (id: string) => `ESC#${id}`;
/** A comment is branch-free, keyed by the `(keyId, locale)` string it discusses,
 * so every comment on one string shares a sort-key prefix. */
export const commentSK = (keyId: string, locale: string, id: string) =>
	`CMT#${keyId}#${locale}#${id}`;
/** Prefix matching every comment on one `(keyId, locale)` string. */
export const commentPrefix = (keyId: string, locale: string) =>
	`CMT#${keyId}#${locale}#`;

// ---- releases + field reports -----------------------------------------------

/** A Release's metadata row lives under its project partition (so releases list
 * with one prefix query); its pinned entries live in a dedicated per-release
 * partition, so a release with thousands of entries never bloats one item. */
export const releaseSK = (releaseId: string) => `REL#${releaseId}`;
/** Partition holding one release's pinned `(keyId, locale)` entry rows. */
export const releaseEntryPK = (projectId: string, releaseId: string) =>
	`PROJ#${projectId}#REL#${releaseId}`;
/** A pinned cell within a release (its accepted version at cut time). */
export const releaseEntrySK = (keyId: string, code: string) =>
	`KEY#${keyId}#${code}`;
/** A production field report lives under its project partition. */
export const fieldReportSK = (id: string) => `FR#${id}`;

// ---- key definitions + name lookup (per branch) -----------------------------

/** Partition holding a branch's key definitions and `KEYNAME#` name-lookup rows. */
export const keyDefPK = (projectId: string, branchId: string) =>
	`PROJ#${projectId}#BR#${branchId}`;
/** A key definition, addressed by its opaque id. */
export const keyDefSK = (keyId: string) => `KEY#${keyId}`;
/**
 * Side row mapping a `(namespace, name)` label to a `keyId` — the rename-safe
 * uniqueness guard and `name -> id` resolver. A key with no namespace uses the
 * reserved `_` segment. Tombstoned (deleted) on rename so the old name frees up.
 */
export const keyNameSK = (namespaceId: string | undefined, name: string) =>
	`KEYNAME#${namespaceId ?? "_"}#${name}`;

// ---- translation cells + version chains (per branch×locale) -----------------

/** Partition holding a branch×locale's live cells and their version chains. */
export const cellPK = (projectId: string, branchId: string, code: string) =>
	`PROJ#${projectId}#BR#${branchId}#LOC#${code}`;
/** The live, mutable cell for one key in this branch×locale. */
export const cellSK = (keyId: string) => `KEY#${keyId}`;
/**
 * An append-only accepted-value commit. Zero-padded so lexical SK order matches
 * numeric `seq` order, and prefixed `VER#` (not `KEY#`) so a `begins_with("KEY#")`
 * scan of a locale partition returns live cells only, never version rows.
 */
export const versionSK = (keyId: string, seq: number) =>
	`VER#${keyId}#${padSeq(seq)}`;
/** Prefix matching every version row of one key in a locale partition. */
export const versionPrefix = (keyId: string) => `VER#${keyId}#`;

/** "by key" GSI: every locale's live cell for one key on one branch. Set on the
 * live cell only (never on version rows), so the index lists cells, not commits. */
export const cellGSI3PK = (
	projectId: string,
	branchId: string,
	keyId: string,
) => `PROJ#${projectId}#BR#${branchId}#KEY#${keyId}`;
export const cellGSI3SK = (code: string) => `LOC#${code}`;

// ---- helpers ----------------------------------------------------------------

/** Fixed width for zero-padded sequence numbers in sort keys (lexical == numeric). */
const SEQ_WIDTH = 12;
/** Zero-pad a sequence number so its string sorts in numeric order. */
export const padSeq = (seq: number) => String(seq).padStart(SEQ_WIDTH, "0");
