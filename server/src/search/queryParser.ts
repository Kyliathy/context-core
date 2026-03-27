/**
 * Query parser for advanced search syntax.
 * Supports exact phrases (quotes), OR queries (space), AND queries (+).
 */

export type SearchToken =
	| { type: "fuzzy"; term: string }
	| { type: "exact"; phrase: string };

export type ParsedQuery =
	| { mode: "or"; tokens: SearchToken[] }
	| { mode: "and"; tokens: SearchToken[] };

export type ScoringConfig = {
	scoreWeight: number; // weight for normalized Fuse.js score (0-1)
	countWeight: number; // weight for term match ratio (0-1)
};

export const DEFAULT_SCORING: ScoringConfig = {
	scoreWeight: 0.6,
	countWeight: 0.4,
};

/**
 * Extracts quoted phrases from a query string.
 * @param raw - Raw query string.
 * @returns Array of exact phrases and the remaining string with quotes removed.
 */
export function extractQuotedPhrases(raw: string): { phrases: string[]; remaining: string }
{
	const phrases: string[] = [];
	let remaining = raw;

	// Match quoted phrases (handles escaped quotes)
	const quoteRegex = /"([^"]*)"/g;
	let match: RegExpExecArray | null;

	while ((match = quoteRegex.exec(raw)) !== null)
	{
		if (match[1].trim())
		{
			phrases.push(match[1].trim());
		}
	}

	// Remove all quoted sections from the remaining string
	remaining = remaining.replace(quoteRegex, " ").trim();

	return { phrases, remaining };
}

/**
 * Tokenizes a query string into terms.
 * Splits on ` + ` for AND groups, then whitespace for OR terms.
 * @param raw - Query string with quotes already removed.
 * @returns Array of term strings.
 */
export function tokenize(raw: string): string[]
{
	if (!raw.trim())
	{
		return [];
	}

	// Split on whitespace, filter empty strings
	return raw
		.split(/\s+/)
		.map((t) => t.trim())
		.filter((t) => t.length > 0 && t !== "+");
}

/**
 * Parses a raw search query into structured tokens and mode.
 * @param raw - Raw query string from user input.
 * @returns ParsedQuery with mode and tokens.
 */
export function parseSearchQuery(raw: string): ParsedQuery
{
	const trimmed = raw.trim();
	if (!trimmed)
	{
		return { mode: "or", tokens: [] };
	}

	// Extract exact phrases first
	const { phrases, remaining } = extractQuotedPhrases(trimmed);

	// Check if AND mode (contains +)
	const isAndMode = remaining.includes("+");

	let fuzzyTerms: string[];
	if (isAndMode)
	{
		// Split on + for AND groups
		const andGroups = remaining.split("+").map((g) => g.trim());
		fuzzyTerms = andGroups.flatMap((group) => tokenize(group));
	} else
	{
		// OR mode - simple whitespace split
		fuzzyTerms = tokenize(remaining);
	}

	// Build tokens array
	const tokens: SearchToken[] = [
		...phrases.map((phrase): SearchToken => ({ type: "exact", phrase })),
		...fuzzyTerms.map((term): SearchToken => ({ type: "fuzzy", term })),
	];

	return {
		mode: isAndMode ? "and" : "or",
		tokens,
	};
}

/**
 * Checks if a message matches an exact phrase (case-insensitive).
 * @param message - Message text to search.
 * @param phrase - Exact phrase to match.
 * @returns True if the phrase is found as a substring.
 */
export function matchesExact(message: string, phrase: string): boolean
{
	return message.toLowerCase().includes(phrase.toLowerCase());
}

/**
 * Counts total occurrences of all matched terms in a text string.
 * Handles exact phrases (surrounded by quotes) and plain fuzzy terms.
 * Used to compute the `hits` field on search results.
 * @param text - Message text to search.
 * @param matchedTerms - Terms as produced by the search engine (exact phrases wrapped in quotes).
 * @returns Total hit count across all terms.
 */
export function countTermHits(text: string, matchedTerms: string[]): number
{
	let total = 0;
	const lowerText = text.toLowerCase();
	for (const term of matchedTerms)
	{
		// Exact phrases are stored as `"phrase"` — strip surrounding quotes
		const needle = term.startsWith('"') && term.endsWith('"')
			? term.slice(1, -1).toLowerCase()
			: term.toLowerCase();
		if (!needle) continue;
		let idx = 0;
		while ((idx = lowerText.indexOf(needle, idx)) !== -1)
		{
			total++;
			idx += needle.length;
		}
	}
	return total;
}

/**
 * Computes a composite score for OR queries.
 * Combines normalized Fuse.js score with term match ratio.
 * @param avgFuseScore - Average Fuse.js score across matched terms (0 = perfect).
 * @param matchedTermCount - How many query terms this message matched.
 * @param totalTermCount - Total terms in the query.
 * @param config - Scoring weights configuration.
 * @returns Composite score (higher = better match).
 */
export function computeCompositeScore(
	avgFuseScore: number,
	matchedTermCount: number,
	totalTermCount: number,
	config: ScoringConfig = DEFAULT_SCORING
): number
{
	// Fuse.js scores are 0 (perfect) to 1 (worst), invert for ranking
	const normalizedScore = 1 - avgFuseScore;
	const matchRatio = totalTermCount > 0 ? matchedTermCount / totalTermCount : 0;

	return normalizedScore * config.scoreWeight + matchRatio * config.countWeight;
}
