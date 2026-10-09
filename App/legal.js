"use strict";

/* ========================================================================
 *  Terms of Service / Privacy Policy - versions, links and the user's consent.
 *
 *  consent.json (next to this file) records WHICH version of the legal texts the
 *  user accepted, when, and (once known) for which Google account. Change
 *  LEGAL_VERSION whenever the Terms or the Privacy Policy change materially -
 *  everybody is then asked again (a banner in the Dashboard; the setup wizard
 *  for new installs).
 * ==================================================================== */

const fs = require("fs");
const path = require("path");

const CONSENT_FILE = path.join(__dirname, "consent.json");

// Bump when the Terms, EULA or Privacy Policy on spidxuploader.com change materially (must equal the "Last updated" date).
const LEGAL_VERSION = "2026-10-09";

const LEGAL_URLS = {
    terms: "https://spidxuploader.com/terms",
    eula: "https://spidxuploader.com/eula",
    privacy: "https://spidxuploader.com/privacy",
    refund: "https://spidxuploader.com/refund",
    assetLicense: "https://spidxuploader.com/asset-license",
    site: "https://spidxuploader.com/"
};

function readConsent() {
    try {
        const c = JSON.parse(fs.readFileSync(CONSENT_FILE, "utf8"));
        return c && typeof c === "object" ? c : null;
    } catch {
        return null;
    }
}

function hasValidConsent() {
    const c = readConsent();
    return !!(c && c.version === LEGAL_VERSION && c.acceptedAt);
}

function recordConsent(email) {
    const entry = { version: LEGAL_VERSION, acceptedAt: new Date().toISOString(), email: email || null };
    fs.writeFileSync(CONSENT_FILE, JSON.stringify(entry, null, 2), "utf8");
    return entry;
}

// The wizard records consent before anybody has signed in; remember the account afterwards.
function attachEmail(email) {
    const c = readConsent();
    if (!c || c.version !== LEGAL_VERSION || c.email || !email) return;
    try { fs.writeFileSync(CONSENT_FILE, JSON.stringify({ ...c, email }, null, 2), "utf8"); } catch {}
}

function consentSummary() {
    const c = readConsent();
    return {
        accepted: hasValidConsent(),
        acceptedVersion: c ? c.version || null : null,
        acceptedAt: c ? c.acceptedAt || null : null,
        currentVersion: LEGAL_VERSION,
        urls: LEGAL_URLS
    };
}

module.exports = { LEGAL_VERSION, LEGAL_URLS, readConsent, hasValidConsent, recordConsent, attachEmail, consentSummary };
