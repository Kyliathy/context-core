import { basename, extname, normalize } from "path";
import { DateTime } from "luxon";

/** Characters that are invalid in Windows filenames. */
const INVALID_FILENAME_CHARS = /[\\/:*?"<>|]/g;

/**
 * Sanitizes text into a filesystem-safe filename segment.
 * @param input - Raw subject or project name input.
 * @returns Safe filename segment limited to 120 characters.
 */
export function sanitizeFilename(input: string): string {
  const cleaned = input
    .replace(INVALID_FILENAME_CHARS, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();

  return (cleaned || "untitled").slice(0, 120);
}

/**
 * Derives a stable project name from harness identity and source path.
 * @param harnessName - Source harness name (ClaudeCode, Cursor, Kiro, VSCode).
 * @param sourcePath - Harness input path from configuration.
 * @returns Sanitized project name suitable for storage folders.
 */
export function deriveProjectName(harnessName: string, sourcePath: string): string {
  const normalized = normalize(sourcePath).replace(/[\\/]+$/, "");
  const pathBase = basename(normalized);

  if (harnessName === "Cursor") {
    if (extname(pathBase).toLowerCase() === ".vscdb") {
      return "global";
    }
    return sanitizeFilename(pathBase || "cursor");
  }

  if (harnessName === "ClaudeCode") {
    return sanitizeFilename(pathBase || "claude");
  }

  if (harnessName === "Kiro") {
    return sanitizeFilename(pathBase || "kiro");
  }

  if (harnessName === "VSCode") {
    return sanitizeFilename(pathBase || "vscode");
  }

  return sanitizeFilename(pathBase || harnessName);
}

/**
 * Builds the YYYY-MM folder name used in storage layout.
 * @param dt - Luxon DateTime for the message/session timestamp.
 * @returns Year-month string in YYYY-MM format.
 */
export function buildYYYYMM(dt: DateTime): string {
  return dt.toFormat("yyyy-MM");
}
