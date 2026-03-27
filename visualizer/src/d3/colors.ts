const HARNESS_COLORS: Record<string, string> = {
	ClaudeCode: "#f59e0b",
	Cursor: "#8b5cf6",
	Kiro: "#10b981",
	VSCode: "#3b82f6",
	AgentFile: "#f97316",
	ContentFile: "#06b6d4",
	AgentCard: "#f97316",
	TemplateCard: "#8b5cf6",
};

export const SYMBOL_PALETTE = [
	"#93c5fd",
	"#fbbf24",
	"#34d399",
	"#f87171",
	"#a78bfa",
	"#fb923c",
	"#2dd4bf",
	"#e879f9",
	"#facc15",
	"#4ade80",
	"#38bdf8",
	"#f472b6",
];

export function getHarnessColor(harness: string): string
{
	return HARNESS_COLORS[harness] ?? "#6b7280";
}

export function getSymbolColor(label: string): string
{
	let hash = 0;
	for (let index = 0; index < label.length; index += 1)
	{
		hash = (hash + label.charCodeAt(index) * (index + 1)) % 2147483647;
	}
	return SYMBOL_PALETTE[Math.abs(hash) % SYMBOL_PALETTE.length];
}

function hashProject(project: string): number
{
	let hash = 2166136261;
	for (let index = 0; index < project.length; index += 1)
	{
		hash ^= project.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

function getProjectRgb(project: string): { red: number; green: number; blue: number }
{
	const normalized = (project || "MISC").trim().toLowerCase();
	const hash = hashProject(normalized);

	// Keep channels away from extremes so pills stay readable on dark and light themes.
	const red = 64 + (hash & 0x7f);
	const green = 64 + ((hash >> 8) & 0x7f);
	const blue = 64 + ((hash >> 16) & 0x7f);

	return { red, green, blue };
}

export function getProjectColor(project: string): string
{
	const { red, green, blue } = getProjectRgb(project);
	return `rgb(${red}, ${green}, ${blue})`;
}

export function getProjectTextColor(project: string): "#111827" | "#ffffff"
{
	const { red, green, blue } = getProjectRgb(project);
	const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
	return luminance > 0.58 ? "#111827" : "#ffffff";
}

export const MASTERCARD_PALETTE = [
	"#60a5fa", "#34d399", "#f87171", "#fbbf24", "#a78bfa",
	"#fb923c", "#2dd4bf", "#e879f9", "#facc15", "#4ade80",
	"#38bdf8", "#f472b6", "#86efac", "#fde68a", "#c084fc",
	"#67e8f9", "#fdba74", "#a5f3fc", "#d9f99d", "#fca5a5",
	"#7dd3fc", "#6ee7b7", "#fcd34d", "#d8b4fe", "#fdba74",
	"#5eead4", "#f9a8d4", "#bef264", "#fda4af", "#93c5fd",
	"#6ee7b7", "#fde047", "#c4b5fd", "#a5b4fc", "#86efac",
	"#99f6e4", "#fef08a", "#e9d5ff", "#bfdbfe", "#bbf7d0",
	"#fef9c3", "#ede9fe", "#dbeafe", "#dcfce7", "#fff7ed",
	"#fce7f3", "#ecfdf5", "#eff6ff", "#f0fdf4", "#fdf4ff",
];

export function getMasterCardColor(key: string): string
{
	let hash = 0;
	for (let index = 0; index < key.length; index += 1)
	{
		hash = (hash + key.charCodeAt(index) * (index + 1)) % 2147483647;
	}
	return MASTERCARD_PALETTE[Math.abs(hash) % MASTERCARD_PALETTE.length];
}