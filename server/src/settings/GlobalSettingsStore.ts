/**
 * GlobalSettingsStore - lightweight runtime metadata persisted under .settings.
 * Used for cross-run checkpoints (for example Cursor incremental rowid state).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export type CursorRowIdCheckpoint = {
	cursorDiskKVRowId: number;
	itemTableRowId: number;
};

type GlobalSettingsData = {
	cursor?: {
		lastQueriedAt?: string;
		cursorDiskKVRowId?: number;
		itemTableRowId?: number;
	};
};

const EMPTY_CURSOR_CHECKPOINT: CursorRowIdCheckpoint = {
	cursorDiskKVRowId: 0,
	itemTableRowId: 0,
};

export class GlobalSettingsStore
{
	private readonly settingsDir: string;
	private readonly filePath: string;
	private data: GlobalSettingsData = {};

	constructor(storagePath: string)
	{
		this.settingsDir = join(storagePath, ".settings");
		this.filePath = join(this.settingsDir, "global-settings.json");

		if (!existsSync(this.settingsDir))
		{
			mkdirSync(this.settingsDir, { recursive: true });
		}
	}

	load(): void
	{
		if (!existsSync(this.filePath))
		{
			this.data = {};
			return;
		}

		try
		{
			const raw = readFileSync(this.filePath, "utf-8");
			const parsed = JSON.parse(raw) as GlobalSettingsData;
			this.data = parsed && typeof parsed === "object" ? parsed : {};
		}
		catch (error)
		{
			console.warn(
				`[GlobalSettingsStore] Failed to parse global-settings.json: ${(error as Error).message}. Starting with empty settings.`
			);
			this.data = {};
		}
	}

	save(): void
	{
		writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
	}

	getCursorCheckpoint(): CursorRowIdCheckpoint
	{
		const cursor = this.data.cursor;
		const cursorDiskKVRowId =
			typeof cursor?.cursorDiskKVRowId === "number" && cursor.cursorDiskKVRowId > 0
				? Math.floor(cursor.cursorDiskKVRowId)
				: 0;
		const itemTableRowId =
			typeof cursor?.itemTableRowId === "number" && cursor.itemTableRowId > 0
				? Math.floor(cursor.itemTableRowId)
				: 0;

		return {
			cursorDiskKVRowId,
			itemTableRowId,
		};
	}

	setCursorCheckpoint(checkpoint: CursorRowIdCheckpoint): void
	{
		if (!this.data.cursor)
		{
			this.data.cursor = {};
		}

		this.data.cursor.cursorDiskKVRowId = Math.max(0, Math.floor(checkpoint.cursorDiskKVRowId));
		this.data.cursor.itemTableRowId = Math.max(0, Math.floor(checkpoint.itemTableRowId));
		this.save();
	}

	setCursorState(checkpoint: CursorRowIdCheckpoint, now: Date = new Date()): void
	{
		if (!this.data.cursor)
		{
			this.data.cursor = {};
		}

		this.data.cursor.cursorDiskKVRowId = Math.max(0, Math.floor(checkpoint.cursorDiskKVRowId));
		this.data.cursor.itemTableRowId = Math.max(0, Math.floor(checkpoint.itemTableRowId));
		this.data.cursor.lastQueriedAt = now.toISOString();
		this.save();
	}

	touchCursorLastQueriedAt(now: Date = new Date()): void
	{
		if (!this.data.cursor)
		{
			this.data.cursor = {};
		}

		this.data.cursor.lastQueriedAt = now.toISOString();
		this.save();
	}

	getCursorLastQueriedAt(): Date | null
	{
		const value = this.data.cursor?.lastQueriedAt;
		if (!value)
		{
			return null;
		}

		const parsed = new Date(value);
		if (Number.isNaN(parsed.getTime()))
		{
			return null;
		}

		return parsed;
	}

	resetCursorState(): void
	{
		this.data.cursor = {
			...EMPTY_CURSOR_CHECKPOINT,
		};
		this.save();
	}
}
