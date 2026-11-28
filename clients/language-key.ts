/**
 * THE language key of a file (#195): the language-registry id
 * (`resolveLanguage`: `typescript`, `python`, `c`), which is what users
 * write, never a dispatch kind (`jsts`, `cxx`), plus one addition:
 *
 * - SHELL DIALECT. A shell file that states a dialect (directive, shebang,
 *   `.zsh`/`.bash`) is keyed by it first (`zsh`, then `shell`). One that
 *   states none (`Makefile`) gets no dialect key, so `bash` never captures
 *   it through the resolver's bash default.
 */

import { extname } from "node:path";
import type { FileKind } from "./file-kinds.js";
import {
	LANGUAGES,
	type LanguageEntry,
	resolveLanguage,
} from "./language-registry.js";
import { resolveShellFileDialect } from "./shell-dialect.js";

/** The registry's shell language id. */
const SHELL_LANGUAGE_ID = "shell";

/**
 * Shell dialects that are language keys of their own, looked up before
 * `shell`. None collides with a registry id (pinned by test).
 */
export const SHELL_DIALECT_KEYS: readonly string[] = [
	"sh",
	"bash",
	"zsh",
	"dash",
	"ash",
	"ksh",
	"mksh",
	"busybox",
];

/** What decided a file's language. */
export type LanguageSource = "name";

/** Where a resolved dialect came from, most authoritative first. */
export type DialectSource = "directive" | "shebang" | "extension" | "default";

/** A dialect and the evidence that decided it. */
export interface ResolvedDialect {
	readonly dialect: string;
	readonly source: DialectSource;
}

/** A file's registry language and the evidence that decided it. */
export interface ResolvedFileLanguage {
	readonly entry: LanguageEntry;
	readonly source: LanguageSource;
}

/** A file's language key and how it was reached. */
export interface ResolvedLanguageKey {
	/** The registry language id, or undefined for an unplaced file. */
	readonly language: string | undefined;
	/** The coarse dispatch kind the registry maps the language onto. */
	readonly kind?: FileKind;
	/** What decided the language; absent for an unplaced file. */
	readonly languageSource?: LanguageSource;
	/** The shell dialect, when the language is shell and the file states one. */
	readonly dialect?: ResolvedDialect;
	/**
	 * Keys to look a setting up by, most specific first: the dialect key,
	 * then the language id. Empty for an unplaced file.
	 */
	readonly candidates: readonly string[];
}

/** A parsed language key. */
export interface ParsedLanguageKey {
	/** The registry language id the key belongs to. */
	readonly language: string;
	/** The shell dialect, for a dialect key (`zsh` -> shell, zsh). */
	readonly dialect?: string;
}

const LANGUAGE_IDS: ReadonlySet<string> = new Set(
	LANGUAGES.map((entry) => entry.id),
);
const DIALECT_KEYS: ReadonlySet<string> = new Set(SHELL_DIALECT_KEYS);

/** A registry language id or a shell dialect key; undefined otherwise. */
export function parseLanguageKey(key: string): ParsedLanguageKey | undefined {
	if (LANGUAGE_IDS.has(key)) return { language: key };
	if (DIALECT_KEYS.has(key))
		return { language: SHELL_LANGUAGE_ID, dialect: key };
	return undefined;
}

/** A file's registry language (`resolveLanguage`), with its evidence. */
export function resolveFileLanguage(
	filePath: string,
): ResolvedFileLanguage | undefined {
	const byName = resolveLanguage(filePath);
	return byName ? { entry: byName, source: "name" } : undefined;
}

/** Dialect-bearing shell extensions (upstream maps only `.zsh` to a name). */
const SHELL_DIALECT_EXTENSIONS: ReadonlyMap<string, string> = new Map([
	[".zsh", "zsh"],
	[".bash", "bash"],
]);

/** The dialect a shell file states (`resolveShellFileDialect`), with its evidence. */
function shellDialect(filePath: string): ResolvedDialect | undefined {
	const resolved = resolveShellFileDialect(filePath);
	if (resolved.directive !== null)
		return { dialect: resolved.dialect, source: "directive" };
	if (resolved.shebang !== null)
		return { dialect: resolved.dialect, source: "shebang" };
	const ext = extname(filePath).toLowerCase();
	if (SHELL_DIALECT_EXTENSIONS.has(ext))
		return { dialect: resolved.dialect, source: "extension" };
	// `.sh` with no shebang or directive: the resolver's bash default is
	// upstream's own answer for it, so it is stated as such.
	if (ext === ".sh") return { dialect: resolved.dialect, source: "default" };
	return undefined;
}

/**
 * Resolve a file's language key. Reads up to the dialect owner's sniff
 * budget (4 KB) for a shell file, and nothing otherwise.
 */
export function resolveLanguageKey(filePath: string): ResolvedLanguageKey {
	const resolved = resolveFileLanguage(filePath);
	if (resolved === undefined) return { language: undefined, candidates: [] };
	const { entry, source: languageSource } = resolved;
	const base = {
		language: entry.id,
		...(entry.kind === undefined ? {} : { kind: entry.kind }),
		languageSource,
	};
	if (entry.id !== SHELL_LANGUAGE_ID)
		return { ...base, candidates: [entry.id] };
	const dialect = shellDialect(filePath);
	if (dialect === undefined) return { ...base, candidates: [entry.id] };
	return {
		...base,
		dialect,
		candidates: DIALECT_KEYS.has(dialect.dialect)
			? [dialect.dialect, entry.id]
			: [entry.id],
	};
}
