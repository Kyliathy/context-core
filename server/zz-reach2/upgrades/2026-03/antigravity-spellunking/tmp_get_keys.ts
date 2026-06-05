import { Database } from "bun:sqlite";

const dbPath = "C:\\Users\\Axonn\\AppData\\Roaming\\Antigravity\\User\\globalStorage\\state.vscdb";
const db = new Database(dbPath, { readonly: true });

const rows = db.query("SELECT key FROM ItemTable").all();
console.log("All ItemTable Keys:");
for (const row of rows) {
  console.log(row.key);
}
