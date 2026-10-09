"use strict";

/* ========================================================================
 *  Generates the RSA key pair used to sign licenses.
 *
 *  Run it ON YOUR OWN COMPUTER (double-click "Generate License Keys.bat"):
 *    keys\license-private-key.pem  -> goes into the Apps Script (Script properties),
 *                                     NEVER into the app, the repo or a zip.
 *    keys\license-public-key.pem   -> copy to App\license-public-key.pem. Once that
 *                                     file ships, the app REQUIRES RSA signatures.
 *  Read Tools\LICENSE-RSA-README.txt for the order of the steps.
 * ==================================================================== */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "keys");
const PRIVATE_FILE = path.join(DIR, "license-private-key.pem");
const PUBLIC_FILE = path.join(DIR, "license-public-key.pem");

if (fs.existsSync(PRIVATE_FILE) || fs.existsSync(PUBLIC_FILE)) {
    console.log("\n  Keys already exist in " + DIR);
    console.log("  Not overwriting them - replacing a key would invalidate every license already issued.");
    console.log("  (Delete the folder by hand if you really want a new pair.)\n");
    process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
});

fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(PRIVATE_FILE, privateKey, { mode: 0o600 });
fs.writeFileSync(PUBLIC_FILE, publicKey);

console.log("\n  Done. Created:");
console.log("    " + PRIVATE_FILE + "   <- SECRET: Apps Script only");
console.log("    " + PUBLIC_FILE + "    <- copy to App\\license-public-key.pem");
console.log("\n  Next: follow Tools\\LICENSE-RSA-README.txt\n");
