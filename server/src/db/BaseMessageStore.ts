import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { AgentMessage } from "../models/AgentMessage.js";
import type { IMessageStore, MessageQueryFilters, MessageQueryResult, SessionSummary } from "./IMessageStore.js";

/**
 * Abstract base for in-memory and on-disk SQLite message stores.
 * Holds the shared schema, indexes, query methods, and serialization helpers.
 * Subclasses provide the Database instance and override loadFromStorage() as needed.
 */
export abstract class BaseMessageStore implements IMessageStore
{
	protected readonly db: Database;

	protected constructor(db: Database)
	{
		this.db = db;
		this.createSchema();
	}

	// ─── Schema ─────────────────────────────────────────────────────────────────

	private createSchema(): void
	{
		this.db.run(`
      CREATE TABLE IF NOT EXISTS AgentMessages (
        id          TEXT PRIMARY KEY,
        sessionId   TEXT NOT NULL,
        harness     TEXT NOT NULL,
        machine     TEXT NOT NULL,
        role        TEXT NOT NULL,
        model       TEXT,
        message     TEXT NOT NULL,
        subject     TEXT NOT NULL,
        context     TEXT NOT NULL,
        symbols     TEXT NOT NULL,
        history     TEXT NOT NULL,
        tags        TEXT NOT NULL,
        project     TEXT NOT NULL,
        parentId    TEXT,
        tokenUsage  TEXT,
        toolCalls   TEXT NOT NULL,
        rationale   TEXT NOT NULL,
        source      TEXT NOT NULL DEFAULT '',
        dateTime    TEXT NOT NULL,
        length      INTEGER NOT NULL DEFAULT 0
      )
    `);

		// ─── Single-column indexes ───────────────────────────────────────────────
		this.db.run("CREATE INDEX IF NOT EXISTS idx_agent_sessionId ON AgentMessages(sessionId)");
		this.db.run("CREATE INDEX IF NOT EXISTS idx_agent_harness   ON AgentMessages(harness)");
		this.db.run("CREATE INDEX IF NOT EXISTS idx_agent_role      ON AgentMessages(role)");
		this.db.run("CREATE INDEX IF NOT EXISTS idx_agent_model     ON AgentMessages(model)");
		this.db.run("CREATE INDEX IF NOT EXISTS idx_agent_dateTime  ON AgentMessages(dateTime)");
		this.db.run("CREATE INDEX IF NOT EXISTS idx_agent_project   ON AgentMessages(project)");
		this.db.run("CREATE INDEX IF NOT EXISTS idx_agent_subject   ON AgentMessages(subject)");
		this.db.run("CREATE INDEX IF NOT EXISTS idx_agent_machine   ON AgentMessages(machine)");

		// ─── Compound indexes for common filter + date-range patterns ────────────
		// Covers getBySessionId() WHERE sessionId = ? ORDER BY dateTime ASC
		this.db.run("CREATE INDEX IF NOT EXISTS idx_agent_session_dt  ON AgentMessages(sessionId, dateTime)");
		// Covers queryMessages() with harness + dateTime range filter
		this.db.run("CREATE INDEX IF NOT EXISTS idx_agent_harness_dt  ON AgentMessages(harness, dateTime)");
		// Covers queryMessages() with project + dateTime range filter
		this.db.run("CREATE INDEX IF NOT EXISTS idx_agent_project_dt  ON AgentMessages(project, dateTime)");
		// Covers queryMessages() with role + dateTime range filter
		this.db.run("CREATE INDEX IF NOT EXISTS idx_agent_role_dt     ON AgentMessages(role, dateTime)");
	}

	// ─── Insert ──────────────────────────────────────────────────────────────────

	/**
	 * Inserts one AgentMessage row, ignoring duplicates by id.
	 * @returns true if the row was newly inserted, false if it was a duplicate.
	 */
	protected insertMessage(message: AgentMessage): boolean
	{
		if (!message.sessionId || !message.id)
		{
			return false;
		}
		const result = this.db
			.query(
				`INSERT OR IGNORE INTO AgentMessages (
          id, sessionId, harness, machine, role, model, message, subject, context, symbols, history, tags,
          project, parentId, tokenUsage, toolCalls, rationale, source, dateTime, length
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				message.id,
				message.sessionId,
				message.harness,
				message.machine,
				message.role,
				message.model,
				message.message,
				message.subject,
				JSON.stringify(message.context),
				JSON.stringify(message.symbols),
				JSON.stringify(message.history),
				JSON.stringify(message.tags),
				message.project,
				message.parentId,
				message.tokenUsage ? JSON.stringify(message.tokenUsage) : null,
				JSON.stringify(message.toolCalls),
				JSON.stringify(message.rationale),
				message.source,
				message.dateTime.toISO() ?? "",
				message.length
			);
		return (result.changes as number) > 0;
	}

	// ─── IMessageStore ───────────────────────────────────────────────────────────

	close(): void
	{
		this.db.close();
	}

	addMessages(messages: Array<AgentMessage>): number
	{
		let inserted = 0;
		for (const message of messages)
		{
			if (this.insertMessage(message))
			{
				inserted += 1;
			}
		}
		return inserted;
	}

	/**
	 * Recursively discovers JSON session files under a storage root.
	 * @param root - Root directory to scan.
	 */
	protected collectJsonFiles(root: string): Array<string>
	{
		const files: Array<string> = [];
		if (!existsSync(root))
		{
			return files;
		}

		const shouldSkipDirectory = (name: string): boolean =>
		{
			if (!name)
			{
				return false;
			}

			const lower = name.toLowerCase();
			return lower.endsWith("-raw") || lower.startsWith("zzzcache") || lower.startsWith("zesettings");
		};

		const stack = [root];
		while (stack.length > 0)
		{
			const current = stack.pop() as string;
			let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
			try
			{
				entries = readdirSync(current, { withFileTypes: true, encoding: "utf8" });
			} catch
			{
				continue;
			}

			for (const entry of entries)
			{
				const fullPath = join(current, entry.name);
				if (entry.isDirectory())
				{
					if (shouldSkipDirectory(entry.name))
					{
						continue;
					}
					stack.push(fullPath);
				} else if (entry.isFile() && entry.name.endsWith(".json"))
				{
					files.push(fullPath);
				}
			}
		}

		return files;
	}

	loadFromStorage(storagePath: string): number
	{
		const files = this.collectJsonFiles(storagePath);
		let loaded = 0;

		for (const filePath of files)
		{
			try
			{
				const raw = JSON.parse(readFileSync(filePath, "utf-8")) as Array<unknown>;
				for (const row of raw)
				{
					const message = AgentMessage.deserialize(row);
					this.insertMessage(message);
					loaded += 1;
				}
			} catch
			{
				// Skip malformed session files and continue ingestion.
			}
		}

		console.log(`[MessageDB] Loaded ${loaded} messages from storage.`);
		return loaded;
	}

	// ─── Row mapping ─────────────────────────────────────────────────────────────

	protected mapRowToMessage(row: Record<string, unknown>): AgentMessage
	{
		return AgentMessage.deserialize({
			id: row.id,
			sessionId: row.sessionId,
			harness: row.harness,
			machine: row.machine,
			role: row.role,
			model: row.model,
			message: row.message,
			subject: row.subject,
			context: JSON.parse((row.context as string) ?? "[]"),
			symbols: JSON.parse((row.symbols as string) ?? "[]"),
			history: JSON.parse((row.history as string) ?? "[]"),
			tags: JSON.parse((row.tags as string) ?? "[]"),
			project: row.project,
			parentId: row.parentId,
			tokenUsage: row.tokenUsage ? JSON.parse(row.tokenUsage as string) : null,
			toolCalls: JSON.parse((row.toolCalls as string) ?? "[]"),
			rationale: JSON.parse((row.rationale as string) ?? "[]"),
			source: (row.source as string) ?? "",
			dateTime: row.dateTime,
			length: row.length as number,
		});
	}

	// ─── Queries ─────────────────────────────────────────────────────────────────

	getById(id: string): AgentMessage | null
	{
		const row = this.db.query("SELECT * FROM AgentMessages WHERE id = ?").get(id) as Record<string, unknown> | null;
		if (!row)
		{
			return null;
		}
		return this.mapRowToMessage(row);
	}

	getBySessionId(sessionId: string): Array<AgentMessage>
	{
		const rows = this.db
			.query("SELECT * FROM AgentMessages WHERE sessionId = ? ORDER BY dateTime ASC")
			.all(sessionId) as Array<Record<string, unknown>>;
		return rows.map((row) => this.mapRowToMessage(row));
	}

	listSessions(): Array<SessionSummary>
	{
		return this.db
			.query(
				`SELECT
          sessionId as sessionId,
          COUNT(*) as count,
          MIN(dateTime) as firstDateTime,
          MAX(dateTime) as lastDateTime,
          MIN(harness) as harness
        FROM AgentMessages
        WHERE sessionId IS NOT NULL AND LENGTH(sessionId) > 0
        GROUP BY sessionId
        ORDER BY MAX(dateTime) DESC`
			)
			.all() as Array<SessionSummary>;
	}

	getAllMessages(): Array<AgentMessage>
	{
		const rows = this.db
			.query("SELECT * FROM AgentMessages ORDER BY dateTime DESC")
			.all() as Array<Record<string, unknown>>;
		return rows.map((row) => this.mapRowToMessage(row));
	}

	getHarnessCounts(): Array<{ harness: string; count: number }>
	{
		return this.db
			.query("SELECT harness, COUNT(*) as count FROM AgentMessages GROUP BY harness ORDER BY count DESC")
			.all() as Array<{ harness: string; count: number }>;
	}

	getHarnessDateRanges(): Array<{ harness: string; earliest: string; latest: string; count: number }>
	{
		return this.db
			.query(
				`SELECT harness,
					MIN(dateTime) as earliest,
					MAX(dateTime) as latest,
					COUNT(*) as count
				FROM AgentMessages
				GROUP BY harness
				ORDER BY latest DESC`
			)
			.all() as Array<{ harness: string; earliest: string; latest: string; count: number }>;
	}

	getProjectsByHarness(): Array<{ harness: string; projects: Array<string> }>
	{
		const rows = this.db
			.query(
				"SELECT DISTINCT harness, project FROM AgentMessages ORDER BY harness ASC, project ASC"
			)
			.all() as Array<{ harness: string; project: string }>;

		const map = new Map<string, Array<string>>();
		for (const row of rows)
		{
			const harness = typeof row.harness === "string" ? row.harness.trim() : "";
			const project = typeof row.project === "string" ? row.project.trim() : "";

			if (!harness || !project) continue;

			const list = map.get(harness);
			if (list)
			{
				if (!list.includes(project)) list.push(project);
			} else
			{
				map.set(harness, [project]);
			}
		}

		return Array.from(map.entries()).map(([harness, projects]) => ({ harness, projects }));
	}

	getMessageCount(): number
	{
		const row = this.db.query("SELECT COUNT(*) as total FROM AgentMessages").get() as { total: number };
		return Number(row?.total ?? 0);
	}

	queryMessages(filters: MessageQueryFilters): MessageQueryResult
	{
		const whereParts: Array<string> = [];
		const params: Array<string> = [];

		if (filters.role)
		{
			whereParts.push("role = ?");
			params.push(filters.role);
		}
		if (filters.harness)
		{
			whereParts.push("harness = ?");
			params.push(filters.harness);
		}
		if (filters.model)
		{
			whereParts.push("model = ?");
			params.push(filters.model);
		}
		if (filters.project)
		{
			whereParts.push("project = ?");
			params.push(filters.project);
		}
		if (filters.subject)
		{
			whereParts.push("subject = ?");
			params.push(filters.subject);
		}
		if (filters.from)
		{
			whereParts.push("dateTime >= ?");
			params.push(filters.from);
		}
		if (filters.to)
		{
			whereParts.push("dateTime <= ?");
			params.push(filters.to);
		}

		const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";
		const page = Math.max(1, filters.page ?? 1);
		const pageSize = Math.max(1, filters.pageSize ?? 50);
		const offset = (page - 1) * pageSize;

		const totalRow = this.db
			.query(`SELECT COUNT(*) as total FROM AgentMessages ${whereClause}`)
			.get(...params) as { total: number };

		const rows = this.db
			.query(
				`SELECT * FROM AgentMessages
         ${whereClause}
         ORDER BY dateTime DESC
         LIMIT ? OFFSET ?`
			)
			.all(...params, pageSize, offset) as Array<Record<string, unknown>>;

		return {
			total: Number(totalRow?.total ?? 0),
			page,
			results: rows.map((row) => this.mapRowToMessage(row)),
		};
	}
}
