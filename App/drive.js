"use strict";

/* ========================================================================
 *  Google Drive backend for Spider Engine
 *
 *  Used when helper-config.json has "destination": "drive". No browser
 *  automation at all — just the official Drive REST API via `googleapis`.
 *
 *  Authentication is handled by google-auth.js (shared with the tier
 *  check in license.js) — this file only deals with Drive-specific calls:
 *  uploading files, creating the shared folder / per-batch folders, and
 *  setting public permissions.
 * ==================================================================== */

const fs = require("fs");
const path = require("path");
const { ensureGoogleClient } = require("./google-auth.js");

const CONFIG_FILE = path.join(__dirname, "helper-config.json");
const DEFAULT_FOLDER_NAME = "Spidx Uploads";

let driveClient = null;
let cachedFolderId = null;

function log(...args) {
    console.log("[SE][Drive]", ...args);
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

// Drive needs a correct mimeType per file — the Photoshop panel only ever
// sends JPG, but the After Effects panel can send PNG stills or rendered
// video, and uploading those as "image/jpeg" makes Drive preview them
// wrongly (or not at all).
const MIME_BY_EXT = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".webp": "image/webp", ".gif": "image/gif", ".tif": "image/tiff", ".tiff": "image/tiff",
    ".mp4": "video/mp4", ".mov": "video/quicktime", ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska", ".webm": "video/webm"
};

function mimeForFile(filePath) {
    return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

async function ensureDriveClient() {
    if (driveClient) return driveClient;

    const google = loadGoogleapis();
    const auth = await ensureGoogleClient();

    driveClient = google.drive({ version: "v3", auth });
    return driveClient;
}

async function ensureUploadFolder(drive) {
    if (cachedFolderId) return cachedFolderId;

    const folderName = (readDriveConfig().folderName || DEFAULT_FOLDER_NAME).replace(/'/g, "\\'");

    const existing = await drive.files.list({
        q: `name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: "files(id, name)",
        spaces: "drive"
    });

    if (existing.data.files && existing.data.files.length > 0) {
        cachedFolderId = existing.data.files[0].id;
        return cachedFolderId;
    }

    const created = await drive.files.create({
        requestBody: { name: readDriveConfig().folderName || DEFAULT_FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" },
        fields: "id"
    });

    cachedFolderId = created.data.id;
    log(`Created the "${readDriveConfig().folderName || DEFAULT_FOLDER_NAME}" folder on Drive.`);
    return cachedFolderId;
}

// Uploads one file, makes it public ("anyone with the link" / reader), and
// returns the standard Drive share link. Throws on any failure — the
// caller (server.js) classifies the error via classifyDriveError().
async function uploadFileToDrive(filePath, displayName) {
    const drive = await ensureDriveClient();
    const folderId = await ensureUploadFolder(drive);

    const created = await drive.files.create({
        requestBody: {
            name: displayName || path.basename(filePath),
            parents: [folderId]
        },
        media: {
            mimeType: mimeForFile(filePath),
            body: fs.createReadStream(filePath)
        },
        fields: "id"
    });

    const fileId = created.data.id;

    await drive.permissions.create({
        fileId,
        requestBody: { role: "reader", type: "anyone" }
    });

    return {
        fileId,
        link: `https://drive.google.com/file/d/${fileId}/view?usp=sharing`
    };
}

// Creates a new public subfolder inside the shared "Spidx Uploads" folder
// for one batch (2+ files agreed to get their own folder instead of
// separate links). Always creates a fresh folder — even if the same
// display name is reused for a later batch — so batches never get merged
// into each other by accident.
async function createBatchFolder(displayName) {
    const drive = await ensureDriveClient();
    const parentFolderId = await ensureUploadFolder(drive);

    const created = await drive.files.create({
        requestBody: {
            name: displayName,
            mimeType: "application/vnd.google-apps.folder",
            parents: [parentFolderId]
        },
        fields: "id"
    });

    const folderId = created.data.id;

    await drive.permissions.create({
        fileId: folderId,
        requestBody: { role: "reader", type: "anyone" }
    });

    return {
        folderId,
        link: `https://drive.google.com/drive/folders/${folderId}?usp=sharing`
    };
}

// Uploads one file directly into an already-public batch folder. No
// per-file permission needed — a public Drive folder's "anyone/reader"
// permission already covers the files inside it.
async function uploadFileToFolder(filePath, displayName, folderId) {
    const drive = await ensureDriveClient();

    const created = await drive.files.create({
        requestBody: {
            name: displayName || path.basename(filePath),
            parents: [folderId]
        },
        media: {
            mimeType: mimeForFile(filePath),
            body: fs.createReadStream(filePath)
        },
        fields: "id"
    });

    return { fileId: created.data.id };
}

// Maps a Drive/auth error to one of server.js's FAILURE_REASON codes so it
// gets the right retry treatment (see RETRY_STRATEGY in server.js).
function classifyDriveError(error) {
    const status = error && (error.code || (error.response && error.response.status));
    const msg = ((error && error.message) || "").toLowerCase();

    if (status === 401 || msg.includes("invalid_grant") || msg.includes("invalid credentials") || msg.includes("not set up yet")) {
        return "drive_auth";
    }
    if (status === 403 && (msg.includes("quota") || msg.includes("storage") || msg.includes("limit"))) {
        return "drive_quota";
    }
    if (msg.includes("enotfound") || msg.includes("econnreset") || msg.includes("etimedout") || msg.includes("network")) {
        return "drive_network";
    }
    return "drive_unknown";
}

// Called once at startup (when destination is "drive") so the folder
// lookup is already warm before the first file arrives — mirrors
// warmUpBrowser() on the WorkUpload side. Auth itself already happened at
// this point via server.js's unified Google sign-in step, so this is
// fast (no login prompt).
async function warmUpDrive() {
    try {
        const drive = await ensureDriveClient();
        await ensureUploadFolder(drive);
        log("Google Drive is connected and ready for uploads.");
    } catch (error) {
        log("Could not set up Google Drive yet:", error.message);
        log("Uploads will retry the setup automatically.");
    }
}

module.exports = { uploadFileToDrive, createBatchFolder, uploadFileToFolder, classifyDriveError, warmUpDrive };
