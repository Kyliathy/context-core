import fs from "fs";
import crypto from "crypto";

const b64Key = "wv7MLloB8wHUNpSrTjql+N38J3gTo+8c/pUtUUg0DN4=";
const masterKey = Buffer.from(b64Key, "base64");

const pbFile = "C:\\Users\\Axonn\\.gemini\\antigravity\\conversations\\cf387eef-7689-4556-9952-1f67edbfa7b2.pb";
const pbBuf = fs.readFileSync(pbFile);

// Assuming standard: [IV 12][Ciphertext][Auth 16]
const iv = pbBuf.slice(0, 12);
const authTag = pbBuf.slice(pbBuf.length - 16);
const ciphertext = pbBuf.slice(12, pbBuf.length - 16);

function tryDecrypt(name: string, key: Buffer) {
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const plainText = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    console.log(`\n✅ SUCCESS with ${name}!`);
    console.log("Decrypted start:", plainText.slice(0, 100).toString("utf8").replace(/\n/g, "\\n"));
    fs.writeFileSync("plain.pb", plainText);
    return true;
  } catch (e) {
    // console.log(`❌ Failed with ${name}`);
    return false;
  }
}

console.log("Starting Decryption Trials...");

// 1. Direct DPAPI Master Key (usually works on Windows for Chromium)
if (tryDecrypt("Direct DPAPI Master Key", masterKey)) process.exit(0);

// 2. PBKDF2 with Chromium standard settings
const salts = ["saltysalt", "antigravity", ""];
const iterationsList = [1003, 1, 1000, 10000];
const hashAlgos = ["sha1", "sha256", "sha512"];

for (const saltStr of salts) {
  for (const iter of iterationsList) {
    for (const algo of hashAlgos) {
      const derivedKey = crypto.pbkdf2Sync(masterKey, saltStr, iter, 32, algo);
      if (tryDecrypt(`PBKDF2 (salt=${saltStr}, iter=${iter}, algo=${algo})`, derivedKey)) {
        process.exit(0);
      }
    }
  }
}

// 3. PBKDF2 but with the string representation of the key?
const masterKeyStr = masterKey.toString("utf8");
for (const saltStr of salts) {
    const derivedKey = crypto.pbkdf2Sync(masterKeyStr, saltStr, 1003, 32, "sha1");
    if (tryDecrypt(`PBKDF2 from UTF8 Key (salt=${saltStr})`, derivedKey)) process.exit(0);
}

// What if IV is 16 bytes? (AES-256-GCM usually defaults to 12, but can be 16)
try {
  const iv16 = pbBuf.slice(0, 16);
  const cipher16 = pbBuf.slice(16, pbBuf.length - 16);
  const decipher16 = crypto.createDecipheriv("aes-256-gcm", masterKey, iv16);
  decipher16.setAuthTag(authTag);
  const pt = Buffer.concat([decipher16.update(cipher16), decipher16.final()]);
  console.log("✅ SUCCESS with Direct Key, 16-byte IV!");
  process.exit(0);
} catch(e) {}

console.log("\n❌ All trials failed. Key derivation or file format is still incorrect.");
