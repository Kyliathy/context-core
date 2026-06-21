/**
 * ContextCore – Antigravity harness.
 * Reads chat history from protobuf (.pb) files.
 *
 * Architecture: server/zz-reach2/architecture/archi-context-core-level0.md
 * Logging: server/zz-reach2/upgrades/2026-06/r2wl-winston-logging.md
 *
 * DISABLED in harness registry until protobuf decryption/parsing is implemented.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { DateTime } from "luxon";
import { getLogger } from "../logging/logger.js";
import { AgentMessage } from "../models/AgentMessage.js";
import { generateMessageId } from "../utils/hashId.js";
import { sanitizeFilename } from "../utils/pathHelpers.js";
import { copyRawSourceFile } from "../utils/rawCopier.js";

const logger = getLogger("harness:antigravity");

/**
 * Given an Antigravity .pb path, parses the history and produces normalized rows.
 * @param searchPath – Path to directory or .pb file
 * @param rawBase – Archiving root directory
 * @returns An array of parsed AgentMessages
 */
export function readAntigravityChats(
  searchPath: string,
  rawBase: string
): Array<AgentMessage> {
  // TODO: R2HA - Implement protobuf parsing using protobufjs here
  const messages: Array<AgentMessage> = [];

  try {
    if (!existsSync(searchPath)) {
      logger.warn(`Path not found: ${searchPath}`);
      return messages;
    }

    const stat = statSync(searchPath);
    const files = stat.isDirectory()
      ? readdirSync(searchPath)
          .filter((f) => f.endsWith(".pb"))
          .map((f) => join(searchPath, f))
      : searchPath.endsWith(".pb")
      ? [searchPath]
      : [];

    logger.debug(`Scanning ${files.length} .pb files in ${searchPath}`);
    // Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.


    for (const file of files) {
      logger.debug(`Inspecting: ${file}`);
      const buffer = readFileSync(file);
      
      // After extensive probing, we identified that the .pb files in this directory are 
      // NOT raw uncompressed protobuf nor standard compressed forms (gzip, brotli, zstd).
      // The entire byte sequence has high entropy and changes dramatically on every write, 
      // which strongly suggests the conversation data is encrypted (e.g., AES-GCM) where 
      // the leading bytes act as an Initialization Vector (IV).
      
      const rawText = buffer.toString("utf8");
      const stringMatches = rawText.match(/[\x20-\x7E\t\n\r]{15,}/g) || [];
      
      let messageCount = 0;
      // Business logic: this iteration walks every relevant item so harness ingest and source normalization reflects the complete source set instead of a partial snapshot.

      for (let i = 0; i < stringMatches.length; i++) {
        const textChunk = stringMatches[i].trim();
        // Business logic: this combined guard requires all relevant CXC preconditions before changing control flow, protecting harness ingest and source normalization from partial or invalid state.

        if (textChunk.length > 20 && textChunk.includes(" ")) {
          messageCount++;
          logger.silly(`Message #${messageCount} in ${file}:\n${textChunk}\n`);
        }
      }

      if (messageCount === 0) {
        logger.warn(`No clear text messages found in ${file}.`);
        logger.warn(`The file data appears to be encrypted or compressed with an unknown algorithm.`);
        logger.warn(`We need the specific decryption key/method or a new reader strategy to parse the actual Protobuf schema.`);
      }
    }

  } catch (err) {
    if (err instanceof Error) {
      logger.error(`Error reading ${searchPath}: ${err.message}`);
    }
  }

  return messages;
}
