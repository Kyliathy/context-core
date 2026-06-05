import keytar from "keytar";

async function run() {
  console.log("Searching for credentials matching 'mcp' or 'Antigravity'...");
  
  try {
    const creds = await keytar.findCredentials("Antigravity");
    console.log("Found for Antigravity:");
    console.log(creds);
  } catch(e) {
    console.log("Error finding Antigravity:", e);
  }

  try {
    const creds2 = await keytar.findCredentials("mcpEncryptionKey");
    console.log("\nFound for mcpEncryptionKey:");
    console.log(creds2);
  } catch(e) {
    console.log("Error", e);
  }

  console.log("\nTrying to brute force list some known Electron safe storage / VS Code secret storage keys...");
  const svcs = ["Antigravity", "Antigravity Safe Storage", "vscode", "vscodium"];
  for (const svc of svcs) {
    try {
      const pass = await keytar.getPassword(svc, "mcpEncryptionKey");
      if (pass) {
        console.log(`\nSUCCESS: Found mcpEncryptionKey under service '${svc}'!`);
        console.log(pass);
      }
    } catch(e) {}
  }
}

run();
