/** Escapes a YAML scalar value for frontmatter. */
export function escapeYamlScalar(value: string): string
{
	if (/[:#\[\]{}|>&*!%@`]/.test(value) || value.includes("\n"))
	{
		return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	}
	return value;
}

/** Renders YAML frontmatter lines from key/value pairs. */
export function renderYamlFrontmatter(fields: Record<string, string | string[] | undefined>): string[]
{
	const lines: string[] = ["---"];
	for (const [key, value] of Object.entries(fields))
	{
		if (value === undefined) continue;
		if (Array.isArray(value))
		{
			if (value.length === 0) continue;
			lines.push(`${key}: [${value.map((v) => `'${v}'`).join(", ")}]`);
		}
		else if (value.trim() !== "")
		{
			lines.push(`${key}: ${escapeYamlScalar(value)}`);
		}
	}
	lines.push("---");
	return lines;
}
