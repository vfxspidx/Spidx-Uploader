"use strict";

/* ========================================================================
 *  Update check
 *
 *  Checks GitHub Releases for a newer version than what's in package.json
 *  and caches the result so this only hits the network once a day —
 *  GitHub's unauthenticated API is capped at 60 requests/hour per IP, and
 *  there's no reason to check more than once a day anyway.
 *
 *  REQUIRED SETUP: set REPO below to your GitHub "owner/repo" (a public
 *  repo whose Releases page has at least one published release, tagged
 *  like "v2.4.0" or "2.4.0"). Nothing else needs configuring — no token,
 *  no secret, this only calls GitHub's public, unauthenticated API.
 *
 *  This module does NOT install anything — it only tells the tray app
 *  there's a newer version, with a link to the release page. Actually
 *  downloading and swapping files is a separate, bigger project.
 * ==================================================================== */

const path = require("path");
const fs = require("fs");
const https = require("https");
const { spawn } = require("child_process");

const APP_DIR = __dirname;
const PACKAGE_FILE = path.join(APP_DIR, "package.json");
const CACHE_FILE = path.join(APP_DIR, "update-cache.json");

// Public GitHub repo used for release/update checks — see update-check.js
// setup notes at the top of this file for how a build is published here.
const REPO = "vfxspidx/Spidx-Uploader";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day
const REQUEST_TIMEOUT_MS = 8000;

function readCurrentVersion() {
    try {
        return JSON.parse(fs.readFileSync(PACKAGE_FILE, "utf8")).version || "0.0.0";
    } catch {
        return "0.0.0";
    }
}

function readCache() {
    try {
        return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    } catch {
        return null;
    }
}

function writeCache(data) {
    try {
        fs.writeFileSync(CACHE_FILE, JSON.stringify(data), "utf8");
    } catch {
        // Non-fatal — worst case we just check again next start.
    }
}

// Bare-bones semver compare — good enough for "MAJOR.MINOR.PATCH" tags
// with an optional leading "v" ("v2.4.0", "2.4.0"). Anything with extra
// suffixes (e.g. "-beta.1") sorts by its numeric prefix only.
function isNewerVersion(latest, current) {
    const clean = v => String(v).replace(/^v/i, "").split(/[.-]/).map(n => parseInt(n, 10) || 0);
    const a = clean(latest);
    const b = clean(current);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const x = a[i] || 0;
        const y = b[i] || 0;
        if (x > y) return true;
        if (x < y) return false;
    }
    return false;
}

// Picks the installer asset out of a GitHub release's "assets" array.
// Prefers a name containing "Setup" (matches Installer/SpidxUploader.iss's
// OutputBaseFilename=SpidxUploaderSetup), falls back to the first .exe
// asset, so this keeps working even if the output name ever changes.
function findInstallerAsset(release) {
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const byName = assets.find(a => /setup.*\.exe$/i.test(a.name || ""));
    const anyExe = assets.find(a => /\.exe$/i.test(a.name || ""));
    const asset = byName || anyExe;
    return asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size } : null;
}

function fetchLatestRelease() {
    return new Promise((resolve, reject) => {
        const req = https.get(
            `https://api.github.com/repos/${REPO}/releases/latest`,
            {
                headers: {
                    "User-Agent": "spidx-uploader-update-check",
                    "Accept": "application/vnd.github+json"
                },
                timeout: REQUEST_TIMEOUT_MS
            },
            res => {
                if (res.statusCode !== 200) {
                    res.resume(); // drain so the socket can close
                    reject(new Error(`GitHub API returned ${res.statusCode}`));
                    return;
                }
                let body = "";
                res.on("data", chunk => { body += chunk; });
                res.on("end", () => {
                    try {
                        resolve(JSON.parse(body));
                    } catch (err) {
                        reject(err);
                    }
                });
            }
        );
        req.on("timeout", () => req.destroy(new Error("Request timed out")));
        req.on("error", reject);
    });
}

// Returns { hasUpdate, latestVersion, downloadUrl, checkedAt } — always,
// even on failure (hasUpdate: false), so callers never need a try/catch.
// Uses the on-disk cache instead of hitting the network if it's still
// fresh (see CHECK_INTERVAL_MS above); pass force:true to bypass that
// (e.g. a manual "Check for updates" click).
async function checkForUpdate(force = false) {
    const currentVersion = readCurrentVersion();

    if (!REPO) {
        return { hasUpdate: false, latestVersion: currentVersion, downloadUrl: null, checkedAt: null };
    }

    const cache = readCache();
    if (!force && cache && Date.now() - cache.checkedAt < CHECK_INTERVAL_MS) {
        return cache;
    }

    let result;
    try {
        const release = await fetchLatestRelease();
        const latestVersion = release.tag_name || currentVersion;
        const installerAsset = findInstallerAsset(release);
        result = {
            hasUpdate: isNewerVersion(latestVersion, currentVersion),
            latestVersion,
            downloadUrl: release.html_url || `https://github.com/${REPO}/releases/latest`,
            installerAssetUrl: installerAsset ? installerAsset.url : null,
            installerAssetName: installerAsset ? installerAsset.name : null,
            installerAssetSize: installerAsset ? installerAsset.size : null,
            checkedAt: Date.now()
        };
    } catch (err) {
        // Network hiccup, rate limit, no releases published yet, etc. —
        // fall back to the previous cached result if there is one, so a
        // transient failure doesn't flicker an existing "update
        // available" notice on and off.
        result = cache || { hasUpdate: false, latestVersion: currentVersion, downloadUrl: null, checkedAt: Date.now() };
        result.checkedAt = Date.now(); // still counts as "checked" so we back off for a day either way
        result.lastError = err.message;
    }

    writeCache(result);
    return result;
}

function openReleasePage(url, log = () => {}) {
    try {
        const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
        const rundll32Path = path.join(systemRoot, "System32", "rundll32.exe");
        const child = spawn(rundll32Path, ["url.dll,FileProtocolHandler", url], { windowsHide: true });
        child.on("error", err => log(`Could not open the release page automatically: ${err.message}`));
    } catch (err) {
        log(`Could not open the release page automatically: ${err.message}`);
    }
}

// Downloads a URL to destPath, following redirects manually (GitHub asset
// URLs 302 to a signed S3/Azure URL — https.get does NOT follow redirects
// on its own). onProgress(receivedBytes, totalBytes) is optional and
// totalBytes may be 0 if the server doesn't send Content-Length.
function downloadFile(url, destPath, onProgress, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
        const req = https.get(
            url,
            { headers: { "User-Agent": "spidx-uploader-update-check" }, timeout: 30000 },
            res => {
                if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                    res.resume();
                    if (redirectsLeft <= 0) { reject(new Error("Too many redirects.")); return; }
                    downloadFile(res.headers.location, destPath, onProgress, redirectsLeft - 1).then(resolve, reject);
                    return;
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    reject(new Error(`Download failed (HTTP ${res.statusCode}).`));
                    return;
                }

                const total = parseInt(res.headers["content-length"] || "0", 10);
                let received = 0;
                const file = fs.createWriteStream(destPath);
                res.on("data", chunk => {
                    received += chunk.length;
                    if (onProgress) onProgress(received, total);
                });
                res.pipe(file);
                file.on("finish", () => file.close(() => resolve()));
                file.on("error", err => { fs.unlink(destPath, () => {}); reject(err); });
                res.on("error", err => { fs.unlink(destPath, () => {}); reject(err); });
            }
        );
        req.on("timeout", () => req.destroy(new Error("Download timed out.")));
        req.on("error", reject);
    });
}

// Downloads the installer for `info` (the object checkForUpdate() returns)
// into the OS temp folder and launches it, un-elevated child spawned
// detached so it keeps running after this process exits — the Inno Setup
// installer itself asks Windows for admin (UAC) and, if it's set to check
// for a running instance, prompts the user to close the app. This does
// NOT close the helper for you; an active upload is left alone.
async function downloadAndRunInstaller(info, onProgress) {
    if (!info || !info.installerAssetUrl) {
        throw new Error("No installer file found in the latest release.");
    }

    const os = require("os");
    const destPath = path.join(os.tmpdir(), info.installerAssetName || "SpidxUploaderSetup.exe");

    await downloadFile(info.installerAssetUrl, destPath, onProgress);

    const child = spawn(destPath, [], { detached: true, stdio: "ignore", windowsHide: false });
    child.on("error", err => { throw err; });
    child.unref();

    return destPath;
}

module.exports = { checkForUpdate, openReleasePage, downloadAndRunInstaller, isNewerVersion };
