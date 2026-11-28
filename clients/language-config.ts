/**
 * `languages`: the opt-in, per-language tool policy (#195). Docs:
 * `docs/languages.md`.
 *
 * NO DEFAULT CHANGE. A file no entry governs, and any domain or field an
 * entry leaves out, takes the default path. Every accessor below answers
 * `undefined` for "not configured".
 *
 * MATCHING. `files` patterns first, then the file's language key, most
 * specific first (`zsh`, then `shell`; `clients/language-key.ts`). Unknown
 * keys drop with `PILENS_CFG_0005`. `files` is our addition to #195: paths
 * like `.zshrc` that no registry rule can place.
 *
 * MERGE. Field by field (#195); lists take the core's `replace`.
 *
 * TRUST. Policies name existing ids only, so a project may set them
 * untrusted. Each domain's consumer validates its own ids: this module
 * cannot import their registries without a `no-client-cycles` cycle.
 */

import { basename } from "node:path";
import type { PiLensConfigResolution } from "./config-resolve.js";
import {
	boundedKeyLabel,
	type MigrationRecord,
	migrationSubject,
} from "./config-core/records.js";
import type { Provenance } from "./config-core/provenance.js";
import { minimatch } from "./deps/minimatch.js";
import {
	type ParsedLanguageKey,
	parseLanguageKey,
	resolveFileLanguage,
	type ResolvedLanguageKey,
	resolveLanguageKey,
} from "./language-key.js";

/** The top-level config key (#195). */
export const LANGUAGES_NAMESPACE_KEY = "languages";

/** The domains a policy configures, in the order a view renders them. */
export const LANGUAGE_DOMAINS = ["lsp", "lint", "format", "autofix"] as const;
export type LanguageDomain = (typeof LANGUAGE_DOMAINS)[number];

/** `languages.<id>.lsp`: the language's primary server. */
export interface LspPolicy {
	/** `false` = no language server for the language's files. */
	readonly enabled?: boolean;
	/** The one primary language server, by id. */
	readonly server?: string;
	/**
	 * Set by the LSP registry compiler when `server` names no registered
	 * language server. The policy then attaches none, never a fallback.
	 */
	readonly unusable?: true;
}

/**
 * How several `lint.tools` run (#195): `all` runs every available listed
 * linter; `fallback` runs the first listed linter that is available.
 */
export type LintMode = "all" | "fallback";

/** `languages.<id>.lint`: the language's linters. */
export interface LintPolicy {
	/** `false` = no linters for the language's files. */
	readonly enabled?: boolean;
	/** The linters, by dispatch runner id, in order of preference. */
	readonly tools?: readonly string[];
	readonly mode?: LintMode;
}

/** `languages.<id>.format`: the language's formatter. */
export interface FormatPolicy {
	/** `false` = no formatting for the language's files. */
	readonly enabled?: boolean;
	/** The one formatter, by name. */
	readonly formatter?: string;
}

/** `languages.<id>.autofix`: the language's safe fixers. */
export interface AutofixPolicy {
	/**
	 * `false` = no autofix for the language's files. `true` cannot turn on
	 * autofix the global `autofix.enabled` or `--no-autofix` turned off: that
	 * gate runs before any policy is read (narrow only).
	 */
	readonly enabled?: boolean;
	/** The fixers, by autofix tool name, in the order they run. */
	readonly tools?: readonly string[];
}

/** One language key's declared policy. An absent field = the default path. */
export interface LanguagePolicy {
	readonly key: string;
	readonly parsed: ParsedLanguageKey;
	readonly files?: readonly string[];
	readonly lsp?: LspPolicy;
	readonly lint?: LintPolicy;
	readonly format?: FormatPolicy;
	readonly autofix?: AutofixPolicy;
}

/** A resolution's validated language policies. */
export interface LanguageConfig {
	/** Entries in config order (the order `files` patterns are tried in). */
	readonly entries: ReadonlyMap<string, LanguagePolicy>;
}

/** How a file reached the policy that governs it. */
export type LanguageMatch = "files" | "language";

/** The policy governing one file, and how it was reached. */
export interface FileLanguagePolicy {
	readonly policy: LanguagePolicy;
	readonly via: LanguageMatch;
	/**
	 * The file's resolved language key, when one was needed to decide. A
	 * `files` match decides without it.
	 */
	readonly language?: ResolvedLanguageKey;
}

/** The policies of one resolution, plus records for what was dropped. */
export interface LanguageConfigResolution {
	/** Undefined when nothing is declared: the hot path for most projects. */
	readonly config: LanguageConfig | undefined;
	readonly records: readonly MigrationRecord[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** The JSON pointer of a policy field (`~` and `/` escaped, RFC 6901). */
export function languagePointer(key: string, ...fields: string[]): string {
	const escaped = key.replaceAll("~", "~0").replaceAll("/", "~1");
	return [`/${LANGUAGES_NAMESPACE_KEY}/${escaped}`, ...fields].join("/");
}

function recordFor(
	resolution: PiLensConfigResolution,
	pointer: string,
	reason: string,
): MigrationRecord {
	const decidedBy: Provenance | undefined = resolution.provenance.get(pointer);
	const file = decidedBy?.file ?? resolution.documents.at(-1)?.file ?? "";
	return {
		code: "PILENS_CFG_0005",
		file,
		key: pointer,
		subject: migrationSubject(file, pointer),
		reason,
		...(decidedBy?.tier ? { tier: decidedBy.tier } : {}),
	};
}

/** A de-duplicated string list in first-seen order, or undefined. */
function stringList(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const seen = new Set<string>();
	const out: string[] = [];
	for (const member of value) {
		if (typeof member !== "string" || seen.has(member)) continue;
		seen.add(member);
		out.push(member);
	}
	return out;
}

/**
 * One domain's fields: `enabled` (boolean), the named string fields, and
 * the named list fields. Undefined when the domain sets none, so an empty
 * domain stays on the default path.
 */
function domainOf(
	value: unknown,
	strings: readonly string[],
	lists: readonly string[] = [],
): Record<string, unknown> | undefined {
	const body = asRecord(value);
	if (!body) return undefined;
	const out: Record<string, unknown> = {};
	if (typeof body.enabled === "boolean") out.enabled = body.enabled;
	for (const key of strings)
		if (typeof body[key] === "string") out[key] = body[key];
	for (const key of lists) {
		const list = stringList(body[key]);
		if (list !== undefined) out[key] = list;
	}
	return Object.keys(out).length === 0 ? undefined : out;
}

function lintPolicyOf(value: unknown): LintPolicy | undefined {
	const lint = domainOf(value, ["mode"], ["tools"]);
	if (lint && lint.mode !== "all" && lint.mode !== "fallback") {
		delete lint.mode;
		if (Object.keys(lint).length === 0) return undefined;
	}
	return lint as LintPolicy | undefined;
}

/**
 * #195: "lint.mode is explicit when multiple tools are named". A policy that
 * names several tools without a mode gets one record and runs as `all`, the
 * reading that drops no linter the operator listed.
 */
function lintModeRecord(
	resolution: PiLensConfigResolution,
	key: string,
	lint: LintPolicy | undefined,
): MigrationRecord | undefined {
	if (!lint?.tools || lint.tools.length < 2 || lint.mode !== undefined)
		return undefined;
	return recordFor(
		resolution,
		languagePointer(key, "lint", "tools"),
		`languages.${boundedKeyLabel(key)}.lint names several tools without a ` +
			'mode; running them all (set mode to "all" or "fallback")',
	);
}

/**
 * The validated language policies of one resolution. Pure: reads the
 * resolution and writes nothing; the caller reports the records.
 */
export function languageConfigOf(
	resolution: PiLensConfigResolution,
): LanguageConfigResolution {
	const section = asRecord(resolution.value[LANGUAGES_NAMESPACE_KEY]);
	if (!section) return { config: undefined, records: [] };
	const entries = new Map<string, LanguagePolicy>();
	const records: MigrationRecord[] = [];
	for (const [key, raw] of Object.entries(section)) {
		const parsed = parseLanguageKey(key);
		if (!parsed) {
			records.push(
				recordFor(
					resolution,
					languagePointer(key),
					`languages key "${boundedKeyLabel(key)}" is not a known ` +
						"language id or shell dialect; dropped",
				),
			);
			continue;
		}
		const body = asRecord(raw);
		if (!body) continue;
		const files = stringList(body.files);
		const lsp = domainOf(body.lsp, ["server"]) as LspPolicy | undefined;
		const lint = lintPolicyOf(body.lint);
		const format = domainOf(body.format, ["formatter"]) as
			| FormatPolicy
			| undefined;
		const autofix = domainOf(body.autofix, [], ["tools"]) as
			| AutofixPolicy
			| undefined;
		const modeRecord = lintModeRecord(resolution, key, lint);
		if (modeRecord) records.push(modeRecord);
		entries.set(key, {
			key,
			parsed,
			...(files === undefined ? {} : { files }),
			...(lsp === undefined ? {} : { lsp }),
			...(lint === undefined ? {} : { lint }),
			...(format === undefined ? {} : { format }),
			...(autofix === undefined ? {} : { autofix }),
		});
	}
	return {
		config: entries.size === 0 ? undefined : { entries },
		records,
	};
}

const PATTERN_OPTIONS = { dot: true, nocomment: true, nonegate: true };

function normalizedPath(filePath: string): string {
	return filePath.replaceAll("\\", "/");
}

/** True when one `files` pattern matches the file (see module doc). */
export function languageFilePatternMatches(
	pattern: string,
	filePath: string,
): boolean {
	if (pattern.length === 0) return false;
	const file = normalizedPath(filePath);
	if (!pattern.includes("/"))
		return minimatch(basename(file), pattern, PATTERN_OPTIONS);
	const anchored = pattern.startsWith("/") ? pattern : `**/${pattern}`;
	return minimatch(file, anchored, PATTERN_OPTIONS);
}

/**
 * The policy that governs `filePath`, or undefined for the default path.
 * The dialect (a read of the file's head) is resolved only when some entry
 * names a dialect of the file's language.
 */
export function languagePolicyForFile(
	config: LanguageConfig | undefined,
	filePath: string,
): FileLanguagePolicy | undefined {
	if (!config) return undefined;
	for (const policy of config.entries.values()) {
		if (
			policy.files?.some((pattern) =>
				languageFilePatternMatches(pattern, filePath),
			)
		)
			return { policy, via: "files" };
	}
	const resolved = resolveFileLanguage(filePath);
	if (resolved === undefined) return undefined;
	const id = resolved.entry.id;
	const wantsDialect = [...config.entries.values()].some(
		(policy) =>
			policy.parsed.language === id && policy.parsed.dialect !== undefined,
	);
	if (!wantsDialect) {
		const policy = config.entries.get(id);
		return policy
			? {
					policy,
					via: "language",
					language: {
						language: id,
						...(resolved.entry.kind === undefined
							? {}
							: { kind: resolved.entry.kind }),
						languageSource: resolved.source,
						candidates: [id],
					},
				}
			: undefined;
	}
	const language = resolveLanguageKey(filePath);
	for (const candidate of language.candidates) {
		const policy = config.entries.get(candidate);
		if (policy) return { policy, via: "language", language };
	}
	return undefined;
}

/**
 * The `lsp` choice for `filePath`: `[server]`, `[]` for `enabled: false`
 * (which wins over a merged-in `server`), or undefined for the default path.
 * An unusable server needs no branch: it matches no registered server, so
 * none attaches.
 */
export function configuredLspServers(
	config: LanguageConfig | undefined,
	filePath: string,
):
	| { readonly ids: readonly string[]; readonly match: FileLanguagePolicy }
	| undefined {
	const match = languagePolicyForFile(config, filePath);
	const lsp = match?.policy.lsp;
	if (!match || !lsp) return undefined;
	if (lsp.enabled === false) return { ids: [], match };
	if (lsp.server !== undefined) return { ids: [lsp.server], match };
	return undefined;
}

/** The linters a `lint` policy chooses, and how they run. */
export interface ConfiguredLint {
	readonly tools: readonly string[];
	readonly mode: LintMode;
}

/**
 * The `lint` choice: `tools` and `mode` (default `all`), `[]` for
 * `enabled: false`, or undefined for the default path.
 */
export function configuredLintOf(
	policy: LanguagePolicy | undefined,
): ConfiguredLint | undefined {
	const lint = policy?.lint;
	if (!lint) return undefined;
	if (lint.enabled === false) return { tools: [], mode: lint.mode ?? "all" };
	if (lint.tools !== undefined)
		return { tools: lint.tools, mode: lint.mode ?? "all" };
	return undefined;
}

/**
 * The `format` choice: the formatter, `null` for `enabled: false`, or
 * undefined for the default path.
 */
export function configuredFormatterOf(
	policy: LanguagePolicy | undefined,
): string | null | undefined {
	const format = policy?.format;
	if (!format) return undefined;
	if (format.enabled === false) return null;
	return format.formatter;
}

/**
 * The autofix choice, before `getAutofixPolicyForFile` maps and validates
 * the names: the policy's own `autofix.tools`, else its `lint.tools` (so
 * choosing oxlint never leaves `eslint --fix` running), `[]` for
 * `autofix.enabled: false`, or undefined for the default path.
 */
export function configuredAutofixOf(
	policy: LanguagePolicy | undefined,
):
	| { readonly from: "autofix" | "lint"; readonly tools: readonly string[] }
	| undefined {
	const autofix = policy?.autofix;
	if (autofix?.enabled === false) return { from: "autofix", tools: [] };
	if (autofix?.tools !== undefined)
		return { from: "autofix", tools: autofix.tools };
	const lint = configuredLintOf(policy);
	if (lint !== undefined) return { from: "lint", tools: lint.tools };
	return undefined;
}
