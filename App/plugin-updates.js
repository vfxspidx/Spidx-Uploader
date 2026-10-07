"use strict";

/* ========================================================================
 *  Plugin updates
 *
 *  The GitHub release tagged "plugins" (see .github/workflows/release-plugin-*.yml)
 *  holds the newest build of each plugin:
 *      CEP-AE-v<version>.zip      After Effects panel
 *      CEP-PPRO-v<version>.zip    Premiere Pro panel
 *      VEGAS-Plugin-v<version>.zip  VEGAS Pro plugin (source + installer scripts)
 *      UXP-Panel.ccx              Photoshop panel
 *
 *  checkPluginUpdates()     compares them with what this install ships
 *                           (the bundled CEP-AE / CEP-PPRO / VEGAS-Plugin / UXP
 *                           folders) and lists what is newer.
 *  downloadPluginUpdates()  downloads + unpacks the newer ones over the
 *                           bundled folders. It does NOT touch Photoshop /
 *                           After Effects / Premiere / VEGAS: after that the
 *                           Dashboard shows "update available" next to each
 *                           plugin and the normal Install/Update button
 *                           (which needs the host closed) puts it in place.
 * ==================================================================== */

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const http = require("http");
const crypto = require("crypto");
const { extractZip } = require("./zip-util.js");
const { downloadFile, isNewerVersion, REPO } = require("./update-check.js");

const APP_DIR = __dirname;
const ROOT_DIR = path.join(APP_DIR, "..");
const CACHE_FILE = path.join(APP_DIR, "plugin-updates-cache.json");
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;
const RELEASE_TAG = "plugins";

const PLUGINS = {
    ae: {
        label: "After Effects panel",
        assetPattern: /^CEP-AE-v(.+)\.zip$/i,
        folder: path.join(ROOT_DIR, "CEP-AE"),
        localVersion: () => manifestVersion(path.join(ROOT_DIR, "CEP-AE", "CSXS", "manifest.xml"))
    },
    ppro: {
        label: "Premiere Pro panel",
        assetPattern: /^CEP-PPRO-v(.+)\.zip$/i,
        folder: path.join(ROOT_DIR, "CEP-PPRO"),
        localVersion: () => manifestVersion(path.join(ROOT_DIR, "CEP-PPRO", "CSXS", "manifest.xml"))
    },
    vegas: {
        label: "VEGAS Pro plugin",
        assetPattern: /^VEGAS-Plugin-v(.+)\.zip$/i,
        folder: path.join(ROOT_DIR, "VEGAS-Plugin"),
        localVersion: () => {
            try { return fs.readFileSync(path.join(ROOT_DIR, "VEGAS-Plugin", "version.txt"), "utf8").trim() || null; } catch { return null; }
        }
    },
    ps: {
        label: "Photoshop panel",
        assetPattern: /^UXP-Panel\.ccx$/i,
        ccxTarget: path.join(ROOT_DIR, "UXP", "com.spidx.workupload_PS.ccx"),
        // no version number in a .ccx name - compared by content hash / size instead
        localVersion: () => null
    }
};

function manifestVersion(file) {
    try {
        const m = fs.readFileSync(file, "utf8").match(/ExtensionBundleVersion\s*=\s*"([^"]+)"/);
        return m ? m[1] : null;
    } catch { return null; }
}

function sha256File(file) {
    try { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); } catch { return null; }
}

function apiBase() {
    return (process.env.SPIDX_GITHUB_API || "https://api.github.com").replace(/\/+$/, "");
}

function repoName() {
    return process.env.SPIDX_PLUGIN_REPO || REPO;
}

function fetchJson(urlString) {
    return new Promise((resolve, reject) => {
        const lib = /^http:/i.test(urlString) ? http : https;
        const req = lib.get(urlString, {
            headers: { "User-Agent": "spidx-uploader-plugin-updates", "Accept": "application/vnd.github+json" },
            timeout: REQUEST_TIMEOUT_MS
        }, res => {
            if (res.statusCode === 404) { res.resume(); reject(new Error("No \"plugins\" release published yet.")); return; }
            if (res.statusCode !== 200) { res.resume(); reject(new Error(`GitHub API returned ${res.statusCode}`)); return; }
            let body = "";
            res.on("data", chunk => { body += chunk; });
            res.on("end", () => { try { resolve(JSON.parse(body)); } catch (err) { reject(err); } });
        });
        req.on("timeout", () => req.destroy(new Error("Request timed out")));
        req.on("error", reject);
    });
}

function readCache() {
    try { return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch { return null; }
}

function writeCache(data) {
    try { fs.writeFileSync(CACHE_FILE, JSON.stringify(data), "utf8"); } catch { /* optional */ }
}

// Which plugins does this release carry, and are they newer than what's bundled here?
function evaluateRelease(release) {
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const updates = [];

    for (const key of Object.keys(PLUGINS)) {
        const plugin = PLUGINS[key];
        const asset = assets.find(a => plugin.assetPattern.test(a.name || ""));
        if (!asset) continue;

        const entry = {
            key,
            label: plugin.label,
            assetName: asset.name,
            url: asset.browser_download_url,
            size: asset.size || null,
            digest: asset.digest || null    // "sha256:<hex>" on newer GitHub API responses
        };

        if (key === "ps") {
            const remoteHash = entry.digest && /^sha256:/i.test(entry.digest) ? entry.digest.slice(7).toLowerCase() : null;
            const localHash = sha256File(plugin.ccxTarget);
            let different;
            if (remoteHash && localHash) different = remoteHash !== localHash;
            else if (localHash === null) different = false; // nothing bundled -> nothing to compare (don't nag)
            else different = !!(entry.size && fs.existsSync(plugin.ccxTarget) && fs.statSync(plugin.ccxTarget).size !== entry.size);
            if (!different) continue;
            entry.remoteVersion = "new build";
            entry.localVersion = "bundled";
        } else {
            const match = asset.name.match(plugin.assetPattern);
            const remoteVersion = match && match[1];
            const localVersion = plugin.localVersion();
            if (!remoteVersion) continue;
            if (localVersion && !isNewerVersion(remoteVersion, localVersion)) continue;
            if (!localVersion && !plugin.folder) continue;
            entry.remoteVersion = remoteVersion;
            entry.localVersion = localVersion;
        }
        updates.push(entry);
    }
    return updates;
}

// Always resolves (never rejects): { hasUpdates, updates, checkedAt, error? }
async function checkPluginUpdates(force = false) {
    const cache = readCache();
    if (!force && cache && Date.now() - cache.checkedAt < CHECK_INTERVAL_MS) {
        // the bundled versions may have changed since (after a download) - re-evaluate the cached release
        if (cache.release) {
            const updates = evaluateRelease(cache.release);
            return { hasUpdates: updates.length > 0, updates, checkedAt: cache.checkedAt };
        }
        return { hasUpdates: false, updates: [], checkedAt: cache.checkedAt, error: cache.error };
    }

    try {
        const release = await fetchJson(`${apiBase()}/repos/${repoName()}/releases/tags/${RELEASE_TAG}`);
        // keep only what's needed from the release, so the cache stays small
        const slim = { assets: (release.assets || []).map(a => ({ name: a.name, size: a.size, digest: a.digest || null, browser_download_url: a.browser_download_url })) };
        writeCache({ checkedAt: Date.now(), release: slim });
        const updates = evaluateRelease(slim);
        return { hasUpdates: updates.length > 0, updates, checkedAt: Date.now() };
    } catch (err) {
        const previous = cache && cache.release ? evaluateRelease(cache.release) : [];
        writeCache({ checkedAt: Date.now(), release: cache ? cache.release : null, error: err.message });
        return { hasUpdates: previous.length > 0, updates: previous, checkedAt: Date.now(), error: err.message };
    }
}

// Cheap, offline: what the last check found (for the Dashboard's first paint / tray).
function readCachedPluginUpdates() {
    const cache = readCache();
    if (!cache || !cache.release) return { hasUpdates: false, updates: [], checkedAt: cache ? cache.checkedAt : null, error: cache ? cache.error : undefined };
    const updates = evaluateRelease(cache.release);
    return { hasUpdates: updates.length > 0, updates, checkedAt: cache.checkedAt };
}

function copyTree(srcDir, destDir) {
    fs.mkdirSync(destDir, { recursive: true });
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
        const src = path.join(srcDir, entry.name);
        const dest = path.join(destDir, entry.name);
        if (entry.isDirectory()) copyTree(src, dest);
        else fs.copyFileSync(src, dest);
    }
}

async function applyOne(update, log) {
    const plugin = PLUGINS[update.key];
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "spidx-plugin-"));
    try {
        const downloaded = path.join(work, update.assetName);
        await downloadFile(update.url, downloaded);

        if (update.digest && /^sha256:/i.test(update.digest)) {
            const actual = sha256File(downloaded);
            if (actual !== update.digest.slice(7).toLowerCase()) throw new Error("The downloaded file's checksum doesn't match - not installing it.");
        }

        if (update.key === "ps") {
            fs.mkdirSync(path.dirname(plugin.ccxTarget), { recursive: true });
            fs.copyFileSync(downloaded, plugin.ccxTarget);
        } else {
            const unpacked = path.join(work, "unpacked");
            extractZip(downloaded, unpacked);
            if (update.key === "ae" || update.key === "ppro") {
                if (!fs.existsSync(path.join(unpacked, "CSXS", "manifest.xml"))) throw new Error("The download doesn't look like a panel (no CSXS/manifest.xml).");
            }
            copyTree(unpacked, plugin.folder);
        }
        log(`Plugin update: ${plugin.label} updated to ${update.remoteVersion}.`);
        return { key: update.key, label: plugin.label, ok: true, version: update.remoteVersion };
    } catch (err) {
        log(`Plugin update: ${plugin.label} failed - ${err.message}`);
        return { key: update.key, label: plugin.label, ok: false, message: err.message };
    } finally {
        try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
    }
}

// keys: optional array like ["ae","vegas"]; default = everything that has an update.
async function downloadPluginUpdates(keys, log = () => {}) {
    const current = await checkPluginUpdates(true);
    const wanted = current.updates.filter(u => !keys || keys.includes(u.key));
    if (wanted.length === 0) {
        return { ok: !current.error, results: [], message: current.error ? `Could not check: ${current.error}` : "Everything is already up to date." };
    }
    const results = [];
    for (const update of wanted) results.push(await applyOne(update, log));
    const after = await checkPluginUpdates(false);
    return { ok: results.every(r => r.ok), results, remaining: after.updates };
}

module.exports = { checkPluginUpdates, readCachedPluginUpdates, downloadPluginUpdates, evaluateRelease };
