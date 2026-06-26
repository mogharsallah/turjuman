// ---- key builders -----------------------------------------------------------
//
// The single-table PK/SK (and GSI) string layout. Every partition/sort key used
// by the Repository is built here so the access patterns live in one place.

export const userPK = (id: string) => `USER#${id}`;
export const emailPK = (email: string) => `USEREMAIL#${email.toLowerCase()}`;
export const apiKeyPK = (hash: string) => `APIKEY#${hash}`;
export const orgGSI1PK = (orgId: string) => `ORG#${orgId}`;
export const projectPK = (id: string) => `PROJECT#${id}`;
export const memberSK = (userId: string) => `MEMBER#${userId}`;
export const localeSK = (code: string) => `LOCALE#${code}`;
export const keySK = (ns: string, name: string) => `KEY#${ns}#${name}`;
export const transPK = (projectId: string, code: string) =>
	`PROJ#${projectId}#LOC#${code}`;
export const keyGSI3PK = (projectId: string, ns: string, name: string) =>
	`PROJ#${projectId}#KEY#${ns}#${name}`;
export const locGSI3SK = (code: string) => `LOC#${code}`;
export const glossarySK = (termId: string) => `GLOSSARY#${termId}`;
export const webhookSK = (id: string) => `WEBHOOK#${id}`;
/** Per-project QA config is a singleton under the project partition. */
export const qaConfigSK = () => "QACONFIG";
/** Per-project AI-scoring config is a singleton under the project partition. */
export const scoreConfigSK = () => "SCORECONFIG";
