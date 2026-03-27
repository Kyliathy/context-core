/**
 * VectorConfig – Environment variable reader for Qdrant vector search.
 * Provides feature gate and typed configuration access.
 */

/** Configuration options for vector search services. */
export type VectorConfigOptions = {
	/** Qdrant server URL (e.g., http://localhost:6333). */
	qdrantUrl: string | null;
	/** Optional Qdrant API key for authentication. */
	qdrantApiKey: string | null;
	/** OpenAI API key for embedding generation. */
	openaiApiKey: string | null;
	/** Minimum similarity score threshold for Qdrant search results (0.0-1.0). */
	minScore: number;
	/** Delay in milliseconds between embedding API batches for rate limiting. */
	batchDelayMs: number;
};

/**
 * Reads vector search configuration from environment variables.
 * @returns Typed configuration object with defaults for optional fields.
 */
export function getVectorConfig(): VectorConfigOptions
{
	const qdrantUrl = process.env.QDRANT_URL ?? null;
	const qdrantApiKey = process.env.QDRANT_API_KEY ?? null;
	const openaiApiKey = process.env.OPENAI_API_KEY ?? null;

	// Parse numeric configs with defaults
	const minScore = parseFloat(process.env.QDRANT_MIN_SCORE ?? "0.6");
	const batchDelayMs = parseInt(process.env.EMBEDDING_BATCH_DELAY_MS ?? "200", 10);

	return {
		qdrantUrl,
		qdrantApiKey,
		openaiApiKey,
		minScore: Number.isNaN(minScore) ? 0.6 : Math.max(0, Math.min(1, minScore)),
		batchDelayMs: Number.isNaN(batchDelayMs) ? 200 : Math.max(0, batchDelayMs),
	};
}

/**
 * Feature gate: checks if Qdrant vector search is enabled.
 * Requires both QDRANT_URL and OPENAI_API_KEY to be set.
 * @returns True if both required environment variables are present and non-empty.
 */
export function isQdrantEnabled(): boolean
{
	const config = getVectorConfig();

	// Both URL and API key must be present
	const hasQdrantUrl = config.qdrantUrl !== null && config.qdrantUrl.trim() !== "";
	const hasOpenAIKey = config.openaiApiKey !== null && config.openaiApiKey.trim() !== "";

	if (hasQdrantUrl && !hasOpenAIKey)
	{
		console.warn("[VectorConfig] QDRANT_URL is set but OPENAI_API_KEY is missing. Vector search disabled.");
	} else if (!hasQdrantUrl && hasOpenAIKey)
	{
		console.warn("[VectorConfig] OPENAI_API_KEY is set but QDRANT_URL is missing. Vector search disabled.");
	}

	return hasQdrantUrl && hasOpenAIKey;
}

/**
 * Checks if AI summarization should be skipped during startup.
 * When true, the TopicSummarizer pass is skipped entirely.
 * Whatever TopicStore already contains is still used for payload enrichment and summary embedding.
 * @returns True if SKIP_AI_SUMMARIZATION is set to a truthy value.
 */
export function isAiSummarizationSkipped(): boolean
{
	const val = (process.env.SKIP_AI_SUMMARIZATION ?? "").trim().toLowerCase();
	return val === "true" || val === "1" || val === "yes";
}

/**
 * Checks if Qdrant pipeline (embedding/upsert) should be skipped.
 * When true, Qdrant services are still initialized for search and runtime
 * incremental updates, but the bulk embedding pipeline does not run on startup.
 * @returns True if SKIP_STARTUP_UPDATING_QDRANT is set to a truthy value.
 */
export function isQdrantUpdateSkipped(): boolean
{
	const val = (process.env.SKIP_STARTUP_UPDATING_QDRANT ?? "").trim().toLowerCase();
	return val === "true" || val === "1" || val === "yes";
}

/**
 * Checks if Qdrant should be fully disabled at runtime.
 * When true, no Qdrant services are initialized and search remains Fuse-only.
 * @returns True if DO_NOT_USE_QDRANT is set to a truthy value.
 */
export function isQdrantUsageDisabled(): boolean
{
	const val = (process.env.DO_NOT_USE_QDRANT ?? "").trim().toLowerCase();
	return val === "true" || val === "1" || val === "yes";
}
