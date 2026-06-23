import { Database } from "bun:sqlite";
import fs from "fs";

const dbPath = "C:\\Users\\Axonn\\AppData\\Roaming\\Antigravity\\User\\globalStorage\\state.vscdb";
if (!fs.existsSync(dbPath)) {
  console.log("DB not found at", dbPath);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
console.log("Opened DB");

try {
  const rows1 = db.query("SELECT key, value FROM ItemTable WHERE key LIKE '%mcpEncryptionKey%'").all();
  console.log("ItemTable rows:", rows1.length);
  for (const row of rows1) {
    console.log(row.key, "=>", row.value);
  }
} catch (e) {
  console.log("No ItemTable?", e.message);
}

try {
  const rows2 = db.query("SELECT key, value FROM cursorDiskKV WHERE key LIKE '%mcpEncryptionKey%'").all();
  console.log("cursorDiskKV rows:", rows2.length);
  for (const row of rows2) {
    console.log(row.key, "=>", row.value);
  }
} catch(e) {
  // Ignore
}
