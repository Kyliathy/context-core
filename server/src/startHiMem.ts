#!/usr/bin/env bun
/**
 * Launch ContextCore with a raised JSC heap ceiling.
 * Spawns a child Bun process so BUN_JSC_forceRAMSize is set before JSC starts.
 * Needed because npm on Windows (cmd.exe) cannot use VAR=value command syntax.
 *
 * Logging audit: server/zz-reach2/upgrades/2026-06/r2wl-winston-logging.md (T64 — stdio inherit, no Winston wrapper)
 */

import { join } from "path";

//16 GiB perceived RAM — Bun's rough equivalent of a higher Node --max-old-space-size
const HI_MEM_BYTES = "17179869184";

const contextCorePath = join(import.meta.dir, "ContextCore.ts");

const proc = Bun.spawnSync(["bun", "run", contextCorePath], {
	env: {
		...process.env,
		BUN_JSC_forceRAMSize: HI_MEM_BYTES,
	},
	stdin: "inherit",
	stdout: "inherit",
	stderr: "inherit",
});

process.exit(proc.exitCode ?? 1);
