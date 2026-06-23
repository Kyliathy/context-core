import { Database } from "bun:sqlite";
const dbPath = "C:\\Users\\Axonn\\AppData\\Roaming\\Antigravity\\User\\globalStorage\\state.vscdb";
const db = new Database(dbPath, { readonly: true });
const targetKeys = ["google.antigravity", "antigravityAuthStatus", "antigravityUnifiedStateSync.trajectorySummaries", "content.trust.model.key"];
const rows = db.query(`SELECT key, value FROM ItemTable WHERE key IN (${targetKeys.map(k=>`'${k}'`).join(",")})`).all();
console.log(rows);
// Also search for JSON substring that looks like a JWK
const rows2 = db.query(`SELECT key, value FROM ItemTable WHERE value LIKE '%jwk%' OR value LIKE '%oct%' OR value LIKE '%encrypt%'`).all();
console.log("JWK ROWS:");
for (const r of rows2) console.log(r.key);
