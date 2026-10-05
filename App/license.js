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
const KNOWN_TIERS = ["free", "pro", "dev", "tester"];
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

function normalizeTier(value) {
    const tier = String(value || "").trim().toLowerCase();
    return KNOWN_TIERS.includes(tier) ? tier : DEFAULT_TIER;
}

function computeSignature(email, tier, timestamp) {
    return crypto
        .createHmac("sha256", LICENSE_SECRET)
        .update(`${email}|${tier}|${timestamp}`)
        .digest("hex");
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
        const req = https.get(url, { timeout: 10000 }, res => {
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

        const tier = normalizeTier(parsed.tier);

        if (!isValidSignature(verifiedEmail, tier, parsed.timestamp, parsed.signature)) {
            throw new Error("Tier response failed signature verification.");
        }

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
    const cacheSignatureValid = cacheMatchesEmail && isValidSignature(cache.email, cache.tier, cache.timestamp, cache.signature);

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
        return { tier: DEFAULT_TIER, deviceLimitReached: false, trialDaysRemaining: null };
    }

    try {
        const result = await fetchTier(checkUrl, idToken, deviceId, deviceName);
        saveCache({
            email: result.email,
            tier: result.tier,
            deviceLimitReached: result.deviceLimitReached,
            trialDaysRemaining: result.trialDaysRemaining,
            timestamp: result.timestamp,
            signature: result.signature,
            checkedAt: Date.now()
        });
        log(`Tier for ${result.email}: ${result.tier}${result.deviceLimitReached ? " (device limit reached)" : ""}${result.trialDaysRemaining ? ` (trial, ${result.trialDaysRemaining}d left)` : ""}`);
        return { tier: result.tier, deviceLimitReached: result.deviceLimitReached, trialDaysRemaining: result.trialDaysRemaining };
    } catch (error) {
        const cacheIsWithinFallbackWindow = cacheSignatureValid && (Date.now() - cache.checkedAt) < CACHE_TTL_MS;
        const fallback = cacheIsWithinFallbackWindow
            ? { tier: cache.tier, deviceLimitReached: !!cache.deviceLimitReached, trialDaysRemaining: cache.trialDaysRemaining || null }
            : { tier: DEFAULT_TIER, deviceLimitReached: false, trialDaysRemaining: null };
        log(`Could not check tier (${error.message}) — using ${fallback.tier}.`);
        return fallback;
    }
}

module.exports = { checkTier, getOrCreateDeviceId, DEFAULT_TIER, KNOWN_TIERS };
