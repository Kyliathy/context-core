/**
 * ContextCore – Antigravity harness.
 * Reads chat history from protobuf (.pb) files.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { DateTime } from "luxon";
import { AgentMessage } from "../models/AgentMessage.js";
import { generateMessageId } from "../utils/hashId.js";
import { sanitizeFilename } from "../utils/pathHelpers.js";
import { copyRawSourceFile } from "../utils/rawCopier.js";

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
      console.warn(`[Antigravity] Path not found: ${searchPath}`);
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

    console.log(`[Antigravity] Scanning ${files.length} .pb files in ${searchPath}`);

    for (const file of files) {
      console.log(`\n--- Inspecting: ${file} ---`);
      const buffer = readFileSync(file);
      
      // After extensive probing, we identified that the .pb files in this directory are 
      // NOT raw uncompressed protobuf nor standard compressed forms (gzip, brotli, zstd).
      // The entire byte sequence has high entropy and changes dramatically on every write, 
      // which strongly suggests the conversation data is encrypted (e.g., AES-GCM) where 
      // the leading bytes act as an Initialization Vector (IV).
      
      const rawText = buffer.toString("utf8");
      const stringMatches = rawText.match(/[\x20-\x7E\t\n\r]{15,}/g) || [];
      
      let messageCount = 0;
      for (let i = 0; i < stringMatches.length; i++) {
        const textChunk = stringMatches[i].trim();
        if (textChunk.length > 20 && textChunk.includes(" ")) {
          messageCount++;
          console.log(`[Antigravity] Message #${messageCount} in ${file}:\n${textChunk}\n`);
        }
      }

      if (messageCount === 0) {
        console.warn(`[Antigravity] No clear text messages found in ${file}.`);
        console.warn(`[Antigravity] The file data appears to be encrypted or compressed with an unknown algorithm.`);
        console.warn(`[Antigravity] We need the specific decryption key/method or a new reader strategy to parse the actual Protobuf schema.`);
      }
    }

  } catch (err) {
    if (err instanceof Error) {
      console.error(`[Antigravity] Error reading ${searchPath}: ${err.message}`);
    }
  }

  return messages;
}
