"use strict";

/* ========================================================================
 *  Client presets - one choice sets several things at once.
 *
 *  A preset bundles:
 *    destination      "workupload" | "drive"
 *    driveFolder      the Google Drive folder uploads land in (null = leave as is)
 *    compression      { enabled, targetMB } - the image size the helper aims for
 *    cameraRawPreset  { actionSet, actionName } | null - the Photoshop Action for "Photoshop + Upload"
 *
 *  Presets are stored in helper-config.json ("presets": [...], "activePreset": "name").
 *  The helper applies one LIVE (no restart) when a panel / the Dashboard asks for it.
 *
 *  Pure functions + small file helpers, shared by server.js (engine) and
 *  dashboard.js, and unit-tested on their own.
 * ==================================================================== */

const fs = require("fs");

const VALID_DESTINATIONS = ["workupload", "drive"];
const MAX_PRESETS = 30;
const NAME_MAX = 60;
const DEFAULT_COMPRESSION = { enabled: true, targetMB: 1.5 };

function sanitizeCompression(raw) {
    const out = { ...DEFAULT_COMPRESSION };
    if (raw && typeof raw === "object") {
        if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
        if (Number.isFinite(Number(raw.targetMB))) out.targetMB = Math.min(25, Math.max(0.3, Math.round(Number(raw.targetMB) * 10) / 10));
    }
    return out;
}

function sanitizeCameraRaw(raw) {
    if (raw && typeof raw === "object" && typeof raw.actionName === "string" && raw.actionName.trim()) {
        return { actionSet: String(raw.actionSet || "").slice(0, 200), actionName: raw.actionName.trim().slice(0, 200) };
    }
    return null;
}

function sanitizePreset(raw) {
    if (!raw || typeof raw !== "object") return null;
    const name = String(raw.name || "").trim().slice(0, NAME_MAX);
    if (!name) return null;
    const driveFolder = typeof raw.driveFolder === "string" && raw.driveFolder.trim() ? raw.driveFolder.trim().slice(0, 150) : null;
    return {
        name,
        destination: VALID_DESTINATIONS.includes(raw.destination) ? raw.destination : "workupload",
        driveFolder,
        compression: sanitizeCompression(raw.compression),
        cameraRawPreset: sanitizeCameraRaw(raw.cameraRawPreset)
    };
}

// de-duplicates by name (case-insensitive, first wins) and caps the list
function sanitizePresetList(list) {
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(list) ? list : []) {
        const p = sanitizePreset(raw);
        if (!p || seen.has(p.name.toLowerCase())) continue;
        seen.add(p.name.toLowerCase());
        out.push(p);
        if (out.length >= MAX_PRESETS) break;
    }
    return out;
}

// A preset made from whatever the helper is configured with right now.
function snapshotFromConfig(config, name) {
    return sanitizePreset({
        name,
        destination: config.destination,
        driveFolder: config.drive && config.drive.folderName,
        compression: config.compression,
        cameraRawPreset: config.cameraRawPreset
    });
}

// Mutates + returns a helper config object (the engine's in-memory one).
function applyPresetToConfigObject(config, preset) {
    config.destination = preset.destination;
    config.drive = config.drive || {};
    if (preset.driveFolder) config.drive.folderName = preset.driveFolder;
    config.compression = { ...preset.compression };
    config.cameraRawPreset = preset.cameraRawPreset ? { ...preset.cameraRawPreset } : null;
    config.activePreset = preset.name;
    return config;
}

// Does the helper's current setup still equal the preset? (False = "Preset X (modified)")
function matchesConfig(preset, config) {
    if (!preset || !config) return false;
    if (config.destination !== preset.destination) return false;
    if (preset.driveFolder && !(config.drive && config.drive.folderName === preset.driveFolder)) return false;
    const c = sanitizeCompression(config.compression);
    if (c.enabled !== preset.compression.enabled || c.targetMB !== preset.compression.targetMB) return false;
    const a = sanitizeCameraRaw(config.cameraRawPreset), b = preset.cameraRawPreset;
    if ((a === null) !== (b === null)) return false;
    if (a && (a.actionName !== b.actionName || a.actionSet !== b.actionSet)) return false;
    return true;
}

// short human-readable lines for the UI
function describePreset(preset) {
    const parts = [preset.destination === "drive" ? "Google Drive" + (preset.driveFolder ? " \u2192 " + preset.driveFolder : "") : "WorkUpload"];
    parts.push(preset.compression.enabled ? "compress to " + preset.compression.targetMB + " MB" : "no compression");
    if (preset.cameraRawPreset) parts.push("Camera Raw: " + preset.cameraRawPreset.actionName);
    return parts;
}

/* ---------------------------- file helpers ---------------------------- */

function readRaw(file) {
    try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        return raw && typeof raw === "object" ? raw : {};
    } catch {
        return {};
    }
}

function writeRaw(file, raw) {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(raw, null, 2), "utf8");
    fs.renameSync(tmp, file);
}

function loadPresets(file) {
    const raw = readRaw(file);
    const presets = sanitizePresetList(raw.presets);
    const active = typeof raw.activePreset === "string" && presets.some(p => p.name === raw.activePreset) ? raw.activePreset : null;
    return { presets, activePreset: active };
}

// cached by mtime - the engine asks for the names on every status heartbeat
const cache = new Map();
function loadPresetsCached(file) {
    let stamp = "missing";
    try { const st = fs.statSync(file); stamp = st.mtimeMs + ":" + st.size; } catch {}   // size too: two writes inside one mtime tick still differ
    const hit = cache.get(file);
    if (hit && hit.stamp === stamp) return hit.value;
    const value = loadPresets(file);
    cache.set(file, { stamp, value });
    return value;
}

function savePresets(file, presets, activePreset) {
    const raw = readRaw(file);
    raw.presets = sanitizePresetList(presets);
    raw.activePreset = activePreset && raw.presets.some(p => p.name === activePreset) ? activePreset : null;
    writeRaw(file, raw);
}

// Writes a preset's settings into the config FILE (used when the helper isn't running to apply it live).
function applyPresetToFile(file, preset) {
    const raw = readRaw(file);
    raw.destination = preset.destination;
    raw.drive = raw.drive && typeof raw.drive === "object" ? raw.drive : {};
    if (preset.driveFolder) raw.drive.folderName = preset.driveFolder;
    raw.compression = { ...preset.compression };
    raw.cameraRawPreset = preset.cameraRawPreset ? { ...preset.cameraRawPreset } : null;
    raw.activePreset = preset.name;
    writeRaw(file, raw);
}

module.exports = {
    VALID_DESTINATIONS, MAX_PRESETS, DEFAULT_COMPRESSION,
    sanitizePreset, sanitizePresetList, sanitizeCompression, snapshotFromConfig,
    applyPresetToConfigObject, matchesConfig, describePreset,
    loadPresets, loadPresetsCached, savePresets, applyPresetToFile
};
