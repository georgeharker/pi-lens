/**
 * `languages.<id>.lint` (#195), the dispatch half. A file whose policy sets
 * `lint` runs exactly the listed linters (if available):
 * - unlisted selectable linters skip ({@link NOT_CONFIGURED_FOR_LANGUAGE_SKIP_REASON})
 *   before `when`/`run`, so their tool never spawns;
 * - the preference owners take the list as the answer, and the covers seam
 *   defers to it (the operator asked for the linter by name);
 * - `all` runs every listed linter; `fallback` the first that answers, in
 *   order ({@link orderLintFallback}); `enabled: false` or `[]` runs none.
 * `dispatch.disabledRunners` still wins. Only selectable linters are
 * governed; analyzers and scanners run as before. Unknown or non-linter ids
 * drop with `PILENS_CFG_0005` (kept unvalidated before any registry loads,
 * as `dispatch.disabledRunners` does).
 */

import {
	type PiLensConfigResolution,
	reportPiLensConfigRecords,
} from "../config-resolve.js";
import {
	boundedKeyLabel,
	finalizeRecords,
	type MigrationRecord,
	migrationSubject,
} from "../config-core/records.js";
import {
	type ConfiguredLint,
	configuredLintOf,
	languageConfigOf,
	languagePointer,
	languagePolicyForFile,
} from "../language-config.js";
import { isSelectableLinterId } from "../tool-policy.js";
import {
	isKnownRunnerId,
	runnerIdentityPopulated,
} from "./known-runner-ids.js";
import {
	BLOCKING_DIAGNOSTICS_FAILURE_KIND,
	type RunnerGroup,
	type RunnerResult,
} from "./types.js";

/** The closed skip reason an unlisted linter reports (`RUNNER_SKIP_REASONS`). */
export const NOT_CONFIGURED_FOR_LANGUAGE_SKIP_REASON =
	"not-configured-for-language" as const;

/** The file's validated `lint` policy, plus records for dropped members. */
interface ConfiguredLintResolution {
	/** Undefined = the default path (no policy, or no `lint` choice). */
	readonly lint: ConfiguredLint | undefined;
	readonly records: readonly MigrationRecord[];
}

/**
 * The validated `lint` policy governing `filePath` under one resolution.
 * Pure: reads the resolution and the registry and writes nothing.
 */
export function configuredLintForFile(
	resolution: PiLensConfigResolution,
	filePath: string,
): ConfiguredLintResolution {
	const { config } = languageConfigOf(resolution);
	const match = languagePolicyForFile(config, filePath);
	const lint = configuredLintOf(match?.policy);
	if (!match || !lint) return { lint: undefined, records: [] };
	const validate = runnerIdentityPopulated();
	const key = match.policy.key;
	const pointer = languagePointer(key, "lint", "tools");
	const decidedBy = resolution.provenance.get(pointer);
	const file = decidedBy?.file ?? resolution.documents.at(-1)?.file ?? "";
	const tools: string[] = [];
	const records: MigrationRecord[] = [];
	lint.tools.forEach((id, index) => {
		const known = !validate || isKnownRunnerId(id);
		if (known && isSelectableLinterId(id)) {
			tools.push(id);
			return;
		}
		const memberPointer = `${pointer}/${index}`;
		records.push({
			code: "PILENS_CFG_0005",
			file,
			key: memberPointer,
			subject: migrationSubject(file, memberPointer),
			reason: known
				? `languages.${boundedKeyLabel(key)}.lint.tools names a runner that is not a selectable linter; dropped`
				: `languages.${boundedKeyLabel(key)}.lint.tools names an id that is not a registered dispatch runner; dropped`,
			...(decidedBy?.tier ? { tier: decidedBy.tier } : {}),
		});
	});
	return { lint: { tools, mode: lint.mode }, records };
}

/**
 * The `lint` policy a dispatch consults. Reports the dropped-member records
 * (the warn-once latch makes the per-dispatch call cheap) and returns the
 * policy, or `undefined` on the default path: the hot path for almost every
 * project.
 */
export function configuredLintFor(
	resolution: PiLensConfigResolution,
	filePath: string,
): ConfiguredLint | undefined {
	const resolved = configuredLintForFile(resolution, filePath);
	if (resolved.records.length > 0) {
		const anchor = resolved.records.at(-1);
		reportPiLensConfigRecords(
			finalizeRecords(resolved.records, {
				file: anchor?.file ?? "",
				...(anchor?.tier ? { tier: anchor.tier } : {}),
			}),
		);
	}
	return resolved.lint;
}

/**
 * Whether the policy governs `runnerId` and leaves it out: the dispatcher's
 * skip predicate. A non-linter runner is never governed.
 */
export function isUnconfiguredLinter(
	lint: ConfiguredLint | undefined,
	runnerId: string,
): boolean {
	return (
		lint !== undefined &&
		isSelectableLinterId(runnerId) &&
		!lint.tools.includes(runnerId)
	);
}

/**
 * Whether a succeeded linter should NOT end its fallback group: under
 * `mode: "all"` the operator listed every linter that should run, so a
 * plan's `mode: "fallback"` group keeps going past a listed success.
 */
export function continuesPastSuccess(
	lint: ConfiguredLint | undefined,
	runnerId: string,
): boolean {
	return (
		lint !== undefined && lint.mode === "all" && isSelectableLinterId(runnerId)
	);
}

/**
 * Under `mode: "fallback"`, a listed linter that answered with findings
 * also ends the group: #195 runs "the first available selected linter", and
 * it was available. The plan's own groups keep their rule (continue past
 * `failed`). A skipped or broken linter lets the next one run.
 */
export function endsLintFallback(
	lint: ConfiguredLint | undefined,
	runnerId: string,
	result: Pick<RunnerResult, "status" | "failureKind">,
): boolean {
	return (
		lint !== undefined &&
		lint.mode === "fallback" &&
		lint.tools.includes(runnerId) &&
		result.status === "failed" &&
		result.failureKind === BLOCKING_DIAGNOSTICS_FAILURE_KIND
	);
}

/**
 * For `mode: "fallback"`: moves the listed linters, in order, into one
 * sequential group (plan groups run in parallel, so `ruff-lint` then
 * `mypy` can only fall back inside one group). Linters in a group that sets
 * a `semantic` stay put, since moving them would change what their findings
 * mean. Emptied groups drop; any other mode returns the plan unchanged.
 */
export function orderLintFallback(
	groups: readonly RunnerGroup[],
	lint: ConfiguredLint | undefined,
): RunnerGroup[] {
	if (lint?.mode !== "fallback" || lint.tools.length === 0) return [...groups];
	const movable = new Map<string, RunnerGroup>();
	for (const group of groups) {
		if (group.semantic !== undefined) continue;
		for (const id of group.runnerIds)
			if (lint.tools.includes(id) && !movable.has(id)) movable.set(id, group);
	}
	const ordered: string[] = [];
	for (const id of lint.tools) if (movable.has(id)) ordered.push(id);
	if (ordered.length === 0) return [...groups];
	const moved = new Set(ordered);
	const kept: RunnerGroup[] = [];
	for (const group of groups) {
		if (group.semantic !== undefined) {
			kept.push(group);
			continue;
		}
		const runnerIds: string[] = [];
		for (const id of group.runnerIds) if (!moved.has(id)) runnerIds.push(id);
		if (runnerIds.length > 0) kept.push({ ...group, runnerIds });
	}
	const first = movable.get(ordered[0] ?? "");
	return [
		...kept,
		{
			mode: "fallback",
			runnerIds: ordered,
			...(first?.filterKinds === undefined
				? {}
				: { filterKinds: first.filterKinds }),
		},
	];
}
