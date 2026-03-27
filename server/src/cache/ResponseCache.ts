import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DateTime } from 'luxon';
import { CCSettings } from '../settings/CCSettings';

const CACHE_SUBDIR = 'zeCache/queries';
const HASH_LENGTH = 12;
const PREFIX_MAX_LENGTH = 50;

/**
 * Sanitizes a query string to create a filesystem-safe filename prefix.
 * Converts to lowercase, replaces non-alphanumeric chars with dashes,
 * collapses multiple dashes, and truncates to max length.
 */
export function sanitizeQueryForFilename(query: string): string
{
	return query
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.replace(/-{2,}/g, '-')
		.slice(0, PREFIX_MAX_LENGTH);
}

/**
 * Computes a deterministic hash of a query string.
 * Uses SHA-256 and truncates to 12 hex characters.
 * Case-insensitive (lowercases query before hashing).
 */
export function computeQueryHash(query: string): string
{
	return createHash('sha256')
		.update(query.toLowerCase())
		.digest('hex')
		.slice(0, HASH_LENGTH);
}

/**
 * Returns the cache directory path for today.
 * Format: {storage}/zeCache/queries/YYYY-MM-DD/
 */
export function getTodayCacheDir(): string
{
	const settings = CCSettings.getInstance();
	const today = DateTime.now().toFormat('yyyy-MM-dd');
	return join(settings.storage, CACHE_SUBDIR, today);
}

/**
 * Searches today's cache directory for a file matching the given query hash.
 * Returns the full file path if found, null otherwise.
 *
 * Extracts hash from filename by parsing: {prefix}--{hash}.json
 */
export function findCachedResponse(queryHash: string): string | null
{
	const cacheDir = getTodayCacheDir();
	if (!existsSync(cacheDir)) return null;

	const files = readdirSync(cacheDir);
	for (const file of files)
	{
		if (!file.endsWith('.json')) continue;

		const dashPos = file.lastIndexOf('--');
		const jsonPos = file.lastIndexOf('.json');

		if (dashPos !== -1 && jsonPos > dashPos)
		{
			const fileHash = file.slice(dashPos + 2, jsonPos);
			if (fileHash === queryHash)
			{
				return join(cacheDir, file);
			}
		}
	}

	return null;
}

/**
 * Reads and parses a cached response from disk.
 */
export function readCachedResponse<T>(filePath: string): T
{
	const content = readFileSync(filePath, 'utf-8');
	return JSON.parse(content) as T;
}

/**
 * Writes a response to the cache directory.
 * Creates the directory structure if it doesn't exist.
 * Filename format: {sanitized-query-prefix}--{hash}.json
 */
export function writeCachedResponse(query: string, response: unknown, filenamePrefix?: string): void
{
	const cacheDir = getTodayCacheDir();
	if (!existsSync(cacheDir))
	{
		mkdirSync(cacheDir, { recursive: true });
	}

	const prefix = filenamePrefix ?? sanitizeQueryForFilename(query);
	const hash = computeQueryHash(query);
	const filename = `${prefix}--${hash}.json`;
	const filePath = join(cacheDir, filename);

	writeFileSync(filePath, JSON.stringify(response, null, 2));
}

/**
 * Builds a human-readable filename prefix for a cache file.
 * Structure: {endpoint}-{sanitized-searchTerms}[--from-{date}][--lim-{N}]
 * The endpoint type and search terms are always included; date and limit
 * are appended only when present, making cache files browsable on disk.
 *
 * @param endpoint - Short endpoint label ('msg' or 'thr')
 * @param searchTerms - The full-text search query (or field descriptor)
 * @param options - Optional date and limit suffixes
 */
export function buildCacheFilenamePrefix(
	endpoint: string,
	searchTerms: string,
	options?: { fromDate?: string; limit?: number }
): string
{
	let prefix = `${endpoint}-${sanitizeQueryForFilename(searchTerms)}`;
	if (options?.fromDate) prefix += `--from-${options.fromDate}`;
	if (options?.limit && options.limit > 0) prefix += `--lim-${options.limit}`;
	return prefix;
}

/**
 * Builds a deterministic cache key from search parameters.
 * Combines a prefix (endpoint type), search terms, and optional filters
 * into a single string suitable for hashing.
 *
 * @param prefix - Endpoint identifier (e.g. 'msg', 'thr')
 * @param searchTerms - The full-text search query
 * @param options - Optional field filters and constraints
 */
export function buildSearchCacheKey(
	prefix: string,
	searchTerms: string,
	options?: {
		symbols?: string;
		subject?: string;
		fromDate?: string;
		projects?: Array<{ harness: string; project: string }>;
		limit?: number;
	}
): string
{
	const parts = [prefix, searchTerms];
	if (options?.symbols) parts.push(`sym:${options.symbols}`);
	if (options?.subject) parts.push(`sub:${options.subject}`);
	if (options?.fromDate) parts.push(`from:${options.fromDate}`);
	if (options?.projects?.length)
	{
		const sorted = options.projects
			.map((p) => `${p.harness}::${p.project}`)
			.sort()
			.join(',');
		parts.push(`proj:${sorted}`);
	}
	if (options?.limit !== undefined && options.limit > 0) parts.push(`lim:${options.limit}`);
	return parts.join('|');
}

/**
 * Checks whether a cached file is older than the specified maximum age.
 */
function isCacheStale(filePath: string, maxAgeMs: number): boolean
{
	const mtime = statSync(filePath).mtimeMs;
	return Date.now() - mtime > maxAgeMs;
}

/**
 * Convenience wrapper for endpoint handlers.
 * Checks cache for existing response, returns it if found.
 * Otherwise, computes the response, caches it, and returns it.
 * Supports both sync and async compute functions.
 *
 * Can be disabled via DISABLE_SEARCH_CACHE env var for debugging.
 *
 * @param query - The query string to use as cache key
 * @param compute - Function (sync or async) that computes the actual response
 * @param filenamePrefix - Optional human-readable prefix for the cache filename
 * @param maxAgeMs - Optional maximum age in milliseconds. When set, cached files
 *                   older than this are considered stale and recomputed.
 * @returns Object with data and cached flag
 */
export async function withCache<T>(
	query: string,
	compute: () => T | Promise<T>,
	filenamePrefix?: string,
	maxAgeMs?: number
): Promise<{ data: T; cached: boolean }>
{
	const settings = CCSettings.getInstance();

	// Skip cache entirely if disabled (useful for debugging)
	if (settings.DISABLE_SEARCH_CACHE)
	{
		const data = await compute();
		return { data, cached: false };
	}

	const hash = computeQueryHash(query);
	const cachedPath = findCachedResponse(hash);

	if (cachedPath)
	{
		// If maxAgeMs is set, check file freshness before returning cached data
		if (maxAgeMs !== undefined && isCacheStale(cachedPath, maxAgeMs))
		{
			const data = await compute();
			writeCachedResponse(query, data, filenamePrefix);
			return { data, cached: false };
		}
		return { data: readCachedResponse<T>(cachedPath), cached: true };
	}

	const data = await compute();
	writeCachedResponse(query, data, filenamePrefix);
	return { data, cached: false };
}
