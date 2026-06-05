import { readAntigravityChats } from "../../../../src/harness/antigravity.js";

const path = "c:\\Users\\Axonn\\.gemini\\antigravity\\conversations\\";
const rawBase = "c:\\Users\\Axonn\\.gemini\\antigravity\\raw-dump\\";

console.log("Starting test run of readAntigravityChats...");
readAntigravityChats(path, rawBase);
