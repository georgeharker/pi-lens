/**
 * `languages.<id>.lsp` (#195): opt-in, config-controlled primary LSP server.
 *
 * Production funnel: real config files, `loadLSPConfig` -> `registerLSPConfig`,
 * the real gate (`explainServersForFile`, `getServersForFileWithConfig`), and
 * the real `effectiveConfig`. The first describe is the no-default-change
 * witness: every verdict equals a policy-free control's.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	effectiveConfig,
	type EffectiveConfigView,
	type EffectiveFileView,
} from "../../clients/effective-config.js";
import {
	explainServersForFile,
	getServersForFileWithConfig,
	initLSPConfig,
	loadLSPConfig,
	registerLSPConfig,
	type RegisteredLSPConfig,
} from "../../clients/lsp/config.js";
import { isAuxiliary } from "../../clients/lsp/server-traits.js";
import { useLanguageConfigFixture } from "../support/language-config-fixture.js";

vi.mock("../../clients/extension-log.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/extension-log.js")>()),
	logExtension: () => {},
}));

const fx = useLanguageConfigFixture("pi-lens-languages-");

const FILES: Record<string, string> = {
	"a.zsh": "echo zsh\n",
	"zsh-shebang.sh": "#!/usr/bin/env zsh\necho\n",
	"bash-shebang.sh": "#!/bin/bash\necho\n",
	"plain.sh": "echo\n",
	"x.py": "print(1)\n",
	"a.ts": "export {};\n",
	".zshrc": "setopt extendedglob\n",
	"functions/myfunc": "echo func\n",
};

function writeFiles(dir = fx.projectDir): void {
	for (const [name, content] of Object.entries(FILES)) {
		const target = path.join(dir, name);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
	}
}

/** Write `project` config plus the fixture files, and register the config. */
async function configured(
	project?: Record<string, unknown>,
): Promise<RegisteredLSPConfig> {
	if (project) fx.writeProject(project);
	writeFiles();
	return registerLSPConfig(await loadLSPConfig(fx.projectDir, fx.home));
}

/** A policy-free sibling project with the same files. */
async function control(): Promise<{
	dir: string;
	config: RegisteredLSPConfig;
}> {
	const dir = path.join(fx.home, "control");
	writeFiles(dir);
	return { dir, config: registerLSPConfig(await loadLSPConfig(dir, fx.home)) };
}

const at = (name: string): string => path.join(fx.projectDir, name);

/** Attached LANGUAGE servers (auxiliaries attach by their own rules). */
function attached(file: string, config: RegisteredLSPConfig): string[] {
	return explainServersForFile(file, config)
		.filter((d) => d.selected && !isAuxiliary(d.server))
		.map((d) => d.server.id);
}

function reasonOf(
	file: string,
	config: RegisteredLSPConfig,
	id: string,
): string | undefined {
	return explainServersForFile(file, config).find((d) => d.server.id === id)
		?.reason;
}

const verdicts = (file: string, config: RegisteredLSPConfig) =>
	explainServersForFile(file, config).map((d) => [d.server.id, d.reason]);

describe("languages.<id>.lsp — no default change", () => {
	it.each([
		["nothing is declared", undefined, Object.keys(FILES)],
		["the entry is empty", { languages: {} }, Object.keys(FILES)],
		[
			"the policy does not govern the file",
			{ languages: { zsh: { lsp: { server: "shuck" } } } },
			["bash-shebang.sh", "plain.sh", "x.py", "a.ts"],
		],
		[
			"the policy sets no lsp field",
			{ languages: { shell: { lsp: {} }, python: { files: [] } } },
			["a.zsh", "plain.sh", "x.py"],
		],
	])("matches the policy-free control when %s", async (_, project, names) => {
		const base = await control();
		const config = await configured(project);
		if (!project || Object.keys(project.languages ?? {}).length === 0)
			expect(config.languages).toBeUndefined();
		for (const name of names)
			expect(verdicts(at(name), config)).toEqual(
				verdicts(path.join(base.dir, name), base.config),
			);
	});
});

describe("languages.<id>.lsp — the configured server", () => {
	it("routes zsh files to the named server by dialect, not extension", async () => {
		const config = await configured({
			languages: { zsh: { lsp: { server: "shuck" } } },
		});
		// By default a zsh-shebang `.sh` gets NO language server: bash refuses it
		// (`pathFilter`) and shuck does not claim `.sh`.
		expect(reasonOf(at("zsh-shebang.sh"), config, "shuck")).toBe(
			"configured-for-language",
		);
		expect(attached(at("zsh-shebang.sh"), config)).toEqual(["shuck"]);
		expect(reasonOf(at("zsh-shebang.sh"), config, "bash")).toBe(
			"not-configured-for-language",
		);
		expect(attached(at("a.zsh"), config)).toEqual(["shuck"]);
		expect(reasonOf(at("bash-shebang.sh"), config, "bash")).toBe("selected");
	});

	it("admits files the registry cannot place through `files` patterns", async () => {
		const config = await configured({
			languages: {
				zsh: { files: [".zshrc", "functions/*"], lsp: { server: "shuck" } },
			},
		});
		for (const name of [".zshrc", "functions/myfunc"]) {
			expect(reasonOf(at(name), config, "shuck")).toBe(
				"configured-for-language",
			);
			expect(attached(at(name), config)).toEqual(["shuck"]);
		}
	});

	it("makes the named server the runtime's primary", async () => {
		await configured({ languages: { shell: { lsp: { server: "shuck" } } } });
		await initLSPConfig(fx.projectDir);
		const servers = getServersForFileWithConfig(at("plain.sh"));
		expect(servers.find((s) => !isAuxiliary(s))?.id).toBe("shuck");
		expect(servers.map((s) => s.id)).not.toContain("bash");
	});

	it("attaches no language server for enabled: false, keeping auxiliaries", async () => {
		const base = await control();
		const config = await configured({
			languages: { python: { lsp: { enabled: false } } },
		});
		expect(attached(at("x.py"), config)).toEqual([]);
		expect(reasonOf(at("x.py"), config, "python")).toBe(
			"not-configured-for-language",
		);
		const auxiliaries = (cfg: RegisteredLSPConfig, file: string) =>
			explainServersForFile(file, cfg)
				.filter((d) => d.selected && isAuxiliary(d.server))
				.map((d) => d.server.id);
		expect(auxiliaries(config, at("x.py"))).toEqual(
			auxiliaries(base.config, path.join(base.dir, "x.py")),
		);
	});

	it("keeps a disabled server off even when the policy names it", async () => {
		const config = await configured({
			lsp: { disabledServers: ["shuck"] },
			languages: { zsh: { lsp: { server: "shuck" } } },
		});
		expect(reasonOf(at("a.zsh"), config, "shuck")).toBe("disabled-by-config");
	});

	it("takes the most specific key: the dialect before shell", async () => {
		const config = await configured({
			languages: {
				shell: { lsp: { server: "bash" } },
				zsh: { lsp: { server: "shuck" } },
			},
		});
		expect(attached(at("a.zsh"), config)).toEqual(["shuck"]);
		expect(attached(at("plain.sh"), config)).toEqual(["bash"]);
	});

	it.each([
		["a project server inherits the global enabled: false", {}, []],
		[
			"a project enabled: true re-enables it",
			{ enabled: true },
			["python-jedi"],
		],
	])(
		"merges field by field across tiers (#195): %s",
		async (_, extra, expected) => {
			fx.writeGlobal({ languages: { python: { lsp: { enabled: false } } } });
			const config = await configured({
				languages: { python: { lsp: { server: "python-jedi", ...extra } } },
			});
			expect(attached(at("x.py"), config)).toEqual(expected);
		},
	);

	it("admits a custom lsp.servers entry as the primary", async () => {
		const config = await configured({
			lsp: {
				servers: {
					mysh: { name: "My", extensions: [".myx"], command: "mysh-lsp" },
				},
			},
			languages: { shell: { lsp: { server: "mysh" } } },
		});
		// Custom servers come after the built-ins, so by default one never
		// outranks bash for `.sh`.
		expect(attached(at("plain.sh"), config)).toEqual(["mysh"]);
	});
});

describe("languages.<id>.lsp — validation", () => {
	it.each([
		["an unknown server", "shuk", "not a known LSP server"],
		["an auxiliary server", "typos", "cannot be a primary"],
	])(
		"attaches nothing for %s, with a record that does not quote it",
		async (_, server, says) => {
			const config = await configured({
				languages: { shell: { lsp: { server } } },
			});
			expect(config.languages?.entries.get("shell")?.lsp?.unusable).toBe(true);
			expect(attached(at("plain.sh"), config)).toEqual([]);
			const notice = fx.notified.find((m) =>
				m.includes("languages.shell.lsp.server"),
			);
			expect(notice).toContain("[PILENS_CFG_0005]");
			expect(notice).toContain(says);
			expect(notice).not.toContain(`"${server}"`);
		},
	);

	it("drops an unknown language key, including a dispatch kind", async () => {
		const config = await configured({
			languages: { jsts: { lsp: { server: "deno" } } },
		});
		expect(config.languages).toBeUndefined();
		expect(
			fx.notified.some(
				(m) =>
					m.includes("[PILENS_CFG_0005]") &&
					m.includes("not a known language id"),
			),
		).toBe(true);
	});
});

describe("languages — effective_config", () => {
	async function viewOf(file: string): Promise<EffectiveFileView> {
		const view = (await effectiveConfig({
			cwd: fx.projectDir,
			homeDir: fx.home,
			redact: true,
			file: at(file),
		})) as EffectiveConfigView;
		return view.file as EffectiveFileView;
	}

	it("names the governing policy, how it matched, and the domain's provenance", async () => {
		await configured({ languages: { zsh: { lsp: { server: "shuck" } } } });
		const file = await viewOf("zsh-shebang.sh");
		expect(file.languagePolicy).toMatchObject({
			key: "zsh",
			via: "language",
			languageSource: "name",
			dialect: { dialect: "zsh", source: "shebang" },
			domains: { lsp: { server: "shuck" } },
		});
		const shuck = file.servers.find((s) => s.id === "shuck");
		expect(shuck).toMatchObject({
			selected: true,
			reason: "configured-for-language",
		});
		expect(shuck?.decidedBy?.tier).toBe("project");
		expect(file.servers.find((s) => s.id === "bash")?.reason).toBe(
			"not-configured-for-language",
		);
	});

	it("renders no policy for a file the config does not govern", async () => {
		await configured({ languages: { zsh: { lsp: { server: "shuck" } } } });
		expect((await viewOf("x.py")).languagePolicy).toBeUndefined();
	});
});
