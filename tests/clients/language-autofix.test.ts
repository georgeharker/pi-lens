/**
 * `languages.<id>.autofix` (#195): the per-language fixer policy.
 *
 * Real config files on disk, the real autofix owner
 * (`getAutofixPolicyForFile`, which both autofix paths ask), and the real
 * `runAutofix` for the paths that must not start a fixer at all: a policy
 * that turns fixing off, and the global switch that a policy cannot override.
 */

import { describe, expect, it } from "vitest";
import { runAutofix } from "../../clients/pipeline.js";
import { getAutofixPolicyForFile } from "../../clients/tool-policy.js";
import { useLanguageConfigFixture } from "../support/language-config-fixture.js";

const fx = useLanguageConfigFixture("pi-lens-language-autofix-");
const { writeGlobal, writeProject } = fx;
const file = (name: string, content = "x\n"): string => fx.writeFile(name, content);

function preferred(
	target: string,
	context = {},
): readonly string[] | undefined {
	return getAutofixPolicyForFile(target, context)?.preferredTools;
}

describe("languages.<id>.autofix — the owner", () => {
	it("leaves the default policy alone with no policy, or a policy that chooses neither lint nor autofix", () => {
		const ts = file("a.ts", "export {};\n");
		const before = getAutofixPolicyForFile(ts, { hasEslintConfig: true });
		writeProject({ languages: { typescript: { format: { enabled: false } } } });
		expect(getAutofixPolicyForFile(ts, { hasEslintConfig: true })).toEqual(
			before,
		);
		expect(before?.preferredTools).toEqual(["eslint"]);
	});

	it("runs exactly the listed fixers, in the listed order", () => {
		writeProject({
			languages: { typescript: { autofix: { tools: ["oxlint", "biome"] } } },
		});
		const policy = getAutofixPolicyForFile(file("a.ts", "export {};\n"), {
			hasEslintConfig: true,
		});
		expect(policy?.preferredTools).toEqual(["oxlint", "biome"]);
		expect(policy?.defaultTool).toBe("oxlint");
		expect(policy?.safe).toBe(true);
	});

	it("follows lint.tools when autofix is unset: no eslint --fix when you chose oxlint", () => {
		writeProject({
			languages: { typescript: { lint: { tools: ["oxlint"], mode: "all" } } },
		});
		expect(
			preferred(file("a.ts", "export {};\n"), { hasEslintConfig: true }),
		).toEqual(["oxlint"]);
	});

	it("maps lint runner ids to their fixers, skipping linters that cannot fix", () => {
		writeProject({
			languages: {
				python: { lint: { tools: ["mypy", "ruff-lint"], mode: "all" } },
			},
		});
		expect(preferred(file("a.py", "x = 1\n"))).toEqual(["ruff"]);
	});

	it("fixes nothing for autofix.enabled: false, even over tools from another tier", () => {
		writeGlobal({
			languages: { typescript: { autofix: { tools: ["eslint"] } } },
		});
		writeProject({
			languages: { typescript: { autofix: { enabled: false } } },
		});
		expect(
			preferred(file("a.ts", "export {};\n"), { hasEslintConfig: true }),
		).toEqual([]);
	});

	it("fixes nothing when the language's lint policy runs no linters", () => {
		writeProject({ languages: { typescript: { lint: { enabled: false } } } });
		expect(
			preferred(file("a.ts", "export {};\n"), { hasEslintConfig: true }),
		).toEqual([]);
	});

	it("prefers autofix.tools over lint.tools", () => {
		writeProject({
			languages: {
				typescript: {
					lint: { tools: ["oxlint"], mode: "all" },
					autofix: { tools: ["biome"] },
				},
			},
		});
		expect(preferred(file("a.ts", "export {};\n"))).toEqual(["biome"]);
	});

	it("drops an unknown or unsafe fixer with a record that does not quote it", () => {
		writeProject({
			languages: { typescript: { autofix: { tools: ["eslnt", "eslint"] } } },
		});
		expect(preferred(file("a.ts", "export {};\n"))).toEqual(["eslint"]);
		const notice = fx.notified.find((m) =>
			m.includes("languages.typescript.autofix.tools"),
		);
		expect(notice).toContain("[PILENS_CFG_0005]");
		expect(notice).toContain("not a safe autofix tool");
		expect(notice).not.toContain("eslnt");
	});

	it("gives dart-analyze its project-wide dedup boundary", () => {
		writeProject({
			languages: { dart: { autofix: { tools: ["dart-analyze"] } } },
		});
		expect(
			getAutofixPolicyForFile(file("a.dart", "void main() {}\n"))?.scope,
		).toBe("dart-project");
	});
});

describe("languages.<id>.autofix — the write pipeline", () => {
	const deps = {
		biomeClient: {} as never,
		ruffClient: {} as never,
		fixedThisTurn: new Set<string>(),
	};

	it("starts no fixer when the policy turns fixing off", async () => {
		writeProject({
			languages: { typescript: { autofix: { enabled: false } } },
		});
		const target = file("a.ts", "export {};\n");
		const result = await runAutofix(
			target,
			fx.projectDir,
			() => false,
			() => {},
			{ ...deps, fixedThisTurn: new Set() },
		);
		expect(result.attemptedTools).toEqual([]);
		expect(result.skipReason).toBe("no_safe_tools");
	});

	it("narrow only: enabled: true cannot override the global autofix switch", async () => {
		writeProject({
			languages: {
				typescript: { autofix: { enabled: true, tools: ["eslint"] } },
			},
		});
		const target = file("a.ts", "export {};\n");
		const result = await runAutofix(
			target,
			fx.projectDir,
			(flag) => flag === "no-autofix",
			() => {},
			{ ...deps, fixedThisTurn: new Set() },
		);
		expect(result.attemptedTools).toEqual([]);
		expect(result.skipReason).toBe("disabled_by_flag");
	});
});
