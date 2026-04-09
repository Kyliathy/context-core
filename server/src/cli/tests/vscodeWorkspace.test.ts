import { describe, expect, test } from "bun:test";
import { join } from "path";
import { deriveProjectName } from "../../utils/pathHelpers.js";
import {
	decodeVSCodeFileUri,
	resolveVSCodeWorkspaceMetadata,
} from "../../utils/vscodeWorkspace.js";

const FIXTURES_BASE = join(import.meta.dir, "fixtures", "vscode-workspace");

describe("vscodeWorkspace resolver", () =>
{
	test("decodes file URI using harness-compatible rules", () =>
	{
		expect(decodeVSCodeFileUri("file:///C%3A/Codez/Nexus/AXON")).toBe("C:/Codez/Nexus/AXON");
		expect(decodeVSCodeFileUri("file:///home/user/project")).toBe("/home/user/project");
		expect(decodeVSCodeFileUri("C:\\Users\\Axonn\\Codez")).toBe("C:\\Users\\Axonn\\Codez");
	});

	test("returns missing status when workspace.json is absent", () =>
	{
		const resolved = resolveVSCodeWorkspaceMetadata(join(FIXTURES_BASE, "missing"));
		expect(resolved.workspaceMetaStatus).toBe("missing");
		expect(resolved.workspacePath).toBeNull();
		expect(resolved.workspaceUri).toBeNull();
	});

	test("returns malformed status for invalid workspace.json", () =>
	{
		const resolved = resolveVSCodeWorkspaceMetadata(join(FIXTURES_BASE, "malformed"));
		expect(resolved.workspaceMetaStatus).toBe("malformed");
		expect(resolved.workspacePath).toBeNull();
		expect(resolved.workspaceUri).toBeNull();
	});

	test("resolves valid workspace URI and project derivation parity", () =>
	{
		const storagePath = join(FIXTURES_BASE, "valid");
		const resolved = resolveVSCodeWorkspaceMetadata(storagePath);

		expect(resolved.workspaceMetaStatus).toBe("ok");
		expect(resolved.workspaceUri).toBe("file:///C%3A/Codez/Nexus/Reach2/context-core/");
		expect(resolved.workspacePath).toBe("C:/Codez/Nexus/Reach2/context-core/");

		// Parity with VSCode harness project naming behavior:
		// project is derived from decoded workspace path when metadata is valid.
		const project = deriveProjectName("VSCode", resolved.workspacePath ?? storagePath);
		expect(project).toBe("context-core");
	});
});

