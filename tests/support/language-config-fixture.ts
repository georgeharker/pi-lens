/**
 * The shared harness for the `languages.<id>` (#195) suites: a temp home with
 * a global tier (`<tmp>/.pi-lens/config.json`, via `PI_LENS_HOME` and
 * `PI_LENS_CONFIG_PATH`) and a project (`<tmp>/proj`), captured user
 * notices, and every cache a policy read touches reset around each test.
 *
 * Call at collection time (module or `describe` body). The returned object's
 * paths are fresh for each test.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { resetIgnoredConfigWarnCache } from "../../clients/config-warn.js";
import { clearFormatterCache } from "../../clients/formatters.js";
import { _resetLanguagePolicyCacheForTests } from "../../clients/language-policy-for-file.js";
import {
	resetLSPConfigStateForTests,
	resetLSPConfigWarnCache,
} from "../../clients/lsp/config.js";
import { resetProjectLensConfigCache } from "../../clients/project-lens-config.js";
import { wireUserNotifier } from "../../clients/user-notify.js";
import { removeTempDirSync } from "../clients/test-utils.js";
import { useConfigPath } from "./global-config.js";

export interface LanguageConfigFixture {
	/** The temp root, which is also the walk's `$HOME` ceiling. */
	readonly home: string;
	/** `<home>/.pi-lens`, the global tier's directory. */
	readonly globalDir: string;
	/** `<home>/proj`, the project root. */
	readonly projectDir: string;
	/** User notices captured this test. */
	readonly notified: string[];
	/** Write the global `config.json`. */
	writeGlobal(config: unknown): void;
	/** Write `.pi-lens.json` in the project, or in `dir`. */
	writeProject(config: unknown, dir?: string): void;
	/** Write a raw file under the project; returns its absolute path. */
	writeFile(relative: string, content?: string): string;
}

export function useLanguageConfigFixture(
	prefix: string,
): LanguageConfigFixture {
	const setConfigPath = useConfigPath();
	const notified: string[] = [];
	let home = "";
	const fixture: LanguageConfigFixture = {
		get home() {
			return home;
		},
		get globalDir() {
			return path.join(home, ".pi-lens");
		},
		get projectDir() {
			return path.join(home, "proj");
		},
		notified,
		writeGlobal(config) {
			fs.mkdirSync(fixture.globalDir, { recursive: true });
			fs.writeFileSync(
				path.join(fixture.globalDir, "config.json"),
				JSON.stringify(config),
			);
		},
		writeProject(config, dir = fixture.projectDir) {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, ".pi-lens.json"), JSON.stringify(config));
		},
		writeFile(relative, content = "x\n") {
			const target = path.join(fixture.projectDir, relative);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, content);
			return target;
		},
	};

	const resetCaches = (): void => {
		resetLSPConfigStateForTests();
		resetLSPConfigWarnCache();
		resetIgnoredConfigWarnCache();
		resetProjectLensConfigCache();
		clearFormatterCache();
		_resetLanguagePolicyCacheForTests();
	};

	beforeEach(async () => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
		fs.mkdirSync(fixture.globalDir, { recursive: true });
		fs.mkdirSync(fixture.projectDir, { recursive: true });
		vi.stubEnv("PI_LENS_HOME", fixture.globalDir);
		setConfigPath(path.join(fixture.globalDir, "config.json"));
		const trust = await import("../../clients/project-trust.js");
		trust.setProjectTrustState("trusted");
		resetCaches();
		notified.length = 0;
		wireUserNotifier(() => (message) => {
			notified.push(message);
		});
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		resetCaches();
		removeTempDirSync(home);
	});

	return fixture;
}
