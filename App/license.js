"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const CACHE_FILE = path.join(__dirname, "license-cache.json");
const DEVICE_ID_FILE = path.join(__dirname, "device-id.json");
const CONFIG_FILE = path.join(__dirname, "helper-config.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIER = "free";
// A licence is a set of ROLES, sent by the server as one signed string:
//     "pro"        -> a rank on its own
//     "spt"        -> the add-on only (the Premiere Pro panel's MOGRT tab)
//     "pro+spt"    -> several roles combined (separators: + , | or spaces)
// The ranks (free < pro < tester < dev) decide Drive, 2-3 files per upload,
// Photoshop + Upload... exactly as before - "spt" is NOT a rank and is NOT in
// server.js's gating sets, so for all of that a spt-only user is "free".
const KNOWN_TIERS = ["free", "pro", "dev", "tester", "spt"];
const RANKED_TIERS = ["dev", "tester", "pro"]; // highest first
const LICENSE_SECRET = "03c5cc4c6626f50e054cf9a7ea2e1dc9cc0f4d7dbfafeabe9873d8aba03f0c65";

function log(...args) {
    console.log("[SE][License]", ...args);
}

function readLicenseConfig() {
    try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
        return raw.license || {};
    } catch {
        return {};
    }
}

function loadCache() {
    try {
        return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    } catch {
        return null;
    }
}

function saveCache(entry) {
    try {
        fs.writeFileSync(CACHE_FILE, JSON.stringify(entry, null, 2), "utf8");
    } catch (error) {
        log("Could not save the tier cache:", error.message);
    }
}

// Windows gives every installed OS a stable, random GUID at install time,
// stored in this registry key - readable by a normal (non-admin) user,
// and it survives reinstalling/deleting this app entirely (it only
// changes if Windows itself is reinstalled). Used as the device ID's
// source instead of a random UUID so that if device-id.json is ever
// lost (reinstall into a fresh folder, antivirus quarantine, manual
// cleanup, etc.) the SAME physical machine derives the SAME ID again on
// its next run, instead of registering as a brand-new device and
// quietly eating another slot out of the 2-device limit.
function readWindowsMachineGuid() {
    if (process.platform !== "win32") return null;
    try {
        const { execFileSync } = require("child_process");
        // /reg:64 avoids a 32-bit Node process reading the WOW6432Node
        // mirror (a different value) on 64-bit Windows.
        const output = execFileSync(
            "reg",
            ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid", "/reg:64"],
            { encoding: "utf8", windowsHide: true, timeout: 5000 }
        );
        const match = output.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{36})/);
        return match ? match[1] : null;
    } catch {
        return null; // blocked, key missing, non-Windows under Wine, etc. - caller falls back
    }
}

// Hashed (not used raw) so this app's ID can't be correlated with the
// same machine's identifier in some other, unrelated piece of software -
// it's still 1:1 stable per machine, just namespaced to Spidx Uploader.
function deriveStableDeviceId() {
    const machineGuid = readWindowsMachineGuid();
    if (!machineGuid) return null;
    return crypto.createHash("sha256").update("spidx-uploader:" + machineGuid).digest("hex");
}

function getOrCreateDeviceId() {
    try {
        const raw = JSON.parse(fs.readFileSync(DEVICE_ID_FILE, "utf8"));
        if (raw && typeof raw.deviceId === "string" && raw.deviceId) return raw.deviceId;
    } catch {}

    // Prefer the stable, hardware-derived ID; a random UUID is only the
    // fallback now (non-Windows, or the registry key couldn't be read) -
    // previously this was the ONLY behavior, which is exactly what let
    // one physical machine end up re-registering as a "new" device every
    // time device-id.json went missing.
    const deviceId = deriveStableDeviceId() || crypto.randomUUID();
    try {
        fs.writeFileSync(DEVICE_ID_FILE, JSON.stringify({ deviceId }, null, 2), "utf8");
    } catch (error) {
        log("Could not save the device ID:", error.message);
    }
    return deviceId;
}

// A human-readable label sent alongside deviceId so someone with 2+
// devices can tell which is which in the Dashboard's device list instead
// of reading raw UUIDs. Defaults to the machine's hostname, generated
// once and cached with the device ID (a hostname could theoretically
// change later — that's fine, this is just a label, not an identifier).
function getOrCreateDeviceName() {
    try {
        const raw = JSON.parse(fs.readFileSync(DEVICE_ID_FILE, "utf8"));
        if (raw && typeof raw.deviceName === "string" && raw.deviceName) return raw.deviceName;
    } catch {}

    const os = require("os");
    let deviceName = "Unknown device";
    try {
        deviceName = String(os.hostname() || deviceName).slice(0, 60);
    } catch {}

    try {
        const raw = JSON.parse(fs.readFileSync(DEVICE_ID_FILE, "utf8"));
        fs.writeFileSync(DEVICE_ID_FILE, JSON.stringify({ ...raw, deviceName }, null, 2), "utf8");
    } catch (error) {
        log("Could not save the device name:", error.message);
    }
    return deviceName;
}

// The value exactly as the server signed it (trimmed + lower-case). The
// signature is checked over THIS string - not over the parsed roles - so
// "pro+spt" can't be rewritten to "pro" (or the reverse) without breaking it.
function signedTierString(value) {
    return String(value || "").trim().toLowerCase();
}

// "pro+spt" -> ["pro", "spt"]. Unknown words are ignored; nothing known -> ["free"].
function parseRoles(value) {
    const found = [];
    for (const token of signedTierString(value).split(/[+,|\s]+/)) {
        if (KNOWN_TIERS.includes(token) && !found.includes(token)) found.push(token);
    }
    const withoutFree = found.filter(role => role !== "free");
    return withoutFree.length ? withoutFree : [DEFAULT_TIER];
}

// The rank among the roles (dev > tester > pro > free). "spt" is an add-on, not a rank.
function primaryTier(roles) {
    for (const rank of RANKED_TIERS) if (roles.includes(rank)) return rank;
    return DEFAULT_TIER;
}

function normalizeTier(value) {
    return primaryTier(parseRoles(value));
}

function computeSignature(email, tier, timestamp) {
    return crypto
        .createHmac("sha256", LICENSE_SECRET)
        .update(`${email}|${tier}|${timestamp}`)
        .digest("hex");
}

/* ---------------------------------------------------------------------- *
 *  Signatures: RSA (new) and HMAC (legacy)
 *
 *  LEGACY: HMAC-SHA256 with LICENSE_SECRET above. The secret ships inside this
 *  file, so anyone can read it and sign any role - it only stops accidents.
 *
 *  RSA: the server (Apps Script) signs with a PRIVATE key that never leaves it;
 *  this client only holds the PUBLIC key (App\license-public-key.pem) and can
 *  verify but not forge. The server sends it as "sig2" next to an optional
 *  "expiresAt" (ms since epoch). The signed text is exactly
 *      email|tier|timestamp|expiresAt         (expiresAt empty when not sent)
 *  with the signature as base64 (Utilities.computeRsaSha256Signature).
 *
 *  SWITCH: while no license-public-key.pem exists, the legacy signature is
 *  accepted (nothing changes). As soon as the file is shipped, RSA is REQUIRED
 *  and legacy signatures are refused - so deploy the server's RSA signing
 *  first, then ship the key. Version 3.0 ships the key and drops legacy.
 * ---------------------------------------------------------------------- */
const PUBLIC_KEY_FILE = path.join(__dirname, "license-public-key.pem");

function readPublicKey() {
    try {
        const pem = fs.readFileSync(PUBLIC_KEY_FILE, "utf8");
        return /BEGIN PUBLIC KEY/.test(pem) ? pem : null;
    } catch {
        return null;
    }
}

function rsaPayload(email, tier, timestamp, expiresAt) {
    return [email, tier, timestamp, expiresAt == null ? "" : expiresAt].join("|");
}

function isValidRsaSignature(publicKey, email, tier, timestamp, expiresAt, sig2) {
    if (!publicKey || !sig2 || !timestamp) return false;
    try {
        return crypto.verify("RSA-SHA256", Buffer.from(rsaPayload(email, tier, timestamp, expiresAt)), publicKey, Buffer.from(String(sig2), "base64"));
    } catch {
        return false;
    }
}

// One check for a server response AND for the local cache (same fields).
// -> { ok, method: "rsa" | "legacy", expired }
function verifyLicense(entry) {
    const publicKey = readPublicKey();
    if (publicKey) {
        // RSA required: a legacy-only or forged response is refused.
        if (!isValidRsaSignature(publicKey, entry.email, entry.tier, entry.timestamp, entry.expiresAt, entry.sig2)) return { ok: false, method: "rsa" };
        if (entry.expiresAt && Date.now() > Number(entry.expiresAt)) return { ok: false, method: "rsa", expired: true };
        return { ok: true, method: "rsa" };
    }
    // no public key installed yet -> legacy HMAC (transition)
    return { ok: isValidSignature(entry.email, entry.tier, entry.timestamp, entry.signature), method: "legacy" };
}

function isValidSignature(email, tier, timestamp, signature) {
    if (!timestamp || !signature) return false;
    try {
        const expected = Buffer.from(computeSignature(email, tier, timestamp), "hex");
        const actual = Buffer.from(String(signature), "hex");
        return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    } catch {
        return false;
    }
}

const MAX_REDIRECTS = 5;

function httpGetFollowingRedirects(url, redirectsLeft = MAX_REDIRECTS) {
    return new Promise((resolve, reject) => {
        const lib = /^http:/i.test(url) ? require("http") : https; // plain http only ever used by tests
        const req = lib.get(url, { timeout: 10000 }, res => {
            const status = res.statusCode || 0;
            if (status >= 300 && status < 400 && res.headers.location) {
                res.resume();
                if (redirectsLeft <= 0) { reject(new Error("Too many redirects.")); return; }
                resolve(httpGetFollowingRedirects(res.headers.location, redirectsLeft - 1));
                return;
            }
            let body = "";
            res.on("data", chunk => { body += chunk; });
            res.on("end", () => resolve(body));
        });
        req.on("error", reject);
        req.on("timeout", () => req.destroy(new Error("Tier check timed out.")));
    });
}

function fetchTier(checkUrl, idToken, deviceId, deviceName) {
    const url = `${checkUrl}${checkUrl.includes("?") ? "&" : "?"}idToken=${encodeURIComponent(idToken)}&deviceId=${encodeURIComponent(deviceId)}&deviceName=${encodeURIComponent(deviceName || "")}`;

    return httpGetFollowingRedirects(url).then(body => {
        let parsed;
        try {
            parsed = JSON.parse(body);
        } catch (error) {
            throw new Error(`Unexpected response from the tier check endpoint: ${error.message}`);
        }

        if (parsed.error) throw new Error(`Tier check rejected: ${parsed.error}${parsed.message ? ` — ${parsed.message}` : ""}`);

        // Apps Script derives this from the VERIFIED token, not from
        // anything the client claimed — see the comment on checkTier()
        // below for why that distinction matters.
        const verifiedEmail = String(parsed.email || "").trim().toLowerCase();
        if (!verifiedEmail) throw new Error("Tier check response did not include a verified email.");

        const signedTier = signedTierString(parsed.tier);

        const verdict = verifyLicense({
            email: verifiedEmail, tier: signedTier, timestamp: parsed.timestamp,
            signature: parsed.signature, sig2: parsed.sig2, expiresAt: parsed.expiresAt
        });
        if (!verdict.ok) {
            throw new Error(verdict.expired ? "License response has already expired." : "Tier response failed signature verification.");
        }
        const roles = parseRoles(signedTier);
        const tier = primaryTier(roles);

        // trialDaysRemaining is informational only (like deviceLimitReached)
        // — it doesn't gate anything itself. The tier value Apps Script
        // returns already reflects expiry (falls back to "free" past the
        // trial end date), so this is purely for the panel's countdown
        // display and isn't part of the signed payload.
        const trialDaysRemaining = Number.isFinite(parsed.trialDaysRemaining) && parsed.trialDaysRemaining > 0
            ? Math.floor(parsed.trialDaysRemaining)
            : null;

        return {
            email: verifiedEmail,
            tier,
            roles,
            signedTier,
            signatureMethod: verdict.method,
            sig2: parsed.sig2 || null,
            expiresAt: parsed.expiresAt || null,
            timestamp: parsed.timestamp,
            signature: parsed.signature,
            deviceLimitReached: !!parsed.deviceLimitReached,
            trialDaysRemaining
        };
    });
}

// Takes a Google ID token (a signed JWT proving who's actually signed
// in — see google-auth.js's getIdToken()), NOT a bare email string. The
// old version sent "?email=someone@gmail.com" as a plain query param,
// which Apps Script had no way to verify belonged to the caller —
// anyone could request anyone else's tier just by guessing their email,
// no login required. Apps Script now verifies the token itself (via
// Google's tokeninfo endpoint) and returns the email IT extracted from
// the verified token, which is what gets signature-checked below —
// the client's own notion of "whose tier is this" no longer matters,
// only what Google's servers actually vouch for.
async function checkTier(idToken, cacheKeyEmail) {
    const { checkUrl } = readLicenseConfig();
    const deviceId = getOrCreateDeviceId();
    const deviceName = getOrCreateDeviceName();
    const cache = loadCache();
    const cacheMatchesEmail = cache && cacheKeyEmail && cache.email === cacheKeyEmail;
    const cacheSignatureValid = cacheMatchesEmail && verifyLicense({
        email: cache.email, tier: cache.tier, timestamp: cache.timestamp,
        signature: cache.signature, sig2: cache.sig2, expiresAt: cache.expiresAt
    }).ok;   // an expired RSA licence in the cache counts as invalid too

    if (cacheMatchesEmail && !cacheSignatureValid) {
        log("Local tier cache failed signature verification — ignoring it.");
    }

    // Always try the network first — this runs once per helper start (i.e.
    // once per "app open"), so it's cheap, and it means the tier shown is
    // never more than one restart stale. CACHE_TTL_MS below only decides
    // how long a cached result stays trustworthy as a FALLBACK when the
    // network call itself fails (offline, Apps Script down, etc.) — it no
    // longer skips the network call on its own.
    if (!checkUrl) {
        log('No "license.checkUrl" set in helper-config.json — defaulting to free.');
        return { tier: DEFAULT_TIER, roles: [DEFAULT_TIER], deviceLimitReached: false, trialDaysRemaining: null };
    }

    try {
        const result = await fetchTier(checkUrl, idToken, deviceId, deviceName);
        saveCache({
            email: result.email,
            tier: result.signedTier,   // the signed string (e.g. "pro+spt") - the cache signature covers exactly this
            deviceLimitReached: result.deviceLimitReached,
            trialDaysRemaining: result.trialDaysRemaining,
            timestamp: result.timestamp,
            signature: result.signature,
            sig2: result.sig2,
            expiresAt: result.expiresAt,
            checkedAt: Date.now()
        });
        log(`Tier for ${result.email}: ${result.roles.join("+")} [${result.signatureMethod} signature]${result.deviceLimitReached ? " (device limit reached)" : ""}${result.trialDaysRemaining ? ` (trial, ${result.trialDaysRemaining}d left)` : ""}`);
        return { tier: result.tier, roles: result.roles, deviceLimitReached: result.deviceLimitReached, trialDaysRemaining: result.trialDaysRemaining };
    } catch (error) {
        const cacheIsWithinFallbackWindow = cacheSignatureValid && (Date.now() - cache.checkedAt) < CACHE_TTL_MS;
        const cachedRoles = cacheIsWithinFallbackWindow ? parseRoles(cache.tier) : [DEFAULT_TIER];
        const fallback = cacheIsWithinFallbackWindow
            ? { tier: primaryTier(cachedRoles), roles: cachedRoles, deviceLimitReached: !!cache.deviceLimitReached, trialDaysRemaining: cache.trialDaysRemaining || null }
            : { tier: DEFAULT_TIER, roles: [DEFAULT_TIER], deviceLimitReached: false, trialDaysRemaining: null };
        log(`Could not check tier (${error.message}) — using ${fallback.roles.join("+")}.`);
        return fallback;
    }
}

module.exports = { checkTier, getOrCreateDeviceId, DEFAULT_TIER, KNOWN_TIERS, parseRoles, primaryTier, verifyLicense };
