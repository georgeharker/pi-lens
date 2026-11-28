import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	languageForInterpreter,
	parseLanguageKey,
	resolveFileLanguage,
	resolveLanguageKey,
	SHELL_DIALECT_KEYS,
} from "../../clients/language-key.js";
import { LANGUAGES } from "../../clients/language-registry.js";

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-language-key-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
	const file = path.join(dir, name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	return file;
}

describe("parseLanguageKey", () => {
	it("accepts every registry language id", () => {
		for (const { id } of LANGUAGES)
			expect(parseLanguageKey(id)).toEqual({ language: id });
	});

	it("accepts a shell dialect key as a dialect of shell", () => {
		expect(parseLanguageKey("zsh")).toEqual({
			language: "shell",
			dialect: "zsh",
		});
	});

	it("refuses a dispatch kind, an old-style key, and anything unknown", () => {
		expect(parseLanguageKey("jsts")).toBeUndefined();
		expect(parseLanguageKey("shell:zsh")).toBeUndefined();
		expect(parseLanguageKey("toString")).toBeUndefined();
		expect(parseLanguageKey("")).toBeUndefined();
	});

	it("keeps every dialect key apart from the registry's ids", () => {
		const ids = new Set<string>(LANGUAGES.map((entry) => entry.id));
		for (const key of SHELL_DIALECT_KEYS) expect(ids.has(key)).toBe(false);
	});
});

describe("resolveLanguageKey — by name", () => {
	it("answers the registry id, its kind, and the name as evidence", () => {
		expect(resolveLanguageKey(write("a.ts", "export {};\n"))).toEqual({
			language: "typescript",
			kind: "jsts",
			languageSource: "name",
			candidates: ["typescript"],
		});
		expect(resolveLanguageKey(write("b.py", "x = 1\n")).candidates).toEqual([
			"python",
		]);
	});

	it("keeps distinct registry languages apart where dispatch shares a kind", () => {
		expect(resolveLanguageKey(write("a.c", "int x;\n")).language).toBe("c");
		expect(resolveLanguageKey(write("a.cpp", "int x;\n")).language).toBe("cpp");
		expect(resolveLanguageKey(write("a.js", "1;\n")).language).toBe(
			"javascript",
		);
	});

	it("answers nothing for an unplaced file", () => {
		expect(resolveLanguageKey(write(".zshrc", "setopt x\n"))).toEqual({
			language: undefined,
			candidates: [],
		});
	});
});

describe("resolveLanguageKey — shell dialects", () => {
	it("puts the dialect key ahead of shell, from a shebang over the extension", () => {
		const key = resolveLanguageKey(write("deploy.sh", "#!/usr/bin/env zsh\n"));
		expect(key.dialect).toEqual({ dialect: "zsh", source: "shebang" });
		expect(key.candidates).toEqual(["zsh", "shell"]);
	});

	it("takes the dialect from a shellcheck directive over the shebang", () => {
		const key = resolveLanguageKey(
			write("x.sh", "#!/bin/bash\n# shellcheck shell=dash\n"),
		);
		expect(key.dialect).toEqual({ dialect: "dash", source: "directive" });
		expect(key.candidates).toEqual(["dash", "shell"]);
	});

	it("reads a dialect-bearing extension as extension evidence", () => {
		expect(resolveLanguageKey(write("x.zsh", "echo\n")).candidates).toEqual([
			"zsh",
			"shell",
		]);
		expect(resolveLanguageKey(write("x.bash", "echo\n")).dialect).toEqual({
			dialect: "bash",
			source: "extension",
		});
	});

	it("reports a bare .sh as the resolver's bash default", () => {
		expect(resolveLanguageKey(write("x.sh", "echo\n")).dialect).toEqual({
			dialect: "bash",
			source: "default",
		});
	});

	it("gives a name-classified Makefile no dialect key", () => {
		const key = resolveLanguageKey(write("Makefile", "all:\n\techo\n"));
		expect(key.language).toBe("shell");
		expect(key.dialect).toBeUndefined();
		expect(key.candidates).toEqual(["shell"]);
	});
});

describe("resolveFileLanguage — shebang fallback for extensionless files", () => {
	it.each([
		["#!/usr/bin/env python3\n", "python"],
		["#!/usr/bin/python3.12 -u\n", "python"],
		["#!/usr/bin/env node\n", "javascript"],
		["#!/usr/bin/env -S deno run --allow-read\n", "typescript"],
		["#!/usr/bin/env bun\n", "javascript"],
		["#!/bin/bash\n", "shell"],
		["#!/usr/bin/env ruby\n", "ruby"],
		["#!/usr/bin/env perl\n", "perl"],
		["#!/usr/bin/env fish\n", "fish"],
	])("places %j as %s", (shebang, language) => {
		const resolved = resolveFileLanguage(write("script", `${shebang}body\n`));
		expect(resolved?.entry.id).toBe(language);
		expect(resolved?.source).toBe("shebang");
	});

	it("climbs from a shell shebang to the dialect key, then shell", () => {
		const key = resolveLanguageKey(write("bin/deploy", "#!/bin/zsh\necho\n"));
		expect(key).toMatchObject({
			language: "shell",
			languageSource: "shebang",
			dialect: { dialect: "zsh", source: "shebang" },
		});
		expect(key.candidates).toEqual(["zsh", "shell"]);
	});

	it("never consults the shebang of a file with an extension", () => {
		expect(
			resolveFileLanguage(write("notes.txt", "#!/usr/bin/env python3\n")),
		).toBeUndefined();
		expect(
			resolveFileLanguage(write("tool.rb", "#!/usr/bin/env python3\n"))?.entry
				.id,
		).toBe("ruby");
	});

	it("leaves no shebang, a later line, or an unknown interpreter unplaced", () => {
		expect(resolveFileLanguage(write("README", "hello\n"))).toBeUndefined();
		expect(
			resolveFileLanguage(write("later", "\n#!/usr/bin/env python3\n")),
		).toBeUndefined();
		expect(
			resolveFileLanguage(write("tool", "#!/usr/bin/env uv run --script\n")),
		).toBeUndefined();
	});

	it("keeps a name-classified file on the registry's answer", () => {
		expect(
			resolveFileLanguage(write("Dockerfile", "#!/usr/bin/env python3\n"))
				?.entry.id,
		).toBe("dockerfile");
	});

	it("strips a trailing version from the interpreter name", () => {
		expect(languageForInterpreter("python3.11")).toBe("python");
		expect(languageForInterpreter("pypy3")).toBe("python");
		expect(languageForInterpreter("lua5.4")).toBe("lua");
		expect(languageForInterpreter("Rscript")).toBe("r");
		expect(languageForInterpreter("awk")).toBeUndefined();
	});

	it("maps every interpreter onto a registry language", () => {
		const ids = new Set<string>(LANGUAGES.map((entry) => entry.id));
		for (const name of [
			"python",
			"node",
			"deno",
			"zsh",
			"perl",
			"pwsh",
			"julia",
			"rscript",
		])
			expect(ids.has(languageForInterpreter(name) ?? "")).toBe(true);
	});
});
