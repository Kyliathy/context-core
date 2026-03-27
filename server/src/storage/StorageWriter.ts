import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { DateTime } from "luxon";
import { extractMessageSymbols, generateFilenameSubject, generateSubject } from "../analysis/SubjectGenerator.js";
import { AgentMessage } from "../models/AgentMessage.js";
import { buildYYYYMM, sanitizeFilename } from "../utils/pathHelpers.js";

/**
 * Storage writer for persisting normalized session messages to disk.
 */
export class StorageWriter
{
  private readonly storageRoot: string;
  /** Tracks sessionId → output file path for intra-run dedup. */
  private readonly sessionPathCache = new Map<string, string>();

  /**
   * Creates a storage writer bound to the configured storage root.
   * @param storageRoot - Root folder where machine/harness/project trees are created.
   */
  constructor(storageRoot: string)
  {
    this.storageRoot = storageRoot;
  }

  /**
   * Builds a lightweight filename subject until SubjectGenerator is added.
   * @param messages - Session message collection.
   */
  private deriveSubject(messages: Array<AgentMessage>): string
  {
    return generateSubject(messages);
  }

  /**
   * Builds the compact filename segment using 5 verbs and 5 symbols.
   * @param messages - Session message collection.
   */
  private deriveFilenameSubject(messages: Array<AgentMessage>): string
  {
    return generateFilenameSubject(messages);
  }

  /**
   * Chooses the representative session timestamp for folder and filename.
   * @param messages - Session messages.
   */
  private resolveSessionDateTime(messages: Array<AgentMessage>): DateTime
  {
    const first = messages[0]?.dateTime;
    if (first && first.isValid)
    {
      return first;
    }
    return DateTime.now();
  }

  /**
   * Writes one session JSON file in `{storage}/{machine}/{harness}/{project}/{YYYY-MM}/`.
   * Always sets `message.subject` and `message.symbols` on all messages (even when skipping the write).
   * @param messages - Session AgentMessages to serialize.
   * @param machine - Hostname/machine identifier.
   * @param harness - Harness name (`ClaudeCode`, `Kiro`, `VSCode`, `Cursor`).
   * @param project - Project/workspace folder segment.
   * @param overwrite - When true, overwrites the file if it already exists (for session updates).
   * @returns Output path when written, or existing path when skipped.
   */
  writeSession(
    messages: Array<AgentMessage>,
    machine: string,
    harness: string,
    project: string,
    overwrite = false
  ): string | null
  {
    if (messages.length === 0)
    {
      return null;
    }

    const dt = this.resolveSessionDateTime(messages);
    const sessionSubject = this.deriveSubject(messages);
    const filenameSubject = this.deriveFilenameSubject(messages);
    for (const message of messages)
    {
      message.subject = sessionSubject;
      message.symbols = extractMessageSymbols(message.message ?? "");
    }
    const monthFolder = buildYYYYMM(dt);
    const safeProject = sanitizeFilename(project || "project");
    const outputDir = join(this.storageRoot, machine, harness, safeProject, monthFolder);
    const fileName = `${dt.toFormat("yyyy-MM-dd HH-mm")} ${filenameSubject}.json`;
    const outputPath = join(outputDir, fileName);

    mkdirSync(outputDir, { recursive: true });

    // Session-level dedup: detect if the same session (by message IDs) was already
    // written under a different timestamp. This prevents duplicate files when the
    // source harness has no caching and timestamp resolution varies between runs.
    const sessionId = messages[0]?.sessionId ?? "";
    const cacheKey = `${harness}::${project}::${sessionId}`;
    const cachedPath = this.sessionPathCache.get(cacheKey);
    if (cachedPath && existsSync(cachedPath) && cachedPath !== outputPath)
    {
      if (!overwrite)
      {
        return cachedPath;
      }
    }

    // Scan the output directory for an existing file with the same subject but
    // different timestamp prefix (i.e. same session written on a prior run).
    const existingDuplicate = this.findExistingSessionFile(outputDir, filenameSubject, fileName);
    if (existingDuplicate)
    {
      // Verify it actually contains the same session by checking message IDs.
      if (this.isSameSession(existingDuplicate, messages))
      {
        this.sessionPathCache.set(cacheKey, existingDuplicate);
        if (!overwrite)
        {
          return existingDuplicate;
        }
        // When overwriting, remove the stale file if its timestamp differs
        // so we don't accumulate duplicates.
        if (existingDuplicate !== outputPath)
        {
          try { unlinkSync(existingDuplicate); } catch { /* ignore */ }
        }
      }
    }

    if (!overwrite && existsSync(outputPath))
    {
      this.sessionPathCache.set(cacheKey, outputPath);
      return outputPath;
    }

    const serialized = messages.map((message) => message.serialize());
    writeFileSync(outputPath, JSON.stringify(serialized, null, 2), "utf-8");
    this.sessionPathCache.set(cacheKey, outputPath);
    return outputPath;
  }

  /**
   * Scans a directory for an existing file with the same subject suffix
   * but a different datetime prefix.
   */
  private findExistingSessionFile(dir: string, filenameSubject: string, currentFileName: string): string | null
  {
    try
    {
      const suffix = ` ${filenameSubject}.json`;
      const files = readdirSync(dir);
      for (const file of files)
      {
        if (file !== currentFileName && file.endsWith(suffix))
        {
          return join(dir, file);
        }
      }
    } catch
    {
      // Directory may not exist yet.
    }
    return null;
  }

  /**
   * Checks whether an existing file contains the same session by comparing
   * the set of message IDs in the file against the incoming messages.
   */
  private isSameSession(filePath: string, messages: Array<AgentMessage>): boolean
  {
    try
    {
      const raw = readFileSync(filePath, "utf-8");
      const existing = JSON.parse(raw) as Array<{ id?: string; sessionId?: string }>;
      if (!Array.isArray(existing) || existing.length === 0)
      {
        return false;
      }
      // Quick check: same sessionId on first message.
      if (existing[0].sessionId === messages[0]?.sessionId)
      {
        return true;
      }
      // Fallback: check if message IDs overlap.
      const incomingIds = new Set(messages.map((m) => m.id));
      return existing.some((e) => e.id && incomingIds.has(e.id));
    } catch
    {
      return false;
    }
  }
}
