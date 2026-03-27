/**
 * Chunker – Routes content to appropriate LangChain text splitters.
 * Uses ContentClassifier to determine code vs prose, then applies optimal chunking strategy.
 */

import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { classifyBlob, splitMixedContent, type ContentKind } from "./ContentClassifier.js";

/** A chunk of message text with metadata about its content kind and position. */
export type MessageChunk = {
	/** The chunked text content. */
	text: string;
	/** Content classification for this chunk. */
	kind: ContentKind;
	/** Zero-based index of this chunk within the message's chunk sequence. */
	index: number;
};

/**
 * Chunks a message into segments suitable for embedding.
 * Routes to different LangChain splitters based on content classification.
 *
 * @param text - The full message text to chunk.
 * @returns Array of chunks with metadata. Empty array for empty text.
 */
export async function chunkMessage(text: string): Promise<MessageChunk[]>
{
	const trimmed = text.trim();

	// Edge case: empty message
	if (!trimmed)
	{
		return [];
	}

	// Edge case: very short messages become a single chunk
	if (trimmed.length < 100)
	{
		const kind = classifyBlob(trimmed);
		return [{ text: trimmed, kind, index: 0 }];
	}

	// Classify content
	const kind = classifyBlob(trimmed);

	try
	{
		// Route to appropriate splitter
		if (kind === "mixed")
		{
			return await chunkMixed(trimmed);
		}
		if (kind === "code")
		{
			return await chunkCode(trimmed);
		}
		// "prose" or "unknown" use prose splitter
		return await chunkProse(trimmed);
	} catch (error)
	{
		// Fallback: naive slicing if LangChain fails
		console.warn(`[Chunker] LangChain splitter failed for ${kind} content: ${(error as Error).message}. Falling back to naive chunking.`);
		return naiveChunk(trimmed, kind);
	}
}

/**
 * Chunks prose content using recursive character splitting.
 * @param text - Prose text to chunk.
 * @returns Array of chunks with "prose" kind.
 */
async function chunkProse(text: string): Promise<MessageChunk[]>
{
	const splitter = new RecursiveCharacterTextSplitter({
		chunkSize: 1000,
		chunkOverlap: 150,
	});

	const docs = await splitter.createDocuments([text]);
	return docs.map((doc, index) => ({
		text: doc.pageContent,
		kind: "prose" as ContentKind,
		index,
	}));
}

/**
 * Chunks code content using language-aware splitting.
 * @param text - Code text to chunk.
 * @returns Array of chunks with "code" kind.
 */
async function chunkCode(text: string): Promise<MessageChunk[]>
{
	// Default to JavaScript/TypeScript since ContextCore indexes IDE chat histories
	const splitter = RecursiveCharacterTextSplitter.fromLanguage("js", {
		chunkSize: 1200,
		chunkOverlap: 120,
	});

	const docs = await splitter.createDocuments([text]);
	return docs.map((doc, index) => ({
		text: doc.pageContent,
		kind: "code" as ContentKind,
		index,
	}));
}

/**
 * Chunks mixed content (prose + fenced code blocks) by splitting into spans first.
 * @param text - Mixed text containing prose and fenced code blocks.
 * @returns Array of chunks with appropriate kinds.
 */
async function chunkMixed(text: string): Promise<MessageChunk[]>
{
	const spans = splitMixedContent(text);
	const allChunks: MessageChunk[] = [];

	for (const span of spans)
	{
		let spanChunks: MessageChunk[];

		if (span.kind === "code")
		{
			spanChunks = await chunkCode(span.text);
		} else
		{
			// "prose" or "unknown" spans use prose splitter
			spanChunks = await chunkProse(span.text);
		}

		// Update kinds to match the span's classification
		spanChunks.forEach((chunk) =>
		{
			chunk.kind = span.kind;
		});

		allChunks.push(...spanChunks);
	}

	// Re-index chunks sequentially
	allChunks.forEach((chunk, idx) =>
	{
		chunk.index = idx;
	});

	return allChunks;
}

/**
 * Fallback chunking strategy using naive text slicing.
 * Used when LangChain splitters fail.
 *
 * @param text - Text to chunk.
 * @param kind - Content kind to assign to chunks.
 * @returns Array of chunks created via fixed-size slicing.
 */
function naiveChunk(text: string, kind: ContentKind): MessageChunk[]
{
	const chunkSize = 1000;
	const chunks: MessageChunk[] = [];
	let index = 0;

	for (let i = 0; i < text.length; i += chunkSize)
	{
		chunks.push({
			text: text.slice(i, i + chunkSize),
			kind,
			index: index++,
		});
	}

	return chunks;
}
