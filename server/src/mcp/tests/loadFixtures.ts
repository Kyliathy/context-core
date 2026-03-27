import { DateTime } from "luxon";
import type { IMessageStore, MessageQueryFilters, MessageQueryResult, SessionSummary } from "../../db/IMessageStore.js";
import type { AgentMessage } from "../../models/AgentMessage.js";
import { AgentMessage as AgentMessageModel } from "../../models/AgentMessage.js";
import type { AgentThread } from "../../models/AgentThread.js";
import type { TopicEntry } from "../../models/TopicEntry.js";

type MessagesFixture = {
	results: Array<Record<string, unknown>>;
};

type ThreadsFixture = {
	total: number;
	page: number;
	results: Array<AgentThread>;
};

export async function loadMessagesFixture(): Promise<AgentMessage[]>
{
	const file = Bun.file(new URL("./messages_storyteller_nncharacter.json", import.meta.url));
	const data = (await file.json()) as MessagesFixture;
	return data.results.map((raw) => AgentMessageModel.deserialize(raw));
}

export async function loadThreadsFixture(): Promise<AgentThread[]>
{
	const file = Bun.file(new URL("./threads_latest.json", import.meta.url));
	const data = (await file.json()) as ThreadsFixture;
	return data.results;
}

class FixtureMessageStore implements IMessageStore
{
	private readonly messages: AgentMessage[];
	private readonly byId: Map<string, AgentMessage>;
	private readonly bySession: Map<string, AgentMessage[]>;

	constructor(messages: AgentMessage[])
	{
		this.messages = [...messages].sort((a, b) => a.dateTime.toMillis() - b.dateTime.toMillis());
		this.byId = new Map(this.messages.map((m) => [m.id, m]));
		this.bySession = new Map();

		for (const message of this.messages)
		{
			const arr = this.bySession.get(message.sessionId) ?? [];
			arr.push(message);
			this.bySession.set(message.sessionId, arr);
		}
	}

	close(): void { }

	addMessages(messages: AgentMessage[]): number
	{
		let inserted = 0;
		for (const message of messages)
		{
			if (this.byId.has(message.id)) continue;
			this.byId.set(message.id, message);
			this.messages.push(message);
			const arr = this.bySession.get(message.sessionId) ?? [];
			arr.push(message);
			this.bySession.set(message.sessionId, arr);
			inserted += 1;
		}
		this.messages.sort((a, b) => a.dateTime.toMillis() - b.dateTime.toMillis());
		return inserted;
	}

	loadFromStorage(_storagePath: string): number
	{
		return this.messages.length;
	}

	getById(id: string): AgentMessage | null
	{
		return this.byId.get(id) ?? null;
	}

	getBySessionId(sessionId: string): AgentMessage[]
	{
		return [...(this.bySession.get(sessionId) ?? [])].sort((a, b) => a.dateTime.toMillis() - b.dateTime.toMillis());
	}

	listSessions(): SessionSummary[]
	{
		const sessions: SessionSummary[] = [];
		for (const [sessionId, msgs] of this.bySession.entries())
		{
			const sorted = [...msgs].sort((a, b) => a.dateTime.toMillis() - b.dateTime.toMillis());
			sessions.push({
				sessionId,
				count: sorted.length,
				firstDateTime: sorted[0].dateTime.toISO() ?? "",
				lastDateTime: sorted[sorted.length - 1].dateTime.toISO() ?? "",
				harness: sorted[0].harness,
			});
		}
		return sessions.sort((a, b) => b.lastDateTime.localeCompare(a.lastDateTime));
	}

	getAllMessages(): AgentMessage[]
	{
		return [...this.messages];
	}

	getHarnessCounts(): Array<{ harness: string; count: number }>
	{
		const map = new Map<string, number>();
		for (const m of this.messages)
		{
			map.set(m.harness, (map.get(m.harness) ?? 0) + 1);
		}
		return Array.from(map.entries()).map(([harness, count]) => ({ harness, count }));
	}

	getHarnessDateRanges(): Array<{ harness: string; earliest: string; latest: string; count: number }>
	{
		const buckets = new Map<string, AgentMessage[]>();
		for (const m of this.messages)
		{
			const arr = buckets.get(m.harness) ?? [];
			arr.push(m);
			buckets.set(m.harness, arr);
		}

		return Array.from(buckets.entries()).map(([harness, msgs]) =>
		{
			const sorted = msgs.sort((a, b) => a.dateTime.toMillis() - b.dateTime.toMillis());
			return {
				harness,
				earliest: sorted[0].dateTime.toISO() ?? "",
				latest: sorted[sorted.length - 1].dateTime.toISO() ?? "",
				count: sorted.length,
			};
		});
	}

	queryMessages(filters: MessageQueryFilters): MessageQueryResult
	{
		const page = Math.max(1, filters.page ?? 1);
		const pageSize = Math.max(1, Math.min(50, filters.pageSize ?? 20));

		const from = filters.from ? DateTime.fromISO(filters.from) : undefined;
		const to = filters.to ? DateTime.fromISO(filters.to) : undefined;

		let filtered = this.messages.filter((m) =>
		{
			if (filters.role && m.role !== filters.role) return false;
			if (filters.harness && m.harness !== filters.harness) return false;
			if (filters.model && m.model !== filters.model) return false;
			if (filters.project && m.project !== filters.project) return false;
			if (filters.subject && !m.subject.toLowerCase().includes(filters.subject.toLowerCase())) return false;

			const ts = m.dateTime.toMillis();
			if (from?.isValid && ts < from.toMillis()) return false;
			if (to?.isValid && ts > to.toMillis()) return false;
			return true;
		});

		filtered = filtered.sort((a, b) => b.dateTime.toMillis() - a.dateTime.toMillis());

		const total = filtered.length;
		const start = (page - 1) * pageSize;
		const results = filtered.slice(start, start + pageSize);

		return { total, page, results };
	}

	getMessageCount(): number
	{
		return this.messages.length;
	}

	getProjectsByHarness(): Array<{ harness: string; projects: string[] }>
	{
		const map = new Map<string, Set<string>>();
		for (const m of this.messages)
		{
			const set = map.get(m.harness) ?? new Set<string>();
			set.add(m.project);
			map.set(m.harness, set);
		}

		return Array.from(map.entries())
			.map(([harness, projects]) => ({ harness, projects: Array.from(projects).sort() }))
			.sort((a, b) => a.harness.localeCompare(b.harness));
	}
}

class FixtureTopicStore
{
	private readonly entries = new Map<string, TopicEntry>();

	constructor(seed: TopicEntry[] = [])
	{
		for (const entry of seed)
		{
			this.entries.set(entry.sessionId, entry);
		}
	}

	getBySessionId(sessionId: string): TopicEntry | undefined
	{
		return this.entries.get(sessionId);
	}

	upsert(entry: TopicEntry): void
	{
		this.entries.set(entry.sessionId, entry);
	}

	load(): void { }

	save(): void { }
}

export async function buildMockDB(): Promise<IMessageStore>
{
	const messages = await loadMessagesFixture();
	return new FixtureMessageStore(messages);
}

export async function buildMockTopicStore(): Promise<FixtureTopicStore>
{
	const threads = await loadThreadsFixture();
	const entries: TopicEntry[] = threads.map((thread) => ({
		sessionId: thread.sessionId,
		charsSent: Math.min(1200, thread.subject.length),
		aiSummary: thread.subject,
		customTopic: "",
	}));

	return new FixtureTopicStore(entries);
}
