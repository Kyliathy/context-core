import { describe, expect, test } from "bun:test";
import { join } from "path";
import { buildMachineRowRefs } from "../../cxccli.js";

describe("cxccli VSCode row integration", () =>
{
	test("resolves VSCode hash storage path through workspace.json to readable project", () =>
	{
		const fixturePath = join(import.meta.dir, "fixtures", "vscode-workspace", "valid");
		const machine = {
			machine: "HOST",
			harnesses: {
				VSCode: { paths: [fixturePath] },
			},
		};

		const rows = buildMachineRowRefs(machine);
		expect(rows.length).toBe(1);

		const row = rows[0];
		expect(row.harness).toBe("VSCode");
		expect(row.workspaceMetaStatus).toBe("ok");
		expect(row.workspacePath).toBe("C:/Codez/Nexus/Reach2/context-core/");
		expect(row.computedProject).toBe("context-core");
		expect(row.computedProject).not.toBe("valid");
	});
});

