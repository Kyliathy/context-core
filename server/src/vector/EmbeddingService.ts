/**
 * EmbeddingService – OpenAI embedding generation via Vercel AI SDK.
 * Handles retry logic with exponential backoff for transient failures.
 */

import { embed, embedMany } from "ai";
import { openai } from "@ai-sdk/openai";

/** Embedding vector dimension for text-embedding-3-large model. */
export const EMBEDDING_DIMENSIONS = 3072;

/**
 * Service for generating text embeddings using OpenAI's embedding models.
 */
export class EmbeddingService
{
	private readonly apiKey: string;
	private readonly model = openai.embedding("text-embedding-3-large");

	/**
	 * Creates an embedding service instance.
	 * @param apiKey - OpenAI API key for authentication.
	 */
	constructor(apiKey: string)
	{
		this.apiKey = apiKey;
	}

	/**
	 * Generates an embedding vector for a single text string.
	 * @param text - Text to embed.
	 * @returns Embedding vector (3072 dimensions).
	 */
	async embed(text: string): Promise<number[]>
	{
		return await this.withRetry(async () =>
		{
			const result = await embed({
				model: this.model,
				value: text,
			});
			return result.embedding;
		}, `embed (length: ${text.length})`);
	}

	/**
	 * Generates embedding vectors for multiple text strings.
	 * Handles batch size limits by splitting into smaller batches if needed.
	 *
	 * @param texts - Array of texts to embed.
	 * @returns Array of embedding vectors.
	 */
	async embedBatch(texts: string[]): Promise<number[][]>
	{
		if (texts.length === 0)
		{
			return [];
		}

		// Split into safe batch sizes (100 texts per batch)
		const batchSize = 100;
		const batches: string[][] = [];
		for (let i = 0; i < texts.length; i += batchSize)
		{
			batches.push(texts.slice(i, i + batchSize));
		}

		// Process each batch
		const allEmbeddings: number[][] = [];
		for (const batch of batches)
		{
			const batchEmbeddings = await this.withRetry(async () =>
			{
				const result = await embedMany({
					model: this.model,
					values: batch,
				});
				return result.embeddings;
			}, `embedBatch (${batch.length} texts)`);

			allEmbeddings.push(...batchEmbeddings);
		}

		return allEmbeddings;
	}

	/**
	 * Wraps an async operation with retry logic and exponential backoff.
	 * @param operation - Async operation to execute.
	 * @param context - Context string for error logging.
	 * @returns Result of the operation.
	 */
	private async withRetry<T>(operation: () => Promise<T>, context: string): Promise<T>
	{
		const maxAttempts = 3;
		const delays = [1000, 2000, 4000]; // 1s, 2s, 4s

		for (let attempt = 0; attempt < maxAttempts; attempt++)
		{
			try
			{
				return await operation();
			} catch (error)
			{
				const err = error as { status?: number; message?: string };
				const isRetryable = this.isRetryableError(err);

				if (!isRetryable || attempt === maxAttempts - 1)
				{
					// Final failure or non-retryable error
					console.warn(
						`[EmbeddingService] Failed to ${context}: ${err.message ?? error}. Attempt ${attempt + 1}/${maxAttempts}.`
					);
					throw error;
				}

				// Retry with backoff
				const delay = delays[attempt] ?? 4000;
				console.warn(
					`[EmbeddingService] Retrying ${context} after ${delay}ms. Attempt ${attempt + 1}/${maxAttempts}. Error: ${err.message ?? error}`
				);
				await this.sleep(delay);
			}
		}

		// TypeScript exhaustiveness check
		throw new Error("Retry loop exhausted unexpectedly");
	}

	/**
	 * Determines if an error is retryable.
	 * @param error - Error object from OpenAI API.
	 * @returns True if the error should trigger a retry.
	 */
	private isRetryableError(error: { status?: number; message?: string }): boolean
	{
		const status = error.status;

		// Retry on rate limits, server errors, and network errors
		if (status === 429) return true; // Rate limit
		if (status && status >= 500) return true; // 5xx server errors
		if (!status) return true; // Network errors (no status code)

		// Don't retry on client errors (except 429)
		return false;
	}

	/**
	 * Sleeps for a specified duration.
	 * @param ms - Milliseconds to sleep.
	 */
	private sleep(ms: number): Promise<void>
	{
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
