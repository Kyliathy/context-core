const MARKDOWN_LINK_RE = /\[[^\]]+\]\(([^)]+)\)/g;
const INLINE_CODE_RE = /`([^`]+)`/g;
const BARE_PATH_RE = /(?:^|[\s(])([A-Za-z]:[\\/][^\s)]+|(?:\.{0,2}[\\/])?[\w.-]+(?:[\\/][\w.-]+)+\.\w+)/g;

/** Returns true when candidate should be dropped before resolution. */
function shouldDropCandidate(candidate: string): boolean
{
	const trimmed = candidate.trim();
	if (!trimmed) return true;
	if (/^(https?:|mailto:|#)/i.test(trimmed)) return true;
	if (trimmed.startsWith("#")) return true;
	return false;
}

/** Extracts raw path mention candidates from markdown/text content. */
export function extractPathMentions(content: string): string[]
{
	const found = new Set<string>();

	for (const match of content.matchAll(MARKDOWN_LINK_RE))
	{
		const candidate = match[1]?.trim();
		if (candidate && !shouldDropCandidate(candidate)) found.add(candidate);
	}

	for (const match of content.matchAll(INLINE_CODE_RE))
	{
		const candidate = match[1]?.trim();
		if (candidate && !shouldDropCandidate(candidate) && (candidate.includes("/") || candidate.includes("\\")))
		{
			found.add(candidate);
		}
	}

	for (const match of content.matchAll(BARE_PATH_RE))
	{
		const candidate = match[1]?.trim();
		if (candidate && !shouldDropCandidate(candidate)) found.add(candidate);
	}

	return [...found];
}
