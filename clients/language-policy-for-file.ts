/**
 * The `languages.<id>` policy (#195) for a seam with no dispatch context:
 * the formatter and autofix seams. They cannot import dispatch's resolver
 * (`rule-policy -> dispatch types -> dispatcher -> widget-state ->
 * formatters` is a cycle), so this resolves from the file's directory,
 * which layers the same config chain.
 *
 * CACHED: #195's `ResolvedLanguagePolicyMap`, one per config-owning
 * directory, revalidated on every read by the stat signature (path, mtime,
 * size) of every path the resolver reads (`piLensConfigCandidates`). An
 * edited, created, or removed config file is a miss, whoever wrote it. A hit
 * is one `stat` per candidate. An edit that keeps both mtime and size is
 * not seen.
 */

import * as fs from "node:fs";
import { dirname, resolve } from "node:path";
import { BoundedLruCache } from "./bounded-cache.js";
import {
	getPiLensGlobalConfigPath,
	holdsCanonicalProjectConfig,
} from "./config-locations.js";
import {
	type PiLensConfigResolution,
	piLensConfigCandidates,
	type ResolvePiLensConfigOptions,
	resolvePiLensConfig,
} from "./config-resolve.js";
import { getGlobalPiLensDir } from "./file-utils.js";
import {
	type FileLanguagePolicy,
	type LanguageConfig,
	languageConfigOf,
	languagePolicyForFile,
} from "./language-config.js";

/** One cached resolution and the signature it was read under. */
interface CachedLanguageConfig {
	readonly signature: string;
	readonly resolution: PiLensConfigResolution;
	readonly config: LanguageConfig | undefined;
}

/** Config-owning directories held at once; a session touches few. */
const LANGUAGE_CONFIG_CACHE_ENTRIES = 64;

const languageConfigCache = new BoundedLruCache<string, CachedLanguageConfig>(
	LANGUAGE_CONFIG_CACHE_ENTRIES,
);

/** Hits and misses since the last reset, for tests and latency probes. */
const cacheCounters = { hits: 0, misses: 0 };

/** The resolver options for `filePath`'s directory. */
function optionsForFile(filePath: string): ResolvePiLensConfigOptions {
	const dir = dirname(resolve(filePath));
	return {
		cwd: dir,
		globalDir: getGlobalPiLensDir(),
		globalConfigPath: getPiLensGlobalConfigPath(),
		excludeLegacyProjectDocuments: holdsCanonicalProjectConfig(dir),
	};
}

/**
 * Every input that shapes the resolution's candidate list, so two calls that
 * would read different paths never share an entry.
 */
function cacheKey(options: ResolvePiLensConfigOptions): string {
	return JSON.stringify([
		options.cwd,
		options.globalDir ?? null,
		options.globalConfigPath ?? null,
		options.excludeLegacyProjectDocuments === true,
	]);
}

/**
 * Each PRESENT candidate's path, mtime and size. An absent candidate adds
 * nothing, which is enough: a file that appears adds its row, and one that
 * vanishes removes it, so either changes the signature.
 */
function statSignature(options: ResolvePiLensConfigOptions): string {
	const parts: string[] = [];
	for (const { file } of piLensConfigCandidates(options)) {
		const stat = fs.statSync(file, { throwIfNoEntry: false });
		if (stat) parts.push(`${file}\0${stat.mtimeMs}\0${stat.size}`);
	}
	return parts.join("\n");
}

/** The cached (or freshly resolved) policy map for `filePath`'s directory. */
function cachedLanguageConfig(filePath: string): CachedLanguageConfig {
	const options = optionsForFile(filePath);
	const key = cacheKey(options);
	const signature = statSignature(options);
	const cached = languageConfigCache.get(key);
	if (cached && cached.signature === signature) {
		cacheCounters.hits += 1;
		return cached;
	}
	cacheCounters.misses += 1;
	const resolution = resolvePiLensConfig(options);
	const entry: CachedLanguageConfig = {
		signature,
		resolution,
		config: languageConfigOf(resolution).config,
	};
	languageConfigCache.set(key, entry);
	return entry;
}

/** The resolution `languages` is read from for `filePath`. */
export function resolveLanguageConfigForFile(
	filePath: string,
): PiLensConfigResolution {
	return cachedLanguageConfig(filePath).resolution;
}

/** A governing policy, with the resolution a consumer reports against. */
export interface FilePolicyResolution {
	readonly match: FileLanguagePolicy;
	readonly resolution: PiLensConfigResolution;
}

/**
 * The policy governing `filePath`, or undefined for the default path.
 * Records for malformed keys are the LSP loader's to report (it reads the
 * same resolution shape at session start); a consumer reports its own
 * fields.
 */
export function languagePolicyForFilePath(
	filePath: string,
): FilePolicyResolution | undefined {
	const { resolution, config } = cachedLanguageConfig(filePath);
	const match = languagePolicyForFile(config, filePath);
	return match ? { match, resolution } : undefined;
}

/** Test seam: the cache's hit and miss counts since the last reset. */
export function _languagePolicyCacheCountsForTests(): {
	hits: number;
	misses: number;
} {
	return { ...cacheCounters };
}

/**
 * Test seam: drop every cached resolution and zero the counters. A session
 * boundary needs no reset: every read revalidates by stat signature, so the
 * cache cannot hold an answer the disk no longer gives.
 */
export function _resetLanguagePolicyCacheForTests(): void {
	languageConfigCache.clear();
	cacheCounters.hits = 0;
	cacheCounters.misses = 0;
}
