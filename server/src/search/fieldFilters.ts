/**
 * Field-targeted search filters for symbols and subject.
 * Used alongside the Fuse.js pipeline to narrow results to specific message fields.
 */

import { DateTime } from "luxon";
import type { AgentMessage } from "../models/AgentMessage.js";
import type { SearchResult } from "./searchEngine.js";

/**
 * Filters an AgentMessage array to those whose symbols array contains
 * the given term as a case-insensitive substring.
 */
export function filterMessagesBySymbols(messages: AgentMessage[], term: string): AgentMessage[]
{
	const lower = term.toLowerCase();
	return messages.filter((msg) =>
		msg.symbols.some((sym) => sym.toLowerCase().includes(lower))
	);
}

/**
 * Filters an AgentMessage array to those whose subject contains
 * the given term as a case-insensitive substring.
 */
export function filterMessagesBySubject(messages: AgentMessage[], term: string): AgentMessage[]
{
	const lower = term.toLowerCase();
	return messages.filter((msg) => msg.subject.toLowerCase().includes(lower));
}

/**
 * Filters a SearchResult array (from Fuse pipeline) to those whose symbols
 * array contains the given term as a case-insensitive substring.
 * Scores are preserved.
 */
export function filterResultsBySymbols(results: SearchResult[], term: string): SearchResult[]
{
	const lower = term.toLowerCase();
	return results.filter((r) =>
		r.message.symbols.some((sym) => sym.toLowerCase().includes(lower))
	);
}

/**
 * Filters a SearchResult array (from Fuse pipeline) to those whose subject
 * contains the given term as a case-insensitive substring.
 * Scores are preserved.
 */
export function filterResultsBySubject(results: SearchResult[], term: string): SearchResult[]
{
	const lower = term.toLowerCase();
	return results.filter((r) => r.message.subject.toLowerCase().includes(lower));
}

/**
 * Scores how well a symbol filter term matches a message's symbols.
 * Returns 1.0 for exact match, 0.7 for substring match, 0 if no match.
 */
function scoreSymbolMatch(msg: AgentMessage, term: string): number
{
	const lower = term.toLowerCase();
	let best = 0;
	for (const sym of msg.symbols)
	{
		const symLower = sym.toLowerCase();
		if (symLower === lower)
		{
			return 1.0; // exact — can't do better
		}
		if (symLower.includes(lower) && best < 0.7)
		{
			best = 0.7;
		}
	}
	return best;
}

/**
 * Scores how well a subject filter term matches a message's subject.
 * Returns the length ratio (search term length / subject length), clamped to 0–1.
 */
function scoreSubjectMatch(msg: AgentMessage, term: string): number
{
	if (!msg.subject) return 0;
	return Math.min(1, term.length / msg.subject.length);
}

/**
 * Computes a gentle recency boost: recent messages score ~1.0, messages 1 year old score ~0.8.
 */
function recencyBoost(dateTime: DateTime): number
{
	const daysSince = Math.max(0, -dateTime.diffNow("days").days);
	return Math.max(0.8, 1.0 - (daysSince / 365) * 0.2);
}

/**
 * Wraps AgentMessage[] as SearchResult[] with relevance scoring.
 * When symbolsTerm or subjectTerm are provided, scores are computed
 * from match quality (60%) and recency (40%). Otherwise falls back to 1.0.
 */
export function messagesToResults(
	messages: AgentMessage[],
	symbolsTerm?: string,
	subjectTerm?: string
): SearchResult[]
{
	const hasTerms = (symbolsTerm && symbolsTerm !== "") || (subjectTerm && subjectTerm !== "");

	return messages.map((message) =>
	{
		let score = 1.0;
		const matchedTerms: string[] = [];

		if (hasTerms)
		{
			let matchScore = 0;
			let matchCount = 0;

			if (symbolsTerm)
			{
				const symScore = scoreSymbolMatch(message, symbolsTerm);
				if (symScore > 0)
				{
					matchScore += symScore;
					matchCount++;
					matchedTerms.push(symbolsTerm);
				}
			}
			if (subjectTerm)
			{
				const subScore = scoreSubjectMatch(message, subjectTerm);
				if (subScore > 0)
				{
					matchScore += subScore;
					matchCount++;
					matchedTerms.push(subjectTerm);
				}
			}

			const avgMatch = matchCount > 0 ? matchScore / matchCount : 0;
			const boost = recencyBoost(message.dateTime);
			score = avgMatch * 0.6 + boost * 0.4;
		}

		return {
			message,
			score,
			rawFuseScore: 0,
			matchedTerms,
		};
	});
}
