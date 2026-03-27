import { useCallback, useState } from "react";

const HISTORY_STORAGE_KEY = "ccv:searchHistory";
const MAX_HISTORY_SIZE = 100;

function safeReadHistory(): string[]
{
	if (typeof window === "undefined")
	{
		return [];
	}

	try
	{
		const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
		if (!raw)
		{
			return [];
		}

		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed))
		{
			return [];
		}

		return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
	}
	catch
	{
		console.warn("[searchHistory] Failed to parse ccv:searchHistory. Falling back to empty.");
		return [];
	}
}

function safeWriteHistory(history: string[]): void
{
	if (typeof window === "undefined")
	{
		return;
	}

	try
	{
		window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
	}
	catch (error)
	{
		console.warn("[searchHistory] Failed to save search history to localStorage.", error);
	}
}

export function useSearchHistory()
{
	const [history, setHistory] = useState<string[]>(() => safeReadHistory());

	const addToHistory = useCallback((query: string) =>
	{
		const trimmed = query.trim();
		if (!trimmed)
		{
			return;
		}

		setHistory((prev) =>
		{
			// Remove duplicates (case-insensitive)
			const filtered = prev.filter((item) => item.toLowerCase() !== trimmed.toLowerCase());
			// Add to front
			const next = [trimmed, ...filtered].slice(0, MAX_HISTORY_SIZE);
			safeWriteHistory(next);
			return next;
		});
	}, []);

	const clearHistory = useCallback(() =>
	{
		setHistory([]);
		safeWriteHistory([]);
	}, []);

	const removeFromHistory = useCallback((query: string) =>
	{
		setHistory((prev) =>
		{
			const next = prev.filter((item) => item !== query);
			safeWriteHistory(next);
			return next;
		});
	}, []);

	const getMatches = useCallback((input: string, limit = 10): string[] =>
	{
		const trimmed = input.trim().toLowerCase();
		if (!trimmed)
		{
			return history.slice(0, limit);
		}

		return history.filter((item) => item.toLowerCase().includes(trimmed)).slice(0, limit);
	}, [history]);

	return {
		history,
		addToHistory,
		clearHistory,
		removeFromHistory,
		getMatches,
	};
}
