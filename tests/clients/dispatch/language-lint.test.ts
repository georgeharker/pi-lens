/**
 * `languages.<id>.lint` and `languages.<id>.format` (#195): the dispatch and
 * formatter halves of the per-language tool policy.
 *
 * Production path: real config files on disk (global via `PI_LENS_HOME`,
 * project via `.pi-lens.json`), the real `resolvePiLensConfig`, the real
 * `createDispatchContext` and `dispatchForFile`, the real lint policy owners,
 * the real covers seam, and the real `getFormattersForFile`. Only the dispatch
 * runners are stand-ins (they count their own `when`/`run` calls), with a
 * policy-free control arm proving the counters see a run.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePiLensConfig } from "../../../clients/config-resolve.js";
import { resetDegradationLedger } from "../../../clients/degradation-ledger.js";
import {
	createDispatchContext,
	dispatchForFile,
	RunnerRegistry,
} from "../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import {
	registerRunnerId,
	resetRunnerIdentityForTests,
} from "../../../clients/dispatch/known-runner-ids.js";
import {
	configuredLintForFile,
	NOT_CONFIGURED_FOR_LANGUAGE_SKIP_REASON,
	orderLintFallback,
} from "../../../clients/dispatch/language-lint.js";
import { lspPrimaryCoversFile } from "../../../clients/dispatch/runners/utils/runner-helpers.js";
import type {
	DispatchContext,
	RunnerDefinition,
	RunnerGroup,
	RunnerResult,
} from "../../../clients/dispatch/types.js";
import {
	effectiveConfig,
	type EffectiveConfigView,
	type EffectiveFileView,
} from "../../../clients/effective-config.js";
import { getFormattersForFile } from "../../../clients/formatters.js";
import {
	getJstsLintPolicyForCwd,
	getLinterPolicyForCwd,
} from "../../../clients/tool-policy.js";
import { useLanguageConfigFixture } from "../../support/language-config-fixture.js";

const fx = useLanguageConfigFixture("pi-lens-language-lint-");

interface Counters {
	whenCalls: number;
	runCalls: number;
}

const SUCCEEDED: RunnerResult = {
	status: "succeeded",
	diagnostics: [],
	semantic: "none",
};
const NOT_INSTALLED: RunnerResult = {
	status: "skipped",
	diagnostics: [],
	semantic: "none",
	skipReason: "not-installed",
};
/** A run that completed and whose own findings failed the check. */
const FINDINGS: RunnerResult = {
	status: "failed",
	failureKind: "blocking_diagnostics",
	semantic: "blocking",
	diagnostics: [
		{
			id: "no-x",
			message: "x",
			filePath: "a.ts",
			severity: "error",
			semantic: "blocking",
			tool: "oxlint",
			rule: "no-x",
			line: 1,
		},
	],
};
/** A run that broke (no findings kind): not an answer. */
const BROKE: RunnerResult = {
	status: "failed",
	diagnostics: [],
	semantic: "none",
};

function countingRunner(
	id: string,
	result: RunnerResult,
): { runner: RunnerDefinition; counters: Counters } {
	const counters: Counters = { whenCalls: 0, runCalls: 0 };
	return {
		counters,
		runner: {
			id,
			appliesTo: ["jsts"],
			priority: 10,
			when() {
				counters.whenCalls += 1;
				return true;
			},
			async run() {
				counters.runCalls += 1;
				return result;
			},
		},
	};
}

const { writeGlobal, writeProject, writeFile } = fx;

function resolutionAt(dir: string) {
	return resolvePiLensConfig({
		cwd: dir,
		globalDir: fx.globalDir,
		globalConfigPath: path.join(fx.globalDir, "config.json"),
		homeDir: fx.home,
	});
}

function contextFor(file = "a.ts", facts = new FactStore()) {
	return createDispatchContext(
		path.join(fx.projectDir, file),
		fx.projectDir,
		{ getFlag: () => false },
		facts,
		false,
	);
}

/** The JS/TS lint fallback group the capability matrix plans for jsts. */
const JSTS_LINT_GROUP: RunnerGroup[] = [
	{ mode: "all", runnerIds: ["tree-sitter"] },
	{ mode: "fallback", runnerIds: ["eslint", "oxlint", "biome-check-json"] },
];

/** Two linters in two parallel groups (the shape `ruff-lint` and `mypy` have). */
const SPLIT_LINT_GROUPS: RunnerGroup[] = [
	{ mode: "all", runnerIds: ["tree-sitter"] },
	{ mode: "fallback", runnerIds: ["eslint"] },
	{ mode: "fallback", runnerIds: ["oxlint"] },
];

function jstsRegistry(results: Record<string, RunnerResult> = {}) {
	const registry = new RunnerRegistry();
	const counters = new Map<string, Counters>();
	for (const id of ["tree-sitter", "eslint", "oxlint", "biome-check-json"]) {
		const { runner, counters: c } = countingRunner(
			id,
			results[id] ?? SUCCEEDED,
		);
		registry.register(runner);
		counters.set(id, c);
	}
	const runs = (id: string): number => counters.get(id)?.runCalls ?? -1;
	const whens = (id: string): number => counters.get(id)?.whenCalls ?? -1;
	return { registry, runs, whens };
}

beforeEach(() => {
	resetDegradationLedger();
	resetRunnerIdentityForTests();
	for (const id of [
		"tree-sitter",
		"eslint",
		"oxlint",
		"biome-check-json",
		"ruff-lint",
		"shellcheck",
	])
		registerRunnerId(id);
});

afterEach(() => {
	resetRunnerIdentityForTests();
});

describe("languages.<id>.lint — resolution", () => {
	it("is undefined on the default path: no policy, or a policy without lint tools", () => {
		writeProject({ languages: { typescript: { format: { enabled: false } } } });
		const ts = writeFile("a.ts", "export {};\n");
		expect(configuredLintForFile(resolutionAt(fx.projectDir), ts).lint).toBe(
			undefined,
		);
		writeProject({ languages: { typescript: { lint: { mode: "fallback" } } } });
		expect(
			configuredLintForFile(resolutionAt(fx.projectDir), ts).lint,
		).toBeUndefined();
	});

	it("keys by the registry language: typescript does not cover javascript", () => {
		writeProject({
			languages: { typescript: { lint: { tools: ["oxlint"] } } },
		});
		const js = writeFile("a.js", "1;\n");
		expect(
			configuredLintForFile(resolutionAt(fx.projectDir), js).lint,
		).toBeUndefined();
	});

	it("drops an unregistered id and a non-linter runner, keeping order", () => {
		writeProject({
			languages: {
				typescript: {
					lint: {
						tools: ["oxlnt", "oxlint", "tree-sitter", "eslint"],
						mode: "all",
					},
				},
			},
		});
		const file = writeFile("a.ts", "export {};\n");
		const resolved = configuredLintForFile(resolutionAt(fx.projectDir), file);
		expect(resolved.lint).toEqual({ tools: ["oxlint", "eslint"], mode: "all" });
		expect(resolved.records.map((record) => record.key)).toEqual([
			"/languages/typescript/lint/tools/0",
			"/languages/typescript/lint/tools/2",
		]);
		expect(resolved.records[0]?.reason).toContain("not a registered");
		expect(resolved.records[1]?.reason).toContain("not a selectable linter");
		expect(resolved.records.some((r) => r.reason.includes("oxlnt"))).toBe(
			false,
		);
	});

	it("reads enabled: false as no linters, even over tools from another tier", () => {
		writeGlobal({
			languages: { typescript: { lint: { tools: ["eslint"] } } },
		});
		writeProject({ languages: { typescript: { lint: { enabled: false } } } });
		const file = writeFile("a.ts", "export {};\n");
		expect(configuredLintForFile(resolutionAt(fx.projectDir), file).lint).toEqual({
			tools: [],
			mode: "all",
		});
	});

	it("merges field by field: a project mode with global tools", () => {
		writeGlobal({
			languages: { typescript: { lint: { tools: ["eslint", "oxlint"] } } },
		});
		writeProject({
			languages: { typescript: { lint: { mode: "fallback" } } },
		});
		const file = writeFile("a.ts", "export {};\n");
		expect(configuredLintForFile(resolutionAt(fx.projectDir), file).lint).toEqual({
			tools: ["eslint", "oxlint"],
			mode: "fallback",
		});
	});
});

describe("languages.<id>.lint — dispatch", () => {
	it("control: with no policy the fallback lint group stops at its first success", async () => {
		writeFile("a.ts", "export {};\n");
		const { registry, runs } = jstsRegistry();
		await dispatchForFile(contextFor(), JSTS_LINT_GROUP, registry);
		expect(runs("tree-sitter")).toBe(1);
		expect(runs("eslint")).toBe(1);
		expect(runs("oxlint")).toBe(0);
		expect(runs("biome-check-json")).toBe(0);
	});

	it("mode all: runs every listed linter and never starts the rest", async () => {
		writeProject({
			languages: {
				typescript: {
					lint: { tools: ["oxlint", "biome-check-json"], mode: "all" },
				},
			},
		});
		writeFile("a.ts", "export {};\n");
		const { registry, runs, whens } = jstsRegistry();
		const result = await dispatchForFile(
			contextFor(),
			JSTS_LINT_GROUP,
			registry,
		);
		expect(runs("tree-sitter")).toBe(1);
		expect(whens("eslint")).toBe(0);
		expect(runs("eslint")).toBe(0);
		expect(runs("oxlint")).toBe(1);
		expect(runs("biome-check-json")).toBe(1);
		expect(
			result.latencyReport?.runners.find((r) => r.runnerId === "eslint"),
		).toMatchObject({
			status: "skipped",
			skipReason: NOT_CONFIGURED_FOR_LANGUAGE_SKIP_REASON,
		});
		expect(result.inconclusiveSources?.runnerIds ?? []).not.toContain("eslint");
	});

	it("mode fallback: runs the first listed linter, in the listed order, across groups", async () => {
		writeProject({
			languages: {
				typescript: { lint: { tools: ["oxlint", "eslint"], mode: "fallback" } },
			},
		});
		writeFile("a.ts", "export {};\n");
		const { registry, runs } = jstsRegistry();
		await dispatchForFile(contextFor(), SPLIT_LINT_GROUPS, registry);
		// The plan has eslint and oxlint in separate parallel groups: without
		// the reordering both would run.
		expect(runs("oxlint")).toBe(1);
		expect(runs("eslint")).toBe(0);
		expect(runs("tree-sitter")).toBe(1);
	});

	it("mode fallback: moves on when the first listed linter is not installed", async () => {
		writeProject({
			languages: {
				typescript: { lint: { tools: ["oxlint", "eslint"], mode: "fallback" } },
			},
		});
		writeFile("a.ts", "export {};\n");
		const { registry, runs } = jstsRegistry({ oxlint: NOT_INSTALLED });
		await dispatchForFile(contextFor(), SPLIT_LINT_GROUPS, registry);
		expect(runs("oxlint")).toBe(1);
		expect(runs("eslint")).toBe(1);
	});

	it("mode fallback: stops at a listed linter that answered with findings, and moves past one that broke", async () => {
		writeProject({
			languages: {
				typescript: { lint: { tools: ["oxlint", "eslint"], mode: "fallback" } },
			},
		});
		writeFile("a.ts", "export {};\n");
		const found = jstsRegistry({ oxlint: FINDINGS });
		await dispatchForFile(contextFor(), SPLIT_LINT_GROUPS, found.registry);
		expect(found.runs("oxlint")).toBe(1);
		expect(found.runs("eslint")).toBe(0);
		const broke = jstsRegistry({ oxlint: BROKE });
		await dispatchForFile(contextFor(), SPLIT_LINT_GROUPS, broke.registry);
		expect(broke.runs("eslint")).toBe(1);
	});

	it("control: the plan's own fallback group keeps going past findings", async () => {
		writeFile("a.ts", "export {};\n");
		const { registry, runs } = jstsRegistry({ eslint: FINDINGS });
		await dispatchForFile(contextFor(), JSTS_LINT_GROUP, registry);
		expect(runs("eslint")).toBe(1);
		expect(runs("oxlint")).toBe(1);
	});

	it("runs no linter for enabled: false", async () => {
		writeProject({ languages: { typescript: { lint: { enabled: false } } } });
		writeFile("a.ts", "export {};\n");
		const { registry, runs } = jstsRegistry();
		await dispatchForFile(contextFor(), JSTS_LINT_GROUP, registry);
		expect(runs("tree-sitter")).toBe(1);
		for (const id of ["eslint", "oxlint", "biome-check-json"])
			expect(runs(id)).toBe(0);
	});

	it("keeps a disabled runner off even when the policy lists it", async () => {
		writeProject({
			dispatch: { disabledRunners: ["oxlint"] },
			languages: {
				typescript: { lint: { tools: ["oxlint", "eslint"], mode: "all" } },
			},
		});
		writeFile("a.ts", "export {};\n");
		const { registry, runs } = jstsRegistry();
		const result = await dispatchForFile(
			contextFor(),
			JSTS_LINT_GROUP,
			registry,
		);
		expect(runs("oxlint")).toBe(0);
		expect(runs("eslint")).toBe(1);
		expect(
			result.latencyReport?.runners.find((r) => r.runnerId === "oxlint")
				?.skipReason,
		).toBe("disabled-by-config");
	});
});

describe("orderLintFallback", () => {
	it("is the plan unchanged without a fallback policy", () => {
		expect(orderLintFallback(SPLIT_LINT_GROUPS, undefined)).toEqual(
			SPLIT_LINT_GROUPS,
		);
		expect(
			orderLintFallback(SPLIT_LINT_GROUPS, {
				tools: ["oxlint", "eslint"],
				mode: "all",
			}),
		).toEqual(SPLIT_LINT_GROUPS);
	});

	it("moves listed linters into one group in the listed order, dropping emptied groups", () => {
		expect(
			orderLintFallback(SPLIT_LINT_GROUPS, {
				tools: ["oxlint", "eslint", "mypy"],
				mode: "fallback",
			}),
		).toEqual([
			{ mode: "all", runnerIds: ["tree-sitter"] },
			{ mode: "fallback", runnerIds: ["oxlint", "eslint"] },
		]);
	});

	it("leaves a linter in place when its group states a semantic", () => {
		const groups: RunnerGroup[] = [
			{ mode: "fallback", runnerIds: ["eslint"], semantic: "blocking" },
			{ mode: "fallback", runnerIds: ["oxlint"] },
		];
		expect(
			orderLintFallback(groups, {
				tools: ["eslint", "oxlint"],
				mode: "fallback",
			}),
		).toEqual([
			{ mode: "fallback", runnerIds: ["eslint"], semantic: "blocking" },
			{ mode: "fallback", runnerIds: ["oxlint"] },
		]);
	});
});

describe("languages.<id>.lint — the preference owners", () => {
	it("replaces config-detected JS/TS preference with the list", () => {
		// No tool config at all: eslint is config-first, so the default path
		// never prefers it here.
		expect(getJstsLintPolicyForCwd(fx.projectDir).preferredRunners).not.toContain(
			"eslint",
		);
		const policy = getJstsLintPolicyForCwd(fx.projectDir, ["oxlint", "eslint"]);
		expect(policy.preferredRunners).toEqual(["oxlint", "eslint"]);
		expect(policy.hasExplicitNonBiomeLinter).toBe(true);
		expect(
			getJstsLintPolicyForCwd(fx.projectDir, ["biome-check-json"])
				.hasExplicitNonBiomeLinter,
		).toBe(false);
	});

	it("replaces a language policy's preference with the listed tools among its runners", () => {
		const file = writeFile("a.py", "x = 1\n");
		expect(getLinterPolicyForCwd(file, fx.projectDir)?.runnerNames).toContain(
			"ruff-lint",
		);
		expect(
			getLinterPolicyForCwd(file, fx.projectDir, [])?.preferredRunners,
		).toEqual([]);
		expect(
			getLinterPolicyForCwd(file, fx.projectDir, ["eslint", "ruff-lint"])
				?.preferredRunners,
		).toEqual(["ruff-lint"]);
	});
});

describe("languages.<id>.lint — a listed linter beats covers", () => {
	it.each([
		["control: no policy, so shuck covers shellcheck", undefined, "shuck"],
		["a listed linter is not covered", ["shellcheck"], undefined],
		["an unlisted linter keeps the default covers answer", ["shfmt"], "shuck"],
	])("%s", (_, tools, serverId) => {
		const ctx = {
			filePath: writeFile("a.zsh", "echo\n"),
			pi: { getFlag: () => false },
			...(tools === undefined ? {} : { configuredLint: { tools, mode: "all" } }),
		} as unknown as DispatchContext;
		expect(lspPrimaryCoversFile(ctx, "shellcheck")?.serverId).toBe(serverId);
	});
});

describe("languages.<id>.format", () => {
	const names = async (file: string) =>
		(await getFormattersForFile(file, fx.projectDir)).map((f) => f.name);

	it("leaves a file the policy does not govern on the default path", async () => {
		const control = path.join(fx.home, "control");
		fs.mkdirSync(control, { recursive: true });
		fs.writeFileSync(path.join(control, "x.zsh"), "echo\n");
		writeProject({ languages: { python: { format: { formatter: "ruff" } } } });
		const ours = await names(writeFile("x.zsh", "echo\n"));
		const theirs = (
			await getFormattersForFile(path.join(control, "x.zsh"), control)
		).map((f) => f.name);
		expect(ours).toEqual(theirs);
	});

	// shfmt claims `.sh`/`.bash` only, so by default `.zsh` and `.zshrc` get none.
	it.each([
		["by dialect, whatever its extension list", {}, "x.zsh", "echo\n"],
		["for a `files`-pattern file", { files: [".zshrc"] }, ".zshrc", "setopt x\n"],
	])("applies the named formatter %s", async (_, extra, name, content) => {
		writeProject({
			languages: { zsh: { ...extra, format: { formatter: "shfmt" } } },
		});
		expect(await names(writeFile(name, content))).toEqual(["shfmt"]);
	});

	it.each([
		["an unknown name", undefined, { formatter: "ruf" }],
		["enabled: false over another tier's formatter", { formatter: "ruff" }, { enabled: false }],
	])("formats nothing for %s", async (_, global, project) => {
		if (global) writeGlobal({ languages: { python: { format: global } } });
		writeProject({ languages: { python: { format: project } } });
		expect(await names(writeFile("x.py", "x=1\n"))).toEqual([]);
		if ("formatter" in project) {
			const notice = fx.notified.find((m) =>
				m.includes("languages.python.format.formatter"),
			);
			expect(notice).toContain("[PILENS_CFG_0005]");
			expect(notice).not.toContain('"ruf"');
		}
	});

	it("never serves a governed file's answer to an ungoverned one through the cache", async () => {
		writeProject({ languages: { zsh: { format: { formatter: "shfmt" } } } });
		expect(await names(writeFile("x.zsh", "echo\n"))).toEqual(["shfmt"]);
		// Same cwd and extension, but bash by directive: the default path.
		expect(
			await names(writeFile("y.zsh", "# shellcheck shell=bash\necho\n")),
		).toEqual([]);
	});
});

describe("languages.<id>.lint — effective_config", () => {
	it("names an unlisted linter not-configured-for-language, with the lint domain's provenance", async () => {
		writeProject({
			languages: {
				typescript: { lint: { tools: ["oxlint"], mode: "all" } },
			},
		});
		const file = writeFile("a.ts", "export {};\n");
		const view = (await effectiveConfig({
			cwd: fx.projectDir,
			homeDir: fx.home,
			redact: true,
			file,
		})) as EffectiveConfigView;
		const fileView = view.file as EffectiveFileView;
		expect(fileView.languagePolicy).toMatchObject({
			key: "typescript",
			domains: { lint: { tools: ["oxlint"], mode: "all" } },
		});
		const eslint = fileView.tools.find((tool) => tool.id === "eslint");
		expect(eslint).toMatchObject({
			selected: false,
			reason: "not-configured-for-language",
		});
		expect(eslint?.decidedBy?.tier).toBe("project");
		expect(
			fileView.tools.find((tool) => tool.id === "tree-sitter")?.reason,
		).not.toBe("not-configured-for-language");
	});
});
