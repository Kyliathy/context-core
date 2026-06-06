#!/usr/bin/env bun
/**
 * Launch ContextCore with a raised JSC heap ceiling.
 * Spawns a child Bun process so BUN_JSC_forceRAMSize is set before JSC starts.
 * Needed because npm on Windows (cmd.exe) cannot use VAR=value command syntax.
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
