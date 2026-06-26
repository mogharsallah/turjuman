import { randomUUID } from "node:crypto";

/**
 * A per-scenario unique suffix. Scenarios share one deployed stack, so every
 * project/user/email name must be unique to keep specs independent and
 * order-insensitive.
 */
export const uniq = (prefix: string): string =>
	`${prefix}-${randomUUID().slice(0, 8)}`;
