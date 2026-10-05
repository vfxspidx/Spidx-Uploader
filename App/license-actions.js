"use strict";

/* ========================================================================
 *  License code redemption + device management
 *
 *  Everything here is a POST to the same Apps Script URL used for tier
 *  checks (license.checkUrl in helper-config.json) — a Web App has one
 *  doGet (tier checks) and one doPost (this) at the same URL, and doPost
 *  dispatches on body.action:
 *
 *    (none)          redeem a license code   -> redeemLicenseCode(code)
 *    "listDevices"   list YOUR registered devices -> listDevices()
 *    "removeDevice"  free one of your slots  -> removeDevice(deviceId)
 *
 *  The idToken proves who's asking (same Google-verified identity as the
 *  tier check — see license.js/google-auth.js), so Apps Script never has
 *  to trust a client-supplied email, and can only ever touch the caller's
 *  own devices.
 *
 *  On anything that changes what tier this account resolves to (a
 *  redemption, or freeing a device slot that may un-downgrade this
 *  machine), deletes the local license cache so the next tier check hits
 *  the network fresh instead of serving the stale cached tier for up to
 *  24h.
 * ==================================================================== */

const fs = require("fs");
const path = require("path");
const https = require("https");
const { URL } = require("url");

const CONFIG_FILE = path.join(__dirname, "helper-config.json");
const CACHE_FILE = path.join(__dirname, "license-cache.json");

function readCheckUrl() {
    try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
        return (raw.license && raw.license.checkUrl) || "";
    } catch {
        return "";
    }
}

function postJson(urlString, body) {
    return new Promise((resolve, reject) => {
        let url;
        try {
            url = new URL(urlString);
        } catch (err) {
            reject(err);
            return;
        }

        const payload = JSON.stringify(body);
        const req = https.request(
            {
                hostname: url.hostname,
                path: url.pathname + url.search,
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(payload)
                },
                timeout: 15000
            },
            res => {
                // Apps Script runs doPost() fully on THIS request (hence
                // the code is already redeemed by the time we get here),
                // then 302-redirects to a separate, static
                // script.googleusercontent.com URL that just serves the
                // response body. That target is content, not another
                // execution — it must be followed with GET, never POST,
                // or re-POSTing can hit doPost() will observe a URL that
                // doesn't run the script at all and returns something
                // that isn't the JSON we expect.
                if (res.statusCode === 302 && res.headers.location) {
                    res.resume();
                    getFollowingRedirects(res.headers.location).then(resolve, reject);
                    return;
                }
                let text = "";
                res.on("data", chunk => { text += chunk; });
                res.on("end", () => resolve(text));
            }
        );
        req.on("timeout", () => req.destroy(new Error("Request timed out")));
        req.on("error", reject);
        req.write(payload);
        req.end();
    });
}

function getFollowingRedirects(urlString, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
        https.get(urlString, { timeout: 15000 }, res => {
            const status = res.statusCode || 0;
            if (status >= 300 && status < 400 && res.headers.location) {
                res.resume();
                if (redirectsLeft <= 0) { reject(new Error("Too many redirects.")); return; }
                resolve(getFollowingRedirects(res.headers.location, redirectsLeft - 1));
                return;
            }
            let text = "";
            res.on("data", chunk => { text += chunk; });
            res.on("end", () => resolve(text));
        })
            .on("error", reject)
            .on("timeout", function () { this.destroy(new Error("Request timed out")); });
    });
}

function clearLicenseCache() {
    try {
        if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE);
    } catch {
        // Non-fatal — worst case the old cached tier is served for up to
        // 24h until it naturally expires.
    }
}

// Returns { ok, tier, trialDaysRemaining, message, ambiguous? }. Never
// throws — network/parse failures come back as { ok: false, message }
// just like a code the server itself rejected, EXCEPT for the one case
// handled specially below (see the big comment past the postJson call).
async function redeemLicenseCode(code) {
    const checkUrl = readCheckUrl();
    if (!checkUrl) {
        return { ok: false, message: 'No "license.checkUrl" set in helper-config.json.' };
    }

    const googleAuth = require("./google-auth.js");
    const license = require("./license.js");

    let idToken, email;
    try {
        idToken = await googleAuth.getIdToken();
        email = await googleAuth.getUserEmail();
    } catch (err) {
        return { ok: false, message: `Could not get a Google sign-in token: ${err.message}` };
    }

    let raw = null;
    let networkErrorMessage = null;
    try {
        raw = await postJson(checkUrl, { idToken, code });
    } catch (err) {
        networkErrorMessage = err.message;
    }

    let parsed = null;
    if (raw !== null) {
        try { parsed = JSON.parse(raw); } catch { /* falls through to the ambiguous branch below */ }
    }

    // A clean, well-formed answer from Apps Script — trust it as-is,
    // nothing more to do.
    if (parsed && parsed.ok === false) {
        return { ok: false, message: parsed.message || "Code could not be redeemed." };
    }
    if (parsed && parsed.ok === true) {
        clearLicenseCache();
        return { ok: true, tier: parsed.tier, trialDaysRemaining: parsed.trialDaysRemaining };
    }

    // Ambiguous case: a network hiccup, or a response we couldn't parse
    // (this is exactly the failure mode that used to leave someone with a
    // scary "Unexpected response" error even though doPost() had already
    // written the redemption server-side — see the fixed postJson()
    // redirect handling above). We genuinely don't know whether the
    // redemption landed from this response alone, so instead of just
    // erroring, force a fresh (cache-bypassing) tier check and report
    // whatever's actually true right now. If the code *did* land, this
    // picks it up automatically with no extra click; if it didn't, the
    // tier just comes back unchanged and the message says so plainly —
    // either way the user sees ground truth, not a guess.
    clearLicenseCache();
    try {
        const result = await license.checkTier(idToken, email);
        return {
            ok: true,
            ambiguous: true,
            tier: result.tier,
            trialDaysRemaining: result.trialDaysRemaining,
            message: "Couldn't confirm the redemption directly, so this is your freshly-checked current tier instead."
        };
    } catch {
        return { ok: false, message: networkErrorMessage || "Unexpected response from the license server." };
    }
}

// Shared plumbing for the device actions: sign-in token + POST + parse.
// Returns the parsed JSON body, or { ok: false, message } on any failure.
async function postAction(action, extra) {
    const checkUrl = readCheckUrl();
    if (!checkUrl) return { ok: false, message: 'No "license.checkUrl" set in helper-config.json.' };

    let idToken;
    try {
        idToken = await require("./google-auth.js").getIdToken();
    } catch (err) {
        return { ok: false, message: `Could not get a Google sign-in token: ${err.message}` };
    }

    try {
        const raw = await postJson(checkUrl, Object.assign({ idToken, action }, extra || {}));
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : { ok: false, message: "Unexpected response from the license server." };
    } catch (err) {
        return { ok: false, message: err.message || "Could not reach the license server." };
    }
}

// Returns { ok, devices: [{ deviceId, addedAt, isThisDevice }], thisDeviceId }.
async function listDevices() {
    const thisDeviceId = require("./license.js").getOrCreateDeviceId();
    const result = await postAction("listDevices");
    if (!result.ok) return result;
    const devices = (result.devices || []).map(d => ({
        deviceId: d.deviceId,
        addedAt: d.addedAt || null,
        name: d.name || null,
        isThisDevice: d.deviceId === thisDeviceId
    }));
    return { ok: true, devices, thisDeviceId };
}

// Frees one of the caller's own device slots. Clears the license cache on
// success: if THIS machine had been downgraded to Free for being a 3rd
// device, the next tier check should see the freed slot right away.
async function removeDevice(deviceId) {
    const result = await postAction("removeDevice", { deviceId });
    if (result.ok) clearLicenseCache();
    return result;
}

module.exports = { redeemLicenseCode, listDevices, removeDevice };
