import fs from "fs";
import crypto from "crypto";

// For node win-dpapi usage
let dpapi;
try {
  dpapi = require("win-dpapi");
} catch(e) {
  console.error("win-dpapi not found!");
  process.exit(1);
}

// 1. Get the encrypted key from Local State
const stateRaw = fs.readFileSync("C:\\Users\\Axonn\\AppData\\Roaming\\Antigravity\\Local State", "utf8");
const state = JSON.parse(stateRaw);
const b64C = state.os_crypt.encrypted_key;

const encKeyBuf = Buffer.from(b64C, "base64");
console.log("Enc key length:", encKeyBuf.length, "Magic:", encKeyBuf.slice(0, 5).toString("utf8"));

// Usually first 5 bytes are "DPAPI"
const dpapiBuf = encKeyBuf.slice(5);
let aesKey;
try {
  aesKey = dpapi.unprotectData(dpapiBuf, null, "CurrentUser");
  console.log("AES Key obtained, length:", aesKey.length);
} catch(e) {
  console.error("DPAPI failed", e);
  process.exit(1);
}

// 2. Read the PB file
const pbFile = "C:\\Users\\Axonn\\.gemini\\antigravity\\conversations\\cf387eef-7689-4556-9952-1f67edbfa7b2.pb";
const pbBuf = fs.readFileSync(pbFile);

// 3. Decrypt the PB file assuming [IV(12)][Ciphertext][AuthTag(16)]
const iv = pbBuf.slice(0, 12);
const authTag = pbBuf.slice(pbBuf.length - 16);
const ciphertext = pbBuf.slice(12, pbBuf.length - 16);

console.log("iv len:", iv.length, "authTag len:", authTag.length, "ciphertext len:", ciphertext.length);

try {
  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, iv);
  decipher.setAuthTag(authTag);
  const plainText = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  console.log("Decrypted successfully!!! First 100 bytes:", plainText.slice(0, 100).toString("utf8"));
  
  // write to plain.pb
  fs.writeFileSync("plain.pb", plainText);
  console.log("Wrote to plain.pb");
} catch (e) {
  console.error("Decryption failed:", e);
}
