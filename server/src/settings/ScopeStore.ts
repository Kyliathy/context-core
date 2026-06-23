/**
 * ScopeStore — persistence layer for visualizer saved scopes.
 * Stores scope entries in .settings/scopes.json.
 *
 * Architecture: server/zz-reach2/architecture/archi-context-core-level0.md
 * Logging: server/zz-reach2/upgrades/2026-06/r2wl-winston-logging.md
 */

import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { getLogger } from "../logging/logger.js";
import type { ScopeEntry } from "../models/ScopeEntry.js";

const logger = getLogger("settings:ScopeStore");

export class ScopeStore
{
  private readonly settingsDir: string;
  private readonly scopesFilePath: string;
  private entries: ScopeEntry[];

  /**
   * Creates a ScopeStore instance.
   * @param storagePath - Root storage directory (e.g., "d:\\Codez\\Nexus\\design\\CXC")
   */
  constructor(storagePath: string)
  {
    this.settingsDir = join(storagePath, ".settings");
    this.scopesFilePath = join(this.settingsDir, "scopes.json");
    this.entries = [];

    if (!existsSync(this.settingsDir))
    {
      mkdirSync(this.settingsDir, { recursive: true });
    }
  }

  /**
   * Loads scopes from scopes.json.
   * If missing or invalid, starts with an empty list.
   */
  load(): void
  {
    if (!existsSync(this.scopesFilePath))
    {
      this.entries = [];
      return;
    }

    try
    {
      const fileContent = readFileSync(this.scopesFilePath, "utf-8");
      const entriesArray = JSON.parse(fileContent) as ScopeEntry[];
      this.entries = Array.isArray(entriesArray) ? entriesArray : [];
    }
    catch (error)
    {
      logger.warn(
        `Failed to parse scopes.json: ${(error as Error).message}. Starting with empty list.`
      );
      this.entries = [];
    }
  }

  /**
   * Saves all scopes to scopes.json.
   */
  save(): void
  {
    const jsonContent = JSON.stringify(this.entries, null, 2);
    writeFileSync(this.scopesFilePath, jsonContent, "utf-8");
  }

  /**
   * Returns all stored scopes.
   */
  list(): ScopeEntry[]
  {
    return this.entries;
  }

  /**
   * Replaces all stored scopes in memory.
   * @param scopes - Full scope list to store.
   */
  replaceAll(scopes: ScopeEntry[]): void
  {
    this.entries = scopes;
  }
}
