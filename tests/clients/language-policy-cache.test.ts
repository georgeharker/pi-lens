/**
 * The resolved `languages` policy map (#195) cache in
 * `clients/language-policy-for-file.ts`: one resolution per config-owning
 * directory, revalidated on every read by the stat signature of every path
 * the resolution reads.
 *
 * Real config files on disk, the real resolver, and the real candidate list.
 * Each test proves the answer the cache gives equals a fresh resolution's,
 * and counts misses to prove a hit did not re-resolve.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	piLensConfigCandidates,
	resolvePiLensConfig,
} from "../../clients/config-resolve.js";
import {
	_languagePolicyCacheCountsForTests,
	_resetLanguagePolicyCacheForTests,
	languagePolicyForFilePath,
} from "../../clients/language-policy-for-file.js";
import { useLanguageConfigFixture } from "../support/language-config-fixture.js";

const fx = useLanguageConfigFixture("pi-lens-policy-cache-");


function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value));
}

/** Rewrite a file and move its mtime forward, so the change is visible. */
function rewrite(file: string, value: unknown, bumpMs: number): void {
	writeJson(file, value);
	const at = new Date(Date.now() + bumpMs);
	fs.utimesSync(file, at, at);
}

function serverFor(file: string): string | undefined {
	return languagePolicyForFilePath(file)?.match.policy.lsp?.server;
}

describe("language policy cache", () => {
	it("serves a second read from the cache without re-resolving", () => {
		writeJson(path.join(fx.projectDir, ".pi-lens.json"), {
			languages: { python: { lsp: { server: "python-jedi" } } },
		});
		const file = path.join(fx.projectDir, "a.py");
		fs.writeFileSync(file, "x = 1\n");
		expect(serverFor(file)).toBe("python-jedi");
		expect(serverFor(file)).toBe("python-jedi");
		expect(_languagePolicyCacheCountsForTests()).toEqual({
			hits: 1,
			misses: 1,
		});
	});

	it("re-resolves when a config file is edited", () => {
		const config = path.join(fx.projectDir, ".pi-lens.json");
		writeJson(config, {
			languages: { python: { lsp: { server: "python-jedi" } } },
		});
		const file = path.join(fx.projectDir, "a.py");
		fs.writeFileSync(file, "x = 1\n");
		expect(serverFor(file)).toBe("python-jedi");
		rewrite(
			config,
			{ languages: { python: { lsp: { server: "python" } } } },
			5000,
		);
		expect(serverFor(file)).toBe("python");
		expect(_languagePolicyCacheCountsForTests().misses).toBe(2);
	});

	it("re-resolves when an edit keeps the file's size, by its mtime", () => {
		const config = path.join(fx.projectDir, ".pi-lens.json");
		writeJson(config, { languages: { python: { lsp: { server: "aaaa" } } } });
		const file = path.join(fx.projectDir, "a.py");
		fs.writeFileSync(file, "x = 1\n");
		expect(serverFor(file)).toBe("aaaa");
		const size = fs.statSync(config).size;
		rewrite(
			config,
			{ languages: { python: { lsp: { server: "bbbb" } } } },
			5000,
		);
		expect(fs.statSync(config).size).toBe(size);
		expect(serverFor(file)).toBe("bbbb");
	});

	it("re-resolves when a nearer config file appears, and again when it goes", () => {
		writeJson(path.join(fx.projectDir, ".pi-lens.json"), {
			languages: { python: { lsp: { server: "python-jedi" } } },
		});
		const sub = path.join(fx.projectDir, "pkg");
		const file = path.join(sub, "a.py");
		fs.mkdirSync(sub, { recursive: true });
		fs.writeFileSync(file, "x = 1\n");
		expect(serverFor(file)).toBe("python-jedi");
		const nested = path.join(sub, ".pi-lens.json");
		writeJson(nested, { languages: { python: { lsp: { server: "python" } } } });
		expect(serverFor(file)).toBe("python");
		fs.rmSync(nested);
		expect(serverFor(file)).toBe("python-jedi");
		expect(_languagePolicyCacheCountsForTests().misses).toBe(3);
	});

	it("re-resolves when the global config changes", () => {
		const global = path.join(fx.globalDir, "config.json");
		writeJson(global, {
			languages: { python: { lsp: { server: "python-jedi" } } },
		});
		const file = path.join(fx.projectDir, "a.py");
		fs.writeFileSync(file, "x = 1\n");
		expect(serverFor(file)).toBe("python-jedi");
		rewrite(
			global,
			{ languages: { python: { lsp: { server: "python" } } } },
			5000,
		);
		expect(serverFor(file)).toBe("python");
	});

	it("reads every path the resolver reads", () => {
		writeJson(path.join(fx.globalDir, "config.json"), { languages: {} });
		writeJson(path.join(fx.projectDir, ".pi-lens.json"), { languages: {} });
		const sub = path.join(fx.projectDir, "pkg");
		writeJson(path.join(sub, ".pi-lens.json"), { languages: {} });
		const options = {
			cwd: sub,
			globalDir: fx.globalDir,
			globalConfigPath: path.join(fx.globalDir, "config.json"),
			homeDir: fx.home,
		};
		const candidates = new Set(
			piLensConfigCandidates(options).map((candidate) => candidate.file),
		);
		const documents = resolvePiLensConfig(options).documents;
		expect(documents.length).toBe(3);
		for (const document of documents)
			expect(candidates.has(document.file)).toBe(true);
	});

	it("drops every entry on reset", () => {
		writeJson(path.join(fx.projectDir, ".pi-lens.json"), {
			languages: { python: { lsp: { server: "python-jedi" } } },
		});
		const file = path.join(fx.projectDir, "a.py");
		fs.writeFileSync(file, "x = 1\n");
		serverFor(file);
		_resetLanguagePolicyCacheForTests();
		serverFor(file);
		expect(_languagePolicyCacheCountsForTests()).toEqual({
			hits: 0,
			misses: 1,
		});
	});
});
