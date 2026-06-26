import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Expand a path pattern's `{locale}` placeholder. */
export function filePath(pattern: string, locale: string): string {
	return pattern.replace(/\{locale\}/g, locale);
}

/** A sink for writing locale files. Injectable so command logic stays testable. */
export type FileWriter = (path: string, content: string) => void;

/** Default writer: create parent directories, then write the file. */
export const writeFileEnsured: FileWriter = (path, content) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
};
