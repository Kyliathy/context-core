/**
 * TopicContextBuilder – assembles an AI-ready context string from a session's messages.
 *
 * Rules:
 * - User messages: included in full.
 * - Assistant messages: segmented into paragraphs via LangChain, then only
 *   the first 2 and last 2 paragraph chunks are kept. Each chunk is truncated
 *   at the first code symbol ({ or }).
 * - Tool / system messages: skipped entirely.
 * - Budget: max 150 000 chars total, with the last 50 000 guaranteed from the
 *   tail of the conversation. When over budget, the oldest non-tail segments
 *   are evicted.
 */

import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import type { AgentMessage } from "../models/AgentMessage.js";

const MAX_TOTAL_CHARS = 150_000;
const TAIL_RESERVE_CHARS = 50_000;

type Segment = {
	text: string;
	fromTail: boolean;
};

/**
 * Builds a condensed text representation of a conversation for AI summarization.
 * @param messages - Chronologically ordered session messages.
 * @returns The assembled context string and its character count.
 */
export async function buildContext(
	messages: AgentMessage[]
): Promise<{ text: string; charsSent: number }>
{
	const segments: Segment[] = [];
	let totalLength = 0;

	// Phase 1 — Build segments from every eligible message
	for (const message of messages)
	{
		if (message.role === "tool" || message.role === "system")
		{
			continue;
		}

		if (message.role === "user")
		{
			const text = message.message;
			if (text.length > 0)
			{
				segments.push({ text, fromTail: false });
				totalLength += text.length;
			}
			continue;
		}

		// assistant — extract paragraph-level chunks
		const chunks = await splitIntoParagraphs(message.message);
		const selected = selectFirstLastTwo(chunks);

		for (const chunk of selected)
		{
			const truncated = truncateAtCodeSymbol(chunk);
			if (truncated.length > 0)
			{
				segments.push({ text: truncated, fromTail: false });
				totalLength += truncated.length;
			}
		}
	}

	if (segments.length === 0)
	{
		return { text: "", charsSent: 0 };
	}

	// Phase 2 — Mark tail segments (last 50K chars of the conversation)
	let tailAccum = 0;
	for (let i = segments.length - 1; i >= 0; i--)
	{
		if (tailAccum >= TAIL_RESERVE_CHARS)
		{
			break;
		}
		segments[i].fromTail = true;
		tailAccum += segments[i].text.length;
	}

	// Phase 3 — Evict oldest non-tail segments until total ≤ 150K
	while (totalLength > MAX_TOTAL_CHARS)
	{
		const evictIndex = segments.findIndex((s) => !s.fromTail);
		if (evictIndex === -1)
		{
			break; // only tail segments remain — nothing more to evict
		}
		totalLength -= segments[evictIndex].text.length;
		segments.splice(evictIndex, 1);
	}

	// Phase 4 — Assemble final string
	const text = segments.map((s) => s.text).join("\n---\n");
	return { text, charsSent: text.length };
}

/**
 * Splits an assistant message into paragraph-level chunks using LangChain.
 * Uses double-newline and single-newline as separators with no overlap,
 * so each chunk approximates a paragraph boundary.
 */
async function splitIntoParagraphs(text: string): Promise<string[]>
{
	const trimmed = text.trim();
	if (!trimmed)
	{
		return [];
	}

	try
	{
		const splitter = new RecursiveCharacterTextSplitter({
			separators: ["\n\n", "\n"],
			chunkSize: 2000,
			chunkOverlap: 0,
		});

		const docs = await splitter.createDocuments([trimmed]);
		return docs.map((doc) => doc.pageContent);
	} catch
	{
		// Fallback: split on double-newline manually
		return trimmed.split(/\n\n+/).filter((p) => p.trim().length > 0);
	}
}

/**
 * Selects the first 2 and last 2 chunks from a list.
 * If 4 or fewer chunks, returns all of them.
 */
function selectFirstLastTwo(chunks: string[]): string[]
{
	if (chunks.length <= 4)
	{
		return chunks;
	}

	return [
		chunks[0],
		chunks[1],
		chunks[chunks.length - 2],
		chunks[chunks.length - 1],
	];
}

/**
 * Truncates text at the first occurrence of a code symbol ({ or }).
 * Everything from the symbol onward (inclusive) is discarded.
 * @returns The truncated and trimmed text, or empty string if nothing remains.
 */
function truncateAtCodeSymbol(text: string): string
{
	const openBrace = text.indexOf("{");
	const closeBrace = text.indexOf("}");

	let cutPos = -1;
	if (openBrace !== -1 && closeBrace !== -1)
	{
		cutPos = Math.min(openBrace, closeBrace);
	} else if (openBrace !== -1)
	{
		cutPos = openBrace;
	} else if (closeBrace !== -1)
	{
		cutPos = closeBrace;
	}

	if (cutPos === -1)
	{
		return text;
	}

	return text.slice(0, cutPos).trimEnd();
}
