/**
 * ContentClassifier – Heuristic-based classification of message content.
 * Routes messages to appropriate LangChain text splitters based on content kind.
 */

/** Classification categories for message content. */
export type ContentKind = "prose" | "code" | "mixed" | "unknown";

/** A span of text with a specific content kind and position markers. */
export type ContentSpan = {
	text: string;
	kind: Exclude<ContentKind, "mixed">; // Spans are never "mixed" after decomposition
	startIndex: number;
	endIndex: number;
};

/**
 * Classifies a blob of text into one of four categories using heuristic scoring.
 * @param text - The text to classify.
 * @returns Content kind: "prose", "code", "mixed", or "unknown".
 */
export function classifyBlob(text: string): ContentKind
{
	const trimmed = text.trim();

	// Edge case: empty text
	if (!trimmed)
	{
		return "unknown";
	}

	// Short snippets need stronger evidence
	if (trimmed.length < 30)
	{
		// Check for strong code signals in short text
		const hasSemicolonEnd = /[;{}()]/.test(trimmed);
		const hasKeyword = /^(function|class|const|let|var|import|export|return|async|def|fn)\b/.test(trimmed);
		if (hasSemicolonEnd && hasKeyword)
		{
			return "code";
		}
		return "unknown";
	}

	// Check for fenced code blocks (indicates mixed content)
	const hasFencedBlock = /```[\w]*\n[\s\S]*?```/g.test(trimmed);
	if (hasFencedBlock)
	{
		return "mixed";
	}

	// Count various signals
	const lines = trimmed.split(/\r?\n/);

	// Code signals
	const lineEndingSemis = lines.filter((line) => /;\s*$/.test(line)).length;
	const codeKeywords = (trimmed.match(/\b(function|class|public|private|protected|const|let|var|import|export|return|async|await|def|fn|interface|type|enum)\b/g) ?? []).length;
	const syntaxPunctuation = (trimmed.match(/[{}[\]()=<>:;]/g) ?? []).length;
	const declarationPattern = /^\s*(public|private|protected|export|const|let|var|function|class|interface|type|enum)\s+\w+/.test(trimmed);

	// Prose signals
	const stopwords = (trimmed.match(/\b(the|and|is|this|that|some|with|for|of|to|in|it|can|will|a|an)\b/gi) ?? []).length;
	const words = (trimmed.match(/\b\w+\b/g) ?? []).length;
	const sentencePunctuation = (trimmed.match(/[.!?](?=\s|$)/g) ?? []).length;

	// Calculate scores
	let codeScore = 0;
	let proseScore = 0;

	// Code scoring
	codeScore += lineEndingSemis * 2;
	codeScore += codeKeywords * 1.5;
	codeScore += Math.min(syntaxPunctuation / trimmed.length, 0.3) * 20; // Syntax density (capped)
	if (declarationPattern) codeScore += 4;

	// Prose scoring
	proseScore += (stopwords / Math.max(words, 1)) * 10; // Stopword density
	proseScore += sentencePunctuation * 1.5;
	if (words >= 8) proseScore += 2;

	// Decision thresholds
	const codeRatio = codeScore / Math.max(proseScore, 1);
	const proseRatio = proseScore / Math.max(codeScore, 1);

	if (codeRatio > 1.5)
	{
		return "code";
	}
	if (proseRatio > 1.5)
	{
		return "prose";
	}

	// Ambiguous: default to unknown
	return "unknown";
}

/**
 * Splits mixed content (prose + fenced code blocks) into tagged spans.
 * @param text - Text containing fenced code blocks.
 * @returns Array of spans, each with its own classification (never "mixed").
 */
export function splitMixedContent(text: string): ContentSpan[]
{
	const spans: ContentSpan[] = [];
	const fencedBlockRegex = /```[\w]*\n([\s\S]*?)```/g;

	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = fencedBlockRegex.exec(text)) !== null)
	{
		const fenceStart = match.index;
		const fenceEnd = fencedBlockRegex.lastIndex;

		// Extract prose before this fence
		if (fenceStart > lastIndex)
		{
			const proseText = text.slice(lastIndex, fenceStart);
			const proseKind = classifyBlob(proseText);
			if (proseText.trim())
			{
				spans.push({
					text: proseText,
					kind: proseKind === "mixed" ? "prose" : (proseKind as Exclude<ContentKind, "mixed">),
					startIndex: lastIndex,
					endIndex: fenceStart,
				});
			}
		}

		// Extract code block
		const codeText = match[1] ?? match[0]; // Captured group or full match
		if (codeText.trim())
		{
			spans.push({
				text: codeText,
				kind: "code",
				startIndex: fenceStart,
				endIndex: fenceEnd,
			});
		}

		lastIndex = fenceEnd;
	}

	// Handle remaining text after last fence
	if (lastIndex < text.length)
	{
		const remainingText = text.slice(lastIndex);
		const remainingKind = classifyBlob(remainingText);
		if (remainingText.trim())
		{
			spans.push({
				text: remainingText,
				kind: remainingKind === "mixed" ? "prose" : (remainingKind as Exclude<ContentKind, "mixed">),
				startIndex: lastIndex,
				endIndex: text.length,
			});
		}
	}

	// If no spans were created (malformed or no fenced blocks), treat entire text as prose
	if (spans.length === 0)
	{
		const fallbackKind = classifyBlob(text);
		return [
			{
				text,
				kind: fallbackKind === "mixed" ? "prose" : (fallbackKind as Exclude<ContentKind, "mixed">),
				startIndex: 0,
				endIndex: text.length,
			},
		];
	}

	return spans;
}
