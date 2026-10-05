"use strict";

/* ========================================================================
 *  Shared Google OAuth client
 *
 *  Both the Drive upload backend (drive.js) and the Pro/Free/Dev/Tester
 *  tier check (license.js) authenticate through THIS one module, so
 *  there's only ONE login moment per installation — not a separate one
 *  for Drive and another for the tier check.
 *
 *  Scopes cover both needs from the start:
 *    - drive.file      -> only actually used if destination is "drive"
 *    - userinfo.email  -> needed to identify who's asking for a tier check
 *  Requesting both up front means switching destination later never
 *  triggers a second login.
 * ==================================================================== */

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const TOKEN_FILE = path.join(__dirname, "google-token.json");
const LEGACY_DRIVE_TOKEN_FILE = path.join(__dirname, "drive-token.json");
const CONFIG_FILE = path.join(__dirname, "helper-config.json");
const SCOPES = [
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/userinfo.email",
    "openid"
];

let oAuth2Client = null;
let cachedClientPromise = null;

function log(...args) {
    console.log("[SE][Google]", ...args);
}

function readDriveConfig() {
    try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
        return raw.drive || {};
    } catch {
        return {};
    }
}

function loadGoogleapis() {
    try {
        return require("googleapis").google;
    } catch {
        throw new Error("googleapis is missing. Run: npm install googleapis");
    }
}

function loadSavedTokens() {
    try {
        return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    } catch {}

    try {
        if (fs.existsSync(LEGACY_DRIVE_TOKEN_FILE)) {
            fs.renameSync(LEGACY_DRIVE_TOKEN_FILE, LEGACY_DRIVE_TOKEN_FILE + ".old");
        }
    } catch {}

    return null;
}

function saveTokens(tokens) {
    try {
        fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), "utf8");
    } catch (error) {
        log("Could not save the Google login for next time:", error.message);
    }
}

function openInBrowser(url) {
    try {
        const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
        const rundll32Path = path.join(systemRoot, "System32", "rundll32.exe");
        const child = spawn(rundll32Path, ["url.dll,FileProtocolHandler", url], { windowsHide: true });
        child.on("error", error => {
            log("Could not auto-open the browser (use the URL above manually):", error.message);
        });
    } catch (error) {
        log("Could not auto-open the browser (use the URL above manually):", error.message);
    }
}

function runInteractiveAuth(google, clientId, clientSecret) {
    return new Promise((resolve, reject) => {
        let client;

        const server = http.createServer((req, res) => {
            (async () => {
                try {
                    const reqUrl = new URL(req.url, "http://127.0.0.1");
                    if (reqUrl.pathname !== "/oauth2callback") {
                        res.writeHead(404);
                        res.end();
                        return;
                    }

                    const code = reqUrl.searchParams.get("code");
                    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                    res.end("<html><body>Spidx Uploader: Google connected. You can close this tab.</body></html>");

                    if (!code) {
                        server.close();
                        reject(new Error("Google did not return an authorization code."));
                        return;
                    }

                    const { tokens } = await client.getToken(code);
                    server.close();
                    resolve(tokens);
                } catch (error) {
                    server.close();
                    reject(error);
                }
            })();
        });

        server.on("error", reject);

        server.listen(0, "127.0.0.1", () => {
            const port = server.address().port;
            const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
            client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

            const authUrl = client.generateAuthUrl({
                access_type: "offline",
                prompt: "consent",
                scope: SCOPES
            });

            log("One-time Google sign-in needed — opening your browser...");
            log("If it doesn't open automatically, visit this URL:");
            log(authUrl);
            openInBrowser(authUrl);
        });
    });
}

async function ensureGoogleClient() {
    if (cachedClientPromise) return cachedClientPromise;

    cachedClientPromise = (async () => {
        const google = loadGoogleapis();
        const driveCfg = readDriveConfig();

        if (!driveCfg.clientId || !driveCfg.clientSecret) {
            throw new Error(
                'Google sign-in is not set up yet. Add a "drive" section to helper-config.json with "clientId" and ' +
                '"clientSecret" from a Google Cloud OAuth "Desktop app" client.'
            );
        }

        let tokens = loadSavedTokens();
        oAuth2Client = new google.auth.OAuth2(driveCfg.clientId, driveCfg.clientSecret);

        if (!tokens) {
            tokens = await runInteractiveAuth(google, driveCfg.clientId, driveCfg.clientSecret);
            saveTokens(tokens);
            log("Google account connected. This won't be needed again on this computer.");
        }

        oAuth2Client.setCredentials(tokens);

        oAuth2Client.on("tokens", newTokens => {
            tokens = { ...tokens, ...newTokens };
            saveTokens(tokens);
        });

        return oAuth2Client;
    })();

    try {
        return await cachedClientPromise;
    } catch (error) {
        cachedClientPromise = null;
        throw error;
    }
}

async function getUserEmail() {
    const client = await ensureGoogleClient();
    const google = loadGoogleapis();
    const oauth2 = google.oauth2({ version: "v2", auth: client });
    const { data } = await oauth2.userinfo.get();
    return data.email || null;
}

// Returns a fresh Google-signed ID token (a JWT) proving who's actually
// signed in — this is what license.js now sends to the tier-check
// endpoint INSTEAD of a bare email string, so the backend can verify
// identity itself (via Google's tokeninfo endpoint) rather than trusting
// whatever email the client claims. Requires "openid" in SCOPES above,
// which is already there. getAccessToken() forces a refresh first if the
// current access/ID token pair is stale (~1h lifetime) — the refresh
// response includes a new id_token as long as the original login
// requested the openid scope, same as this one did.
async function getIdToken() {
    const client = await ensureGoogleClient();
    await client.getAccessToken();
    const idToken = client.credentials && client.credentials.id_token;
    if (!idToken) {
        throw new Error("No Google ID token available — try \"Reset Google sign-in\" from the tray menu.");
    }
    return idToken;
}

module.exports = { ensureGoogleClient, getUserEmail, getIdToken };
