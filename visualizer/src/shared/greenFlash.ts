export type GreenFlashPhase = "glow" | "base";

export type GreenFlashStep = {
	phase: GreenFlashPhase;
	durationMs: number;
};

export const GREEN_FLASH_COLOR = "#22c55e";
export const GREEN_FLASH_FILTER = "drop-shadow(0 0 8px rgba(34, 197, 94, 0.95)) drop-shadow(0 0 14px rgba(34, 197, 94, 0.75))";
export const GREEN_FLASH_BOX_SHADOW = "0 0 8px rgba(34, 197, 94, 0.95), 0 0 14px rgba(34, 197, 94, 0.75)";

export const GREEN_FLASH_SEQUENCE: ReadonlyArray<GreenFlashStep> = [
	{ phase: "glow", durationMs: 120 },
	{ phase: "base", durationMs: 140 },
	{ phase: "glow", durationMs: 120 },
	{ phase: "base", durationMs: 140 },
];

export function runGreenFlash(applyStep: (step: GreenFlashStep) => void): () => void
{
	const timers: Array<ReturnType<typeof setTimeout>> = [];
	let elapsedMs = 0;

	for (const step of GREEN_FLASH_SEQUENCE)
	{
		const timer = setTimeout(() => applyStep(step), elapsedMs);
		timers.push(timer);
		elapsedMs += step.durationMs;
	}

	return () =>
	{
		for (const timer of timers)
		{
			clearTimeout(timer);
		}
	};
}
