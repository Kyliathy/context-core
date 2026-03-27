/**
 * TopicSummarizer – orchestrates AI summarization for all sessions.
 * Builds context from session messages, calls the AI model, and persists results
 * to TopicStore. Skips sessions already summarized. Saves after each success
 * so partial progress survives interruptions.
 *
 * Supports two passes:
 *   Pass 1 (runPipeline): summarize sessions with no aiSummary yet.
 *   Pass 2 (runPass2):    re-summarize sessions whose aiSummary exceeds a char limit,
 *                         using a smarter model to produce tighter output.
 */

import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { buildContext } from "./TopicContextBuilder.js";
import type { TopicStore } from "../settings/TopicStore.js";
import type { IMessageStore } from "../db/IMessageStore.js";
import type { TopicEntry } from "../models/TopicEntry.js";

/** Minimum number of user turns before a session is worth summarizing. */
const MIN_USER_MESSAGES = 3;
/** Minimum session age in days before it is eligible for summarization. */
const MIN_AGE_DAYS = 2;
const TWO_DAYS_MS = MIN_AGE_DAYS * 24 * 60 * 60 * 1000;

/**
 * Returns true if a session is mature enough to be worth summarizing.
 * A session qualifies when it is at least 2 days old OR has at least 3 user messages.
 */
export function isReadyForSummarization(firstDateTimeIso: string, userMessageCount: number): boolean
{
	const ageMs = Date.now() - Date.parse(firstDateTimeIso);
	if (ageMs >= TWO_DAYS_MS) return true;
	return userMessageCount >= MIN_USER_MESSAGES;
}

/** Threshold: summaries shorter than this are condensed from the existing text rather than rebuilt from the full chat. */
const CONDENSE_THRESHOLD_CHARS = 3000;

const CONDENSE_PROMPT_PREFIX =
	"The following AI-generated summary is too long. Condense it to at most 5 sentences and 500 characters. " +
	"Preserve all technical content. Cut all filler, articles, and prepositions. Tech-speak only. " +
	"Return only the condensed summary — no intro, no explanation, no extra text.\n\n";

const SUMMARIZATION_PROMPT_PREFIX =
	"You are a ruthlessly efficient summarization engine for AI-human chat sessions. " +
	"Please summarize what this chat is about, in maximum 10 sentences. Do not cheat more content by using semicolons to extend content. " +
	"You will only add all 10 sentences when the chat is very long. " +
	"Avoid useless and superfluous chat intros." +
	"Do NOT use phrasing such as 'Chat is' or 'Chat does' or 'The chat documents' or 'The chat chronicles' or 'Chat covers' or 'This chat discusses' any such formulation. " +
	"Do NOT start with 'The user requests' or 'user requested' or 'user asked' or any such formulation. " +
	"'The user' knows what they're doing and this summary you will write is intended for that user, so it is weird to mention them. " +
	"All these are superflous. You MUST get straight to the point. " +
	"Do not use fluff words. Save on prepositions and articles. Tech-speak! Do not add break-lines between sentences. One single paragraph. " +
	"You MUST NEVER RETURN MORE THAN 10 SENTENCES. YOU MUST NEVER RETURN MORE THAN 2000 CHARACTERS. Keep it concise. " +
	"You MUST respect all the above rules.\n" +
	"Here is the chat:\n\n";

const DEFAULT_DELAY_MS = 300;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1000, 2000, 4000];

export class TopicSummarizer
{
	private readonly topicStore: TopicStore;
	private readonly messageDB: IMessageStore;
	private readonly delayMs: number;
	private readonly modelName: string;

	constructor(
		topicStore: TopicStore,
		messageDB: IMessageStore,
		delayMs = DEFAULT_DELAY_MS,
		modelName = "gpt-5-nano"
	)
	{
		this.topicStore = topicStore;
		this.messageDB = messageDB;
		this.delayMs = delayMs;
		this.modelName = modelName;
	}

	/**
	 * Summarizes a single session. Builds context from its messages, calls the
	 * AI model, and returns a TopicEntry. Returns null on failure.
	 */
	async summarizeSession(sessionId: string): Promise<TopicEntry | null>
	{
		const messages = this.messageDB.getBySessionId(sessionId);
		if (messages.length === 0)
		{
			return null;
		}

		const { text: contextText, charsSent } = await buildContext(messages);
		if (!contextText)
		{
			return null;
		}

		const prompt = SUMMARIZATION_PROMPT_PREFIX + contextText;

		try
		{
			const result = await this.withRetry(
				() => generateText({ model: openai(this.modelName), prompt }),
				sessionId
			);

			return {
				sessionId,
				charsSent,
				aiSummary: result.text.trim(),
				customTopic: "",
			};
		} catch (error)
		{
			console.warn(
				`[Topics] Failed to summarize session ${sessionId}: ${(error as Error).message}`
			);
			return null;
		}
	}

	/**
	 * Processes all sessions not yet in the topic store.
	 * Persists each successful result immediately for crash resilience.
	 */
	async runPipeline(): Promise<void>
	{
		const allSessions = this.messageDB.listSessions();
		let summarizedSkips = 0;
		let customTopicSkips = 0;
		let tooYoungSkips = 0;

		const pending = allSessions.filter((s) =>
		{
			const entry = this.topicStore.getBySessionId(s.sessionId);
			if (entry)
			{
				const hasAiSummary = entry.aiSummary.trim().length > 0;
				const hasCustomTopic = entry.customTopic.trim().length > 0;

				if (hasCustomTopic)
				{
					customTopicSkips++;
				}
				else if (hasAiSummary)
				{
					summarizedSkips++;
				}

				if (this.topicStore.shouldSkipSummarization(s.sessionId))
				{
					return false;
				}
			}

			// Readiness gate: skip sessions that are too new and too short to be worth summarizing.
			// Age check is free (from SessionSummary). Only fetch messages when age gate fails.
			const ageMs = Date.now() - Date.parse(s.firstDateTime);
			if (ageMs < TWO_DAYS_MS)
			{
				const messages = this.messageDB.getBySessionId(s.sessionId);
				const userCount = messages.filter(m => m.role === "user").length;
				if (userCount < MIN_USER_MESSAGES)
				{
					tooYoungSkips++;
					return false;
				}
			}

			return true;
		});
		const total = allSessions.length;

		console.log(
			`[Topics] Starting summarization pipeline: ${pending.length} to process, ` +
			`${summarizedSkips} already summarized, ${customTopicSkips} custom-named, ` +
			`${tooYoungSkips} too young (${total} total)`
		);

		let summarized = 0;
		let errors = 0;

		for (let i = 0; i < pending.length; i++)
		{
			const session = pending[i];

			const entry = await this.summarizeSession(session.sessionId);

			if (entry)
			{
				this.topicStore.upsert(entry);
				this.topicStore.save();
				summarized++;
				const preview = entry.aiSummary.length > 80
					? entry.aiSummary.slice(0, 80) + "…"
					: entry.aiSummary;
				console.log(`[Topics] [${i + 1}/${pending.length}] ${session.sessionId} → "${preview}"`);
			} else
			{
				errors++;
				console.log(`[Topics] [${i + 1}/${pending.length}] ${session.sessionId} → (failed)`);
			}

			// Progress log every 10 sessions and at the very end
			if ((i + 1) % 10 === 0 || i === pending.length - 1)
			{
				console.log(
					`[Topics] Progress: ${summarized}/${pending.length} summarized (${errors} errors)`
				);
			}

			// Rate-limit delay between calls (skip after last item)
			if (i < pending.length - 1)
			{
				await new Promise((resolve) => setTimeout(resolve, this.delayMs));
			}
		}

		console.log(
			`[Topics] Pipeline complete: ${summarized} summarized, ${summarizedSkips} already summarized, ` +
			`${customTopicSkips} custom-named, ${tooYoungSkips} too young, ${errors} errors`
		);
	}

	/**
	 * Pass 2: re-summarizes sessions whose aiSummary exceeds maxSummaryChars.
	 * Routes each candidate by length:
	 *   - aiSummary < CONDENSE_THRESHOLD_CHARS: condenses the existing summary text (cheap).
	 *   - aiSummary >= CONDENSE_THRESHOLD_CHARS: rebuilds from full chat context.
	 * Skips sessions with a customTopic — those are never auto-modified.
	 * Persists each result immediately for crash resilience.
	 */
	async runPass2(maxSummaryChars: number): Promise<void>
	{
		const candidates = this.topicStore.getVerboseEntries(maxSummaryChars);

		console.log(
			`[Topics/Pass2] Starting pass 2 re-summarization (model: ${this.modelName}): ${candidates.length} sessions with aiSummary > ${maxSummaryChars} chars`
		);

		if (candidates.length === 0)
		{
			console.log("[Topics/Pass2] Nothing to re-summarize.");
			return;
		}

		let resimmarized = 0;
		let errors = 0;

		for (let i = 0; i < candidates.length; i++)
		{
			const candidate = candidates[i];
			const oldLen = candidate.aiSummary.length;

			// Short-enough summaries are condensed directly from their existing text —
			// no need to rebuild context from the full chat.
			const useCondense = oldLen < CONDENSE_THRESHOLD_CHARS;
			const newSummary = useCondense
				? await this.condenseSummary(candidate.sessionId, candidate.aiSummary)
				: await this.summarizeSession(candidate.sessionId);

			const entry: TopicEntry | null = typeof newSummary === "string"
				? { ...candidate, aiSummary: newSummary }
				: newSummary
					? { ...newSummary, customTopic: candidate.customTopic }
					: null;

			if (entry)
			{
				this.topicStore.upsert(entry);
				this.topicStore.save();
				resimmarized++;
				const strategy = useCondense ? "condense" : "rebuild";
				console.log(
					`[Topics/Pass2] [${i + 1}/${candidates.length}] ${candidate.sessionId} → ${oldLen} → ${entry.aiSummary.length} chars (${strategy})`
				);
			} else
			{
				errors++;
				console.log(
					`[Topics/Pass2] [${i + 1}/${candidates.length}] ${candidate.sessionId} → (failed)`
				);
			}

			// Progress log every 10 sessions and at the very end
			if ((i + 1) % 10 === 0 || i === candidates.length - 1)
			{
				console.log(
					`[Topics/Pass2] Progress: ${resimmarized}/${candidates.length} re-summarized (${errors} errors)`
				);
			}

			// Rate-limit delay between calls (skip after last item)
			if (i < candidates.length - 1)
			{
				await new Promise((resolve) => setTimeout(resolve, this.delayMs));
			}
		}

		console.log(
			`[Topics/Pass2] Complete: ${resimmarized} re-summarized, ${errors} errors`
		);
	}

	/**
	 * Condenses an existing summary that is too long, by sending only the summary
	 * text to the model. Much cheaper than rebuilding context from the full chat.
	 * Returns the condensed string, or null on failure.
	 */
	private async condenseSummary(sessionId: string, existingSummary: string): Promise<string | null>
	{
		const prompt = CONDENSE_PROMPT_PREFIX + existingSummary;
		try
		{
			const result = await this.withRetry(
				() => generateText({ model: openai(this.modelName), prompt }),
				sessionId
			);
			return result.text.trim();
		} catch (error)
		{
			console.warn(
				`[Topics/Pass2] Failed to condense session ${sessionId}: ${(error as Error).message}`
			);
			return null;
		}
	}

	/**
	 * Retries an async operation with exponential backoff on transient errors.
	 * Retries on 429 (rate limit) and 5xx (server errors) up to 3 times.
	 */
	private async withRetry<T>(
		operation: () => Promise<T>,
		context: string
	): Promise<T>
	{
		for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++)
		{
			try
			{
				return await operation();
			} catch (error)
			{
				const err = error as { status?: number; message?: string };
				const isTransient =
					err.status === 429 || (err.status !== undefined && err.status >= 500) || err.status === undefined;

				if (!isTransient || attempt === MAX_RETRY_ATTEMPTS - 1)
				{
					throw error;
				}

				const delay = RETRY_DELAYS_MS[attempt] ?? 4000;
				console.warn(
					`[Topics] Retrying session ${context} after ${delay}ms (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS}): ${err.message ?? error}`
				);
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}

		throw new Error("Retry loop exhausted unexpectedly");
	}
}
