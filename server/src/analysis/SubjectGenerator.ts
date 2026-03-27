import winkNLP from "wink-nlp";
import model from "wink-eng-lite-web-model";
import { AgentMessage } from "../models/AgentMessage.js";
import { sanitizeFilename } from "../utils/pathHelpers.js";

const nlp = winkNLP(model);
const its = nlp.its;
const VERB_TAGS = new Set(["VERB", "AUX", "VB", "VBD", "VBG", "VBN", "VBP", "VBZ"]);
const ADVERB_TAGS = new Set(["ADV", "RB", "RBR", "RBS", "WRB"]);
const ADJECTIVE_TAGS = new Set(["ADJ", "JJ", "JJR", "JJS"]);
const PREPOSITION_TAGS = new Set(["ADP", "IN", "TO", "PART"]);
const NON_SUBJECT_TAGS = new Set([
  "DET",
  "DT",
  "PDT",
  "WDT",
  "PRON",
  "PRP",
  "PRP$",
  "CC",
  "CCONJ",
  "SCONJ",
  "INTJ",
  "UH",
  "CD",
  "NUM",
]);
const SUBJECT_TAGS = new Set(["NOUN", "PROPN", "NN", "NNS", "NNP", "NNPS"]);
const VERB_STOP_WORDS = new Set(["ok", "time", "need", "want", "please", "let"]);
const VERB_SLOT_COUNT = 10;
const SYMBOL_SLOT_COUNT = 10;
const FILE_PAIR_COUNT = 5;
const IDENTIFIER_REGEX = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Normalizes candidate symbol text into a clean identifier token.
 * @param token - Candidate token extracted from chat text.
 */
function normalizeSymbolToken(token: string): string {
  return token.replace(/^[^A-Za-z_$]+|[^A-Za-z0-9_$]+$/g, "");
}

/**
 * Adds one identifier candidate to the symbol frequency map.
 * @param counts - Aggregated frequency map.
 * @param rawToken - Untrusted raw token.
 * @param weight - Frequency weight increment.
 */
function addSymbolCount(
  counts: Map<string, number>,
  rawToken: string,
  weight = 1
): void {
  const normalized = normalizeSymbolToken(rawToken);
  if (!normalized || !IDENTIFIER_REGEX.test(normalized)) {
    return;
  }
  counts.set(normalized, (counts.get(normalized) ?? 0) + weight);
}

/**
 * Adds both sides of dotted member access as independent symbol candidates.
 * Example: `this.functionCall` contributes both `this` and `functionCall`.
 * @param counts - Aggregated frequency map.
 * @param dotted - Dot-delimited identifier chain.
 * @param weight - Frequency weight increment for each side.
 */
function addDottedSymbolCounts(
  counts: Map<string, number>,
  dotted: string,
  weight = 1
): void {
  const parts = dotted.split(".").map((part) => part.trim()).filter(Boolean);
  for (const part of parts) {
    addSymbolCount(counts, part, weight);
  }
}

/**
 * Boosts symbol frequencies from code-like syntactic contexts.
 * @param text - Full sampled text.
 * @param counts - Aggregated frequency map.
 */
function boostContextualSymbols(
  text: string,
  counts: Map<string, number>
): void {
  const declarationRegex = /\b(?:class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  const callableRegex = /\b(?:function|def|fn)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  const forInOfRegex = /\bfor\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s+(?:in|of)\s+([A-Za-z_$][A-Za-z0-9_$.]*)/g;
  const whileRegex = /\bwhile\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)/g;
  const memberAccessRegex = /\b([A-Za-z_$][A-Za-z0-9_$]*)\.([A-Za-z_$][A-Za-z0-9_$]*)\b/g;

  for (const match of text.matchAll(declarationRegex)) {
    addSymbolCount(counts, match[1] ?? "", 5);
  }
  for (const match of text.matchAll(callableRegex)) {
    addSymbolCount(counts, match[1] ?? "", 4);
  }
  for (const match of text.matchAll(forInOfRegex)) {
    addSymbolCount(counts, match[1] ?? "", 3);
    addDottedSymbolCounts(counts, match[2] ?? "", 3);
  }
  for (const match of text.matchAll(whileRegex)) {
    addSymbolCount(counts, match[1] ?? "", 2);
  }
  for (const match of text.matchAll(memberAccessRegex)) {
    addSymbolCount(counts, match[1] ?? "", 2);
    addSymbolCount(counts, match[2] ?? "", 2);
  }
}

/**
 * Sorts symbol frequencies into deterministic rank order.
 * @param counts - Symbol frequency map.
 */
function sortSymbolsByWeight(counts: Map<string, number>): Array<string> {
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([symbol]) => symbol);
}

/**
 * Extracts all symbol candidates from one text blob.
 * This is the uncapped symbol list used for per-message `AgentMessage.symbols`.
 * @param text - Source text to analyze.
 */
export function extractMessageSymbols(text: string): Array<string> {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const sample = buildSymbolSample(trimmed);
  const words = sample.match(/[A-Za-z_$][A-Za-z0-9_$.]*/g) ?? [];
  const counts = new Map<string, number>();

  for (const word of words) {
    if (word.includes(".")) {
      addDottedSymbolCounts(counts, word, 1);
    } else if (/[a-z][A-Z]/.test(word)) {
      addSymbolCount(counts, word, 2);
    } else if (/^[A-Z][A-Za-z0-9_$]+$/.test(word)) {
      addSymbolCount(counts, word, 1);
    }
  }

  boostContextualSymbols(sample, counts);
  return sortSymbolsByWeight(counts);
}

/**
 * Extracts unique verbs from the first user message.
 * @param firstUserMessage - First user-turn text in the session.
 */
function extractVerbs(firstUserMessage: string): Array<string> {
  if (!firstUserMessage.trim()) {
    return [];
  }

  const doc = nlp.readDoc(firstUserMessage);
  const tokens = doc.tokens().out() as Array<string>;
  const posTags = doc.tokens().out(its.pos) as Array<string>;
  const verbs: Array<string> = [];
  const seen = new Set<string>();

  for (let i = 0; i < tokens.length; i += 1) {
    if (!VERB_TAGS.has(posTags[i] ?? "")) {
      continue;
    }
    const verb = (tokens[i] ?? "").toLowerCase();
    if (!verb || VERB_STOP_WORDS.has(verb) || seen.has(verb)) {
      continue;
    }
    seen.add(verb);
    verbs.push(verb);
    if (verbs.length >= VERB_SLOT_COUNT) {
      break;
    }
  }

  if (verbs.length === 0) {
    const fallbackWords = firstUserMessage.match(/[A-Za-z][A-Za-z0-9_-]*/g) ?? [];
    for (const word of fallbackWords) {
      const normalized = word.toLowerCase();
      if (seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      verbs.push(normalized);
      if (verbs.length >= VERB_SLOT_COUNT) {
        break;
      }
    }
  }

  return verbs;
}

/**
 * Sanitizes one token down to a simple lowercase lexical unit.
 * @param token - Raw token from winkNLP output.
 */
function normalizeLexicalToken(token: string): string {
  return token.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
}

/**
 * Checks whether a token can act as a noun-like subject candidate.
 * @param token - Candidate token text.
 * @param posTag - POS tag for the candidate token.
 */
function isSubjectCandidate(token: string, posTag: string): boolean {
  const normalized = normalizeLexicalToken(token);
  if (!normalized) {
    return false;
  }
  if (SUBJECT_TAGS.has(posTag)) {
    return true;
  }
  if (PREPOSITION_TAGS.has(posTag) || ADVERB_TAGS.has(posTag) || ADJECTIVE_TAGS.has(posTag)) {
    return false;
  }
  if (NON_SUBJECT_TAGS.has(posTag)) {
    return false;
  }
  if (VERB_TAGS.has(posTag)) {
    return false;
  }
  return /[A-Za-z]/.test(normalized);
}

/**
 * Extracts deterministic verb-subject pairs from the first user message.
 * Pair rule: pick a verb, then the first later word that is not prep/adverb/adjective.
 * @param firstUserMessage - First user-turn text in the session.
 * @param pairCount - Required pair count for filename generation.
 */
function extractVerbSubjectPairs(firstUserMessage: string, pairCount: number): Array<string> {
  if (!firstUserMessage.trim()) {
    return [];
  }

  const doc = nlp.readDoc(firstUserMessage);
  const tokens = doc.tokens().out() as Array<string>;
  const posTags = doc.tokens().out(its.pos) as Array<string>;
  const pairs: Array<string> = [];
  const seenPairs = new Set<string>();

  for (let i = 0; i < tokens.length; i += 1) {
    const verbTag = posTags[i] ?? "";
    if (!VERB_TAGS.has(verbTag)) {
      continue;
    }

    const verb = normalizeLexicalToken(tokens[i] ?? "");
    if (!verb || VERB_STOP_WORDS.has(verb)) {
      continue;
    }

    let subject: string | null = null;
    for (let j = i + 1; j < tokens.length; j += 1) {
      const nextToken = tokens[j] ?? "";
      const nextTag = posTags[j] ?? "";
      if (!isSubjectCandidate(nextToken, nextTag)) {
        continue;
      }
      subject = normalizeLexicalToken(nextToken);
      if (subject) {
        break;
      }
    }

    if (!subject) {
      continue;
    }

    const pair = `${verb}-${subject}`;
    if (seenPairs.has(pair)) {
      continue;
    }
    seenPairs.add(pair);
    pairs.push(pair);
    if (pairs.length >= pairCount) {
      break;
    }
  }

  if (pairs.length === 0) {
    const fallbackWords = firstUserMessage.match(/[A-Za-z][A-Za-z0-9_-]*/g) ?? [];
    for (let i = 0; i < fallbackWords.length - 1; i += 1) {
      const verb = normalizeLexicalToken(fallbackWords[i] ?? "");
      const subject = normalizeLexicalToken(fallbackWords[i + 1] ?? "");
      if (!verb || !subject) {
        continue;
      }
      const pair = `${verb}-${subject}`;
      if (seenPairs.has(pair)) {
        continue;
      }
      seenPairs.add(pair);
      pairs.push(pair);
      if (pairs.length >= pairCount) {
        break;
      }
    }
  }

  return pairs;
}

/**
 * Builds a representative text sample for symbol extraction on very large chats.
 * @param text - Concatenated chat text for the full session.
 */
function buildSymbolSample(text: string): string {
  const spaces = (text.match(/ /g) ?? []).length;
  if (spaces <= 100_000) {
    return text;
  }

  const words = text.split(/\s+/);
  const segmentSize = Math.max(1, Math.floor(words.length / 10));
  const sampleWords: Array<string> = [];

  for (let segment = 0; segment < 10; segment += 1) {
    const start = segment * segmentSize;
    const chunk = words.slice(start, start + 1_000);
    sampleWords.push(...chunk);
  }

  return sampleWords.join(" ");
}

/**
 * Extracts likely code symbols using mixed-case + contextual code heuristics.
 * @param allText - Concatenated session text from all roles.
 */
function extractSymbols(allText: string): Array<string> {
  return extractMessageSymbols(allText).slice(0, SYMBOL_SLOT_COUNT);
}

/**
 * Pads keyword Arrays to deterministic slot counts for full subject persistence.
 * @param values - Extracted subject tokens.
 * @param size - Required final slot count.
 * @param fallbackPrefix - Prefix used to generate fallback placeholders.
 */
function fillSlots(values: Array<string>, size: number, fallbackPrefix: string): Array<string> {
  const filled = values.slice(0, size);
  while (filled.length < size) {
    filled.push(`${fallbackPrefix}${filled.length + 1}`);
  }
  return filled;
}

/**
 * Builds the canonical persisted subject string stored in AgentMessage.subject.
 * @param messages - Session messages in chronological order.
 */
export function generatePersistedSubject(messages: Array<AgentMessage>): string {
  if (messages.length === 0) {
    return "chat1-chat2-chat3-chat4-chat5-chat6-chat7-chat8-chat9-chat10 [Keywords- symbols1-symbols2-symbols3-symbols4-symbols5-symbols6-symbols7-symbols8-symbols9-symbols10]";
  }

  const firstUser = messages.find((message) => message.role === "user");
  const verbs = fillSlots(extractVerbs(firstUser?.message ?? ""), VERB_SLOT_COUNT, "chat");
  const allText = messages.map((message) => message.message ?? "").join(" ");
  const symbols = fillSlots(extractSymbols(allText), SYMBOL_SLOT_COUNT, "symbols");
  return `${verbs.join("-")} [Keywords- ${symbols.join("-")}]`;
}

/**
 * Builds the compact filename subject as 5 verb-subject pairs.
 * @param messages - Session messages in chronological order.
 */
export function generateFilenameSubject(messages: Array<AgentMessage>): string {
  if (messages.length === 0) {
    return "fix-item-build-item-update-item-run-item-check-item";
  }

  const firstUser = messages.find((message) => message.role === "user");
  const pairs = fillSlots(extractVerbSubjectPairs(firstUser?.message ?? "", FILE_PAIR_COUNT), FILE_PAIR_COUNT, "fix-item");
  return sanitizeFilename(pairs.join("-"));
}

/**
 * Generates the persisted session subject string.
 * @param messages - Session messages in chronological order.
 */
export function generateSubject(messages: Array<AgentMessage>): string {
  return generatePersistedSubject(messages);
}
