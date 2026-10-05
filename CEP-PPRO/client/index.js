"use strict";

/* ========================================================================
 *  Spidx Uploader — Premiere Pro panel (CEP)
 *
 *  Port of the After Effects panel (CEP-AE/client/index.js). It speaks
 *  the exact same protocol as the AE and Photoshop panels — small files
 *  inside App\incoming:
 *
 *    .batch-config.json   written here  — how many files the engine waits for
 *    .batch-status.json   read here     — live collection/upload progress
 *    .engine-status.json  read here     — tier, destination, device limit
 *    .batch-force-send    written here  — "Send now"
 *    .batch-cancel        written here  — "Cancel"
 *
 *  so one running Spider Engine serves Photoshop, After Effects and
 *  Premiere Pro at the same time with no changes on its side.
 *
 *  The panel does one thing on purpose: export the active sequence's
 *  current frame, always as PNG. See host/spidx.jsx for how that export
 *  actually happens (it's the one part of this port that couldn't stay
 *  a straight copy — Premiere has no AE-style saveFrameToPng()).
 *
 *  No Node.js is required: everything goes through CEP's own cep.fs API,
 *  which is always present, instead of --enable-nodejs.
 * ==================================================================== */

var FOLDER_KEY = "spidx_ppro_incoming_path";
var BATCH_COUNT_KEY = "spidx_ppro_batch_count";
var FOLDER_NAME_KEY = "spidx_ppro_folder_name";
// Manual override for pngframe.epr — spidxPresetPath() in spidx.jsx
// already auto-finds it (Media Encoder's Presets folder, or the
// extension's own presets/ folder), so this is empty by default and
// only needs setting if auto-detection genuinely can't find it on a
// given machine.
var PRESET_KEY = "spidx_ppro_preset_path";

var BATCH_CONFIG_NAME = ".batch-config.json";
var BATCH_STATUS_NAME = ".batch-status.json";
var ENGINE_STATUS_NAME = ".engine-status.json";
// Mirrored by server.js's syncDefaultCameraRawPreset() whenever the
// Dashboard's preset fields change — reading it here (instead of
// re-deriving anything) means this indicator can never drift from
// what actually happens to the file after Upload is clicked.
var CAMERA_RAW_PRESET_NAME = ".default-camera-raw-preset.json";
var BATCH_FORCE_SEND_NAME = ".batch-force-send";
var BATCH_CANCEL_NAME = ".batch-cancel";
var POLL_MS = 1500;

// Spidx Engine 2.5 re-stamps .engine-status.json every 15s; older than
// this means nothing is watching the incoming folder.
var ENGINE_STALE_MS = 2 * 60 * 1000;

var MULTI_BATCH_TIERS = ["pro", "dev", "tester"];
// Same tier set gates every Pro+ feature (batch 2/3, Photoshop + Upload,
// the Properties tab) — one name, used everywhere below.
var PRO_FEATURE_TIERS = MULTI_BATCH_TIERS;

var incomingPath = localStorage.getItem(FOLDER_KEY) || "";
var presetOverride = localStorage.getItem(PRESET_KEY) || "";
var selectedBatchCount = 1;
var currentTier = null;
var currentDestination = "workupload";
var currentDeviceLimitReached = false;
var lastBatchState = null;
var busy = false;
var engineOnline = null;

/* ---------------------------------------------------------------------- */
/*  Element handles                                                       */
/* ---------------------------------------------------------------------- */

function $(id) { return document.getElementById(id); }

var card = $("card");
var cardTitle = $("cardTitle");
var cardSub = $("cardSub");
var routeLine = $("routeLine");
var progFill = $("progFill");
var uploadButton = $("upload");
var uploadPsButton = $("uploadPs");
var tabBtnProps = $("tabBtnProps");
var tierBadge = $("tierBadge");
var deviceLimitWarning = $("deviceLimitWarning");
var folderNameRow = $("folderNameRow");
var folderNameInput = $("folderNameInput");
var fileRow = $("fileRow");
var fileThumb = $("fileThumb");
var fileName = $("fileName");
var fileSize = $("fileSize");
var batchProgress = $("batchProgress");
var batchDots = $("batchDots");
var batchProgressText = $("batchProgressText");
var folderPathLabel = $("folderPath");
var presetPathLabel = $("presetPathLabel");

var batchButtons = Array.prototype.slice.call(document.querySelectorAll(".batch-opt"));

/* ---------------------------------------------------------------------- */
/*  CEP plumbing — ExtendScript calls + file system                       */
/* ---------------------------------------------------------------------- */

function evalScript(script) {
    return new Promise(function (resolve, reject) {
        if (!window.__adobe_cep__) {
            reject(new Error("This panel is not running inside Premiere Pro."));
            return;
        }
        window.__adobe_cep__.evalScript(script, function (result) {
            if (result === "EvalScript error.") {
                reject(new Error("Premiere Pro could not run the panel's script (host/spidx.jsx)."));
                return;
            }
            var parsed;
            try {
                parsed = JSON.parse(result);
            } catch (err) {
                reject(new Error("Unexpected response from Premiere Pro: " + result));
                return;
            }
            if (!parsed.ok) reject(new Error(parsed.message || "Premiere Pro reported an error."));
            else resolve(parsed);
        });
    });
}

function esArg(value) {
    return JSON.stringify(String(value == null ? "" : value));
}

function joinPath(folder, name) {
    return folder.replace(/[\\/]+$/, "") + "/" + name;
}

function readTextFile(fullPath) {
    try {
        var result = window.cep.fs.readFile(fullPath);
        if (result.err) return null;
        return result.data;
    } catch (err) {
        return null;
    }
}

function writeTextFile(fullPath, text) {
    try {
        var result = window.cep.fs.writeFile(fullPath, text);
        return !result.err;
    } catch (err) {
        return false;
    }
}

function readJsonFile(fullPath) {
    var text = readTextFile(fullPath);
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch (err) {
        return null;
    }
}

function folderExists(fullPath) {
    try {
        var result = window.cep.fs.readdir(fullPath);
        return !result.err;
    } catch (err) {
        return false;
    }
}

function pickFolder() {
    var result = window.cep.fs.showOpenDialog(false, true, "Choose the App\\incoming folder", incomingPath || "");
    if (result.err || !result.data || !result.data.length) return null;
    return String(result.data[0]);
}

/* ---------------------------------------------------------------------- */
/*  UI helpers                                                            */
/* ---------------------------------------------------------------------- */

function setCard(title, sub, state) {
    card.classList.remove("ok", "error");
    cardSub.classList.remove("ok", "error");
    cardTitle.textContent = title;
    cardSub.textContent = sub || "";
    if (state) {
        card.classList.add(state);
        cardSub.classList.add(state);
    }
    card.classList.remove("pulse");
    void card.offsetWidth;
    card.classList.add("pulse");
}

function setProgress(percent, done) {
    progFill.classList.remove("indeterminate");
    progFill.style.width = percent + "%";
    progFill.classList.toggle("done", !!done);
}

function setProgressIndeterminate(on) {
    progFill.classList.toggle("indeterminate", !!on);
    if (!on) progFill.style.width = "0%";
}

function formatBytes(bytes) {
    if (!bytes && bytes !== 0) return "";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
}

function showFile(name, bytes) {
    var ext = (name.split(".").pop() || "FILE").toUpperCase();
    fileThumb.textContent = ext.length > 4 ? ext.slice(0, 4) : ext;
    fileName.textContent = name;
    fileSize.textContent = formatBytes(bytes);
    fileRow.classList.add("show");
}

function hideFile() { fileRow.classList.remove("show"); }

function updateFolderLabel() {
    folderPathLabel.textContent = incomingPath || "no folder linked";
    folderPathLabel.title = incomingPath;
}

/* ---------------------------------------------------------------------- */
/*  Batch selector — identical semantics to the Photoshop panel           */
/* ---------------------------------------------------------------------- */

function tierAllowsMultiBatch() {
    return MULTI_BATCH_TIERS.indexOf(currentTier) !== -1;
}

function tierAllowsProFeatures() {
    return PRO_FEATURE_TIERS.indexOf(currentTier) !== -1;
}

// Free-tier lockout for the Properties tab. Runs whenever the tier
// changes; also called once on load once currentTier is known.
function updateProFeatureLocks() {
    if (!tabBtnProps) return;
    var locked = !tierAllowsProFeatures();
    tabBtnProps.classList.toggle("locked", locked);
    tabBtnProps.title = locked ? "Properties is a Pro feature — upgrade to use it." : "";
    // Don't strand the user on a tab that just got locked out from under them.
    if (locked && currentTab === "tabProps") activateTab("tabUploader");
}

function updateFolderNameVisibility() {
    folderNameRow.classList.toggle("show", currentDestination === "drive" && selectedBatchCount > 1);
}

function setBatchControlsLocked(locked) {
    var allowMulti = tierAllowsMultiBatch();
    batchButtons.forEach(function (btn) {
        var count = Number(btn.dataset.count) || 1;
        var tierBlocked = count > 1 && !allowMulti;
        btn.disabled = locked || tierBlocked;
        btn.title = tierBlocked ? "Pro only" : "";
    });
    folderNameInput.disabled = locked;
}

function setSelectedBatchCount(count) {
    selectedBatchCount = count;
    localStorage.setItem(BATCH_COUNT_KEY, String(count));
    batchButtons.forEach(function (btn) {
        btn.classList.toggle("active", Number(btn.dataset.count) === count);
    });
    updateFolderNameVisibility();
}

batchButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
        if (btn.disabled) return;
        setSelectedBatchCount(Number(btn.dataset.count) || 1);
        writeBatchConfig();
    });
});

folderNameInput.addEventListener("input", function () {
    localStorage.setItem(FOLDER_NAME_KEY, folderNameInput.value);
});

function writeBatchConfig() {
    if (!incomingPath) return;
    writeTextFile(
        joinPath(incomingPath, BATCH_CONFIG_NAME),
        JSON.stringify({ targetCount: selectedBatchCount, folderName: folderNameInput.value || "" })
    );
}

/* ---------------------------------------------------------------------- */
/*  Incoming folder                                                       */
/* ---------------------------------------------------------------------- */

function ensureIncomingFolder(forcePicker) {
    if (!forcePicker && incomingPath && folderExists(incomingPath)) return incomingPath;

    setCard("Select folder", "Choose the App\\incoming folder...");
    var picked = pickFolder();
    if (!picked) throw new Error("No incoming folder was selected.");

    incomingPath = picked;
    localStorage.setItem(FOLDER_KEY, incomingPath);
    updateFolderLabel();
    return incomingPath;
}

$("changeFolder").addEventListener("click", function () {
    if (busy) return;
    try {
        ensureIncomingFolder(true);
        setCard("Folder updated", "Ready to export", "ok");
    } catch (error) {
        setCard("Folder unchanged", error.message, "error");
    }
});

/* ---------------------------------------------------------------------- */
/*  Preset (.epr) override                                                */
/*                                                                         */
/*  spidxPresetPath() in spidx.jsx already auto-finds pngframe.epr, so    */
/*  this only matters when auto-detection genuinely can't — an unusual    */
/*  Media Encoder install location, a renamed preset, etc. Empty means    */
/*  "let the host script keep auto-detecting", same as before this        */
/*  existed.                                                              */
/* ---------------------------------------------------------------------- */

function updatePresetLabel() {
    if (!presetPathLabel) return;
    presetPathLabel.textContent = presetOverride || "auto-detected";
    presetPathLabel.title = presetOverride;
}

$("changePreset").addEventListener("click", function () {
    if (busy) return;
    var result = window.cep.fs.showOpenDialog(false, false, "Choose pngframe.epr", presetOverride || "");
    if (result.err || !result.data || !result.data.length) return;
    presetOverride = String(result.data[0]);
    localStorage.setItem(PRESET_KEY, presetOverride);
    updatePresetLabel();
    setCard("Preset updated", "Using: " + presetOverride, "ok");
});

/* ---------------------------------------------------------------------- */
/*  Status polling (engine + batch)                                       */
/* ---------------------------------------------------------------------- */

function applyEngineStatus(status) {
    var stamp = status && Number(status.updatedAt);
    var online = !!(stamp && (Date.now() - stamp) < ENGINE_STALE_MS);

    if (online !== engineOnline) {
        engineOnline = online;
        if (!online) {
            setCard(
                "Helper not running",
                'Start "Spidx Uploader.vbs" (or the desktop shortcut) — nothing is watching the incoming folder right now.',
                "error"
            );
            setProgress(0);
        } else if (!busy) {
            setCard("Ready", "Helper is running — export away.", "ok");
        }
    }

    if (online && status && status.state === "error" && status.message && !busy) {
        setCard("Helper problem", status.message, "error");
    }

    if (!status) return;

    if (typeof status.destination === "string") currentDestination = status.destination;
    currentDeviceLimitReached = !!status.deviceLimitReached;

    var tier = typeof status.tier === "string" ? status.tier : null;
    if (tier !== currentTier) {
        currentTier = tier;
        if (!tierAllowsMultiBatch() && selectedBatchCount > 1) setSelectedBatchCount(1);
        setBatchControlsLocked(false);
        updateProFeatureLocks();
    }

    tierBadge.className = "tier-badge" + (tier ? " show tier-" + tier : "");
    if (tier) {
        tierBadge.textContent = tier.toUpperCase()
            + (status.trialDaysRemaining ? " (" + status.trialDaysRemaining + "D)" : "");
    }

    deviceLimitWarning.classList.toggle("show", currentDeviceLimitReached);
    updateFolderNameVisibility();
}

function renderBatchDots(have, target) {
    batchDots.innerHTML = "";
    for (var i = 0; i < target; i++) {
        var dot = document.createElement("div");
        dot.className = "dot" + (i < have ? " filled" : "");
        batchDots.appendChild(dot);
    }
}

function applyBatchStatus(status) {
    var state = status ? status.state : "idle";

    if (state === "collecting") {
        batchProgress.classList.add("show");
        renderBatchDots(status.have || 0, status.target || selectedBatchCount);
        batchProgressText.textContent = (status.have || 0) + " of " + (status.target || "?") + " received";
        setBatchControlsLocked(true);
    } else {
        batchProgress.classList.remove("show");
        if (!busy) setBatchControlsLocked(false);
    }

    if (state === "uploading" && lastBatchState !== "uploading") {
        setCard("Uploading...", "Spider Engine is sending the file(s) now.");
        setProgressIndeterminate(true);
    }

    if (state === "done" && lastBatchState !== "done") {
        setProgressIndeterminate(false);
        setProgress(100, true);
        var links = (status && status.links) || [];
        setCard(
            "Uploaded",
            links.length ? "Link copied to the clipboard." : "Sent — no link was detected.",
            "ok"
        );
        setSelectedBatchCount(1);
        writeBatchConfig();
    }

    lastBatchState = state;
}

function poll() {
    if (currentTab === "tabProps") propsRefresh(); // keeps the Properties tab live without a manual Refresh click
    if (!incomingPath) return;
    applyEngineStatus(readJsonFile(joinPath(incomingPath, ENGINE_STATUS_NAME)));
    applyBatchStatus(readJsonFile(joinPath(incomingPath, BATCH_STATUS_NAME)));
    updateRouteLine();
}

// The "Photoshop + Upload" button only makes sense once there's an
// Action configured for it to run — read the same file the Dashboard
// writes so this can never drift from what server.js will actually do
// with the file.
function updateRouteLine() {
    if (!incomingPath) return;
    var preset = readJsonFile(joinPath(incomingPath, CAMERA_RAW_PRESET_NAME));
    var hasPreset = !!(preset && preset.actionName);

    var proAllowed = tierAllowsProFeatures();
    if (uploadPsButton) uploadPsButton.disabled = busy || !hasPreset || !proAllowed;
    if (routeLine) {
        routeLine.textContent = !proAllowed
            ? "Photoshop + Upload is a Pro feature — upgrade your tier to enable it."
            : hasPreset
                ? "Photoshop + Upload runs \u201c" + preset.actionName + "\u201d \u2014 requires Photoshop already open."
                : "Set a Camera Raw Action in the Dashboard to enable Photoshop + Upload.";
    }
}

$("sendNow").addEventListener("click", function () {
    if (!incomingPath) return;
    writeTextFile(joinPath(incomingPath, BATCH_FORCE_SEND_NAME), String(Date.now()));
    setCard("Sending now", "Pushing through whatever has been collected.");
});

$("cancelBatch").addEventListener("click", function () {
    if (!incomingPath) return;
    writeTextFile(joinPath(incomingPath, BATCH_CANCEL_NAME), String(Date.now()));
    setCard("Batch cancelled", "Nothing was uploaded.");
    setProgress(0);
});

/* ---------------------------------------------------------------------- */
/*  Upload                                                                */
/* ---------------------------------------------------------------------- */

function performUpload(viaPhotoshop) {
    if (busy) return;
    if (viaPhotoshop && !tierAllowsProFeatures()) {
        setCard("Photoshop + Upload is Pro", "Upgrade your tier to use this route.", "error");
        return;
    }

    var activeButton = viaPhotoshop ? uploadPsButton : uploadButton;
    var otherButton = viaPhotoshop ? uploadButton : uploadPsButton;
    var defaultLabel = viaPhotoshop ? "Photoshop + Upload" : "Upload";

    busy = true;
    activeButton.disabled = true;
    if (otherButton) otherButton.disabled = true;
    activeButton.classList.remove("success", "error");
    activeButton.textContent = "Exporting...";
    hideFile();
    setProgress(10);

    var task;
    try {
        ensureIncomingFolder(false);
        writeBatchConfig();

        if (engineOnline === false) {
            // Not a hard block: the frame still lands in incoming and gets
            // picked up whenever the helper comes back. The panel just
            // stops pretending it was sent.
            setCard("Helper not running", "Saving the frame anyway — it uploads when the helper starts.", "error");
        }

        setCard("Saving frame...", "Exporting the current frame as PNG.");
        setProgress(45);
        // The second argument only changes the saved filename (adds a
        // .ps marker before .png) — server.js's needsCameraRaw() is what
        // actually decides whether to route it through Photoshop, based
        // on that marker plus a configured preset. See server.js.
        task = evalScript("spidxSaveFrame(" + esArg(incomingPath) + ", " + (viaPhotoshop ? "true" : "false") + ", " + esArg(presetOverride) + ")");
    } catch (error) {
        finishUpload(error, null, activeButton, otherButton, defaultLabel);
        return;
    }

    task.then(function (result) { finishUpload(null, result, activeButton, otherButton, defaultLabel); })
        .catch(function (error) { finishUpload(error, null, activeButton, otherButton, defaultLabel); });
}

function finishUpload(error, result, activeButton, otherButton, defaultLabel) {
    setProgressIndeterminate(false);
    busy = false;
    activeButton.disabled = false;
    if (otherButton) otherButton.disabled = false;
    updateRouteLine(); // re-applies the PS button's own enabled/disabled state

    if (error) {
        setCard("Error", error.message, "error");
        setProgress(0);
        activeButton.textContent = "Try again";
        activeButton.classList.add("error");
        return;
    }

    var names = result.names || [result.name];
    setProgress(100, true);
    showFile(names[0], result.size);

    if (selectedBatchCount > 1) {
        setCard(
            "Added to batch",
            "Waiting for the rest (" + selectedBatchCount + " total) — export the next one the same way.",
            "ok"
        );
    } else {
        setCard(
            names.length > 1 ? names.length + " files ready" : "File ready",
            "The helper will compress and send it automatically.",
            "ok"
        );
    }

    activeButton.textContent = "Done";
    activeButton.classList.add("success");

    setTimeout(function () {
        if (!activeButton.classList.contains("error")) {
            activeButton.textContent = defaultLabel;
            activeButton.classList.remove("success");
        }
    }, 2500);
}

uploadButton.addEventListener("click", function () { performUpload(false); });
if (uploadPsButton) uploadPsButton.addEventListener("click", function () { performUpload(true); });

document.addEventListener("keydown", function (event) {
    var key = (event.key || "").toLowerCase();
    if (event.ctrlKey && event.shiftKey && key === "q") {
        event.preventDefault();
        performUpload(false);
    }
});

/* ------------------------------------------------------------------ */
/*  Tabs                                                                */
/* ------------------------------------------------------------------ */

var tabButtons = document.querySelectorAll(".tab-btn");
var currentTab = "tabUploader";

function activateTab(target) {
    if (target === "tabProps" && !tierAllowsProFeatures()) {
        setCard("Properties is Pro", "Upgrade your tier to edit Essential Graphics text properties from here.", "error");
        return;
    }
    currentTab = target;
    for (var i = 0; i < tabButtons.length; i++) tabButtons[i].classList.toggle("active", tabButtons[i].getAttribute("data-tab") === target);
    var pages = document.querySelectorAll(".tab-page");
    for (var j = 0; j < pages.length; j++) pages[j].classList.toggle("active", pages[j].id === target);
    if (target === "tabLeaderboard" && !lbLoadedOnce) lbLoad();
    if (target === "tabProps") {
        if (!lbLoadedOnce) lbLoad();
        propsRefresh(); // immediate — poll() then keeps it live every POLL_MS without a manual Refresh
    }
}

for (var ti = 0; ti < tabButtons.length; ti++) {
    tabButtons[ti].addEventListener("click", function () { activateTab(this.getAttribute("data-tab")); });
}

updateProFeatureLocks(); // initial paint — starts locked until the first engine-status read confirms tier

/* ------------------------------------------------------------------ */
/*  Leaderboard tab — SpidxTracker (Fortnite)                           */
/*                                                                      */
/*  Ported from the standalone SpidxLeaderboardPanel.jsx ScriptUI       */
/*  panel. Fetching and rendering happen here in plain JS (a CEP panel  */
/*  is just Chromium — fetch()/DOM beats the old raw-Socket-and-temp-   */
/*  .bat-file approach that ScriptUI needed). Only touching the actual  */
/*  AE layer (insert / Essential Graphics) still goes through           */
/*  ExtendScript — see spidxLeaderboardInsertAndExpose() in spidx.jsx.  */
/* ------------------------------------------------------------------ */

var LB_API_HOST = "http://169.58.221.14:8080";
var LB_CACHE_NAME = ".leaderboard-cache.json";

var lbRegion = $("lbRegion");
var lbSearch = $("lbSearch");
var lbRefreshBtn = $("lbRefresh");
var lbStatus = $("lbStatus");
var lbRows = $("lbRows");
var lbCopyBtn = $("lbCopy");
var lbMessage = $("lbMessage");

var lbPlayers = [];
var lbSelectedIndex = -1;
var lbSearchTimer = null;
var lbLoadedOnce = false;

function lbCacheFile() {
    return incomingPath ? joinPath(incomingPath, LB_CACHE_NAME) : null;
}

function lbSaveCache(players) {
    var file = lbCacheFile();
    if (!file) return;
    writeTextFile(file, JSON.stringify({ savedAt: Date.now(), players: players }));
}

function lbCacheAgeText(savedAt) {
    var mins = Math.round((Date.now() - savedAt) / 60000);
    if (mins < 1) return "just now";
    if (mins === 1) return "1 min ago";
    if (mins < 60) return mins + " min ago";
    var hours = Math.round(mins / 60);
    return hours === 1 ? "1 hour ago" : hours + " hours ago";
}

function lbUseCache(reasonWhyLive) {
    var file = lbCacheFile();
    var cache = file ? readJsonFile(file) : null;
    if (!cache || !cache.players || !cache.players.length) {
        lbPlayers = [];
        lbRenderRows();
        lbStatus.textContent = reasonWhyLive;
        lbStatus.className = "card-sub error";
        return;
    }
    lbPlayers = cache.players;
    lbRenderRows();
    lbStatus.textContent = "Offline \u2014 cached data from " + lbCacheAgeText(cache.savedAt)
        + " (" + lbPlayers.length + " players) \u00b7 " + reasonWhyLive;
    lbStatus.className = "card-sub error";
}

function lbFormatNumber(n) {
    n = Math.round(Number(n) || 0);
    var s = String(n);
    var out = "";
    var c = 0;
    for (var i = s.length - 1; i >= 0; i--) {
        out = s.charAt(i) + out;
        c++;
        if (c % 3 === 0 && i !== 0) out = " " + out;
    }
    return out;
}

function lbRenderRows() {
    lbRows.innerHTML = "";
    lbSelectedIndex = -1;
    lbCopyBtn.disabled = true;
    lbMessage.textContent = "";
    propsShowSelectedNick(null); // list just changed/refreshed — the old selection no longer applies

    if (!lbPlayers.length) {
        var empty = document.createElement("div");
        empty.className = "lb-empty";
        empty.textContent = "No players to show.";
        lbRows.appendChild(empty);
        return;
    }

    lbPlayers.forEach(function (p, idx) {
        var row = document.createElement("div");
        row.className = "lb-item";
        if (idx < 8) row.style.animationDelay = (idx * 20) + "ms";
        row.innerHTML = "<span>" + (p.rank != null ? p.rank : idx + 1) + "</span>"
            + "<span>" + escapeHtml(p.alias || p.name || "?") + "</span>"
            + "<span class=\"pts\">" + lbFormatNumber(p.points) + "</span>";
        row.addEventListener("click", function () { lbSelectRow(idx); });
        lbRows.appendChild(row);
    });
}

function escapeHtml(text) {
    var div = document.createElement("div");
    div.textContent = String(text == null ? "" : text);
    return div.innerHTML;
}

function lbSelectRow(idx) {
    lbSelectedIndex = idx;
    lbMessage.textContent = "";
    var items = lbRows.querySelectorAll(".lb-item");
    for (var i = 0; i < items.length; i++) items[i].classList.toggle("selected", i === idx);
    lbCopyBtn.disabled = false;

    var player = lbPlayers[idx];
    var nick = player ? (player.alias || player.name || "") : "";
    if (propsNickInput) propsNickInput.value = nick;
    propsShowSelectedNick(nick);
}

function lbSelectedPlayer() {
    if (lbSelectedIndex < 0) return null;
    return lbPlayers[lbSelectedIndex] || null;
}

function lbQuery() {
    var parts = [];
    var region = lbRegion.value;
    if (region !== "All") parts.push("region=" + encodeURIComponent(region));
    var search = lbSearch.value.replace(/^\s+|\s+$/g, "");
    if (search) parts.push("search=" + encodeURIComponent(search));
    parts.push("sort=points&order=desc");
    return parts.length ? ("?" + parts.join("&")) : "";
}

function lbLoad() {
    lbLoadedOnce = true;
    lbCopyBtn.disabled = true;
    lbMessage.textContent = "";
    lbStatus.textContent = "Loading...";
    lbStatus.className = "card-sub";

    var controller = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var timeoutId = controller ? setTimeout(function () { controller.abort(); }, 5000) : null;

    fetch(LB_API_HOST + "/api/fortnite" + lbQuery(), controller ? { signal: controller.signal } : {})
        .then(function (res) {
            if (timeoutId) clearTimeout(timeoutId);
            if (!res.ok) throw new Error("Server responded with " + res.status);
            return res.json();
        })
        .then(function (json) {
            if (!json || !json.success) {
                lbUseCache("API responded, but without the expected data.");
                return;
            }
            lbPlayers = json.data || [];
            if (!lbPlayers.length) {
                lbRenderRows();
                lbStatus.textContent = "No results for the current filters.";
                lbStatus.className = "card-sub error";
                return;
            }
            lbRenderRows();
            lbSaveCache(lbPlayers);
            lbStatus.textContent = "Connected \u00b7 " + lbPlayers.length + " players";
            lbStatus.className = "card-sub ok";
        })
        .catch(function (err) {
            if (timeoutId) clearTimeout(timeoutId);
            lbUseCache(err && err.message ? err.message : "Could not reach the leaderboard server.");
        });
}

function lbCopyToClipboard(text) {
    try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        var ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
    } catch (err) {
        return false;
    }
}

lbCopyBtn.addEventListener("click", function () {
    var player = lbSelectedPlayer();
    if (!player) return;
    var nick = player.alias || player.name || "";
    var ok = lbCopyToClipboard(nick);
    lbMessage.textContent = ok ? ("Copied: " + nick) : "Could not copy to clipboard.";
    lbMessage.className = ok ? "card-sub ok" : "card-sub error";
});



lbRefreshBtn.addEventListener("click", lbLoad);
lbRegion.addEventListener("change", lbLoad);
lbSearch.addEventListener("input", function () {
    clearTimeout(lbSearchTimer);
    lbSearchTimer = setTimeout(lbLoad, 400);
});

/* ------------------------------------------------------------------ */
/*  Properties tab — push a Leaderboard nick into an Essential          */
/*  Graphics (MOGRT) text property on the clip selected in the          */
/*  Timeline. See spidxListGraphicTextProperties() / spidxSetGraphicText() */
/*  in host/spidx.jsx for the ExtendScript side of this.                */
/* ------------------------------------------------------------------ */

var propsStatus = $("propsStatus");
var propsSelect = $("propsSelect");
var propsNickHint = $("propsNickHint");
var propsNickInput = $("propsNickInput");
var propsApplyBtn = $("propsApply");
var propsMessage = $("propsMessage");
var propsApplying = false; // guards against poll()'s auto-refresh rebuilding the dropdown mid-click

// Reflects whatever's selected on the Leaderboard tab — no separate big
// dropdown to pick from twice, clicking a row there is the picker.
// Manual typing in propsNickInput still works and isn't overwritten by
// this except right when a new Leaderboard row is clicked.
function propsShowSelectedNick(nick) {
    if (!propsNickHint) return;
    if (nick) {
        propsNickHint.textContent = "Using \u201c" + nick + "\u201d from Leaderboard.";
        propsNickHint.className = "card-sub ok";
    } else {
        propsNickHint.textContent = "Click a row on the Leaderboard tab to pick a nick, or type one below.";
        propsNickHint.className = "card-sub";
    }
}

// Called once when the tab is opened and then automatically from
// poll() every POLL_MS while it's the active tab — no manual Refresh
// button needed, it just tracks whatever's selected on the Timeline.
// The dropdown is rebuilt each call, but the previously-picked property
// is restored if it's still in the new list, so re-polling doesn't
// interrupt the user mid-pick.
function propsRefresh() {
    if (propsApplying) return;

    var previousChoice = propsSelect.value;
    propsStatus.className = "card-sub";

    evalScript("spidxListGraphicTextProperties()")
        .then(function (result) {
            propsSelect.innerHTML = "";

            if (!result.hasClip) {
                propsStatus.textContent = "Select a Graphics (MOGRT) clip on the timeline.";
                propsApplyBtn.disabled = true;
                return;
            }
            var names = result.properties || [];
            if (!names.length) {
                propsStatus.textContent = "\"" + result.clip + "\" has no text properties Spidx could detect.";
                propsStatus.className = "card-sub error";
                propsApplyBtn.disabled = true;
                return;
            }
            names.forEach(function (name) {
                var opt = document.createElement("option");
                opt.value = name;
                opt.textContent = name;
                propsSelect.appendChild(opt);
            });
            if (names.indexOf(previousChoice) !== -1) propsSelect.value = previousChoice;

            propsStatus.textContent = "\"" + result.clip + "\" \u2014 " + names.length
                + " text propert" + (names.length === 1 ? "y" : "ies") + " found.";
            propsStatus.className = "card-sub ok";
            propsApplyBtn.disabled = false;
        })
        .catch(function (err) {
            propsStatus.textContent = err.message;
            propsStatus.className = "card-sub error";
        });
}

propsApplyBtn.addEventListener("click", function () {
    var propName = propsSelect.value;
    var nick = (propsNickInput.value || "").replace(/^\s+|\s+$/g, "");

    if (!propName) {
        propsMessage.textContent = "Pick a text property first.";
        propsMessage.className = "card-sub error";
        return;
    }
    if (!nick) {
        propsMessage.textContent = "Pick a nick from the list or type one.";
        propsMessage.className = "card-sub error";
        return;
    }

    propsApplying = true;
    propsApplyBtn.disabled = true;
    evalScript("spidxSetGraphicText(" + esArg(propName) + ", " + esArg(nick) + ")")
        .then(function () {
            propsMessage.textContent = "Set \"" + propName + "\" to: " + nick;
            propsMessage.className = "card-sub ok";
            propsApplying = false;
            propsApplyBtn.disabled = false;
        })
        .catch(function (err) {
            propsMessage.textContent = err.message;
            propsMessage.className = "card-sub error";
            propsApplying = false;
            propsApplyBtn.disabled = false;
        });
});

/* ---------------------------------------------------------------------- */
/*  Boot                                                                  */
/* ---------------------------------------------------------------------- */

(function boot() {
    var savedCount = Number(localStorage.getItem(BATCH_COUNT_KEY));
    folderNameInput.value = localStorage.getItem(FOLDER_NAME_KEY) || "";
    setSelectedBatchCount(savedCount === 2 || savedCount === 3 ? savedCount : 1);
    setBatchControlsLocked(false);
    updateFolderLabel();
    updatePresetLabel();

    if (!incomingPath) {
        setCard("Link the incoming folder", 'Click "Change incoming folder" and pick App\\incoming.');
    } else {
        evalScript("spidxContext()").then(function (context) {
            if (context.hasComp) setCard("Ready", context.comp + " — frame " + context.frame);
            else setCard("Ready", "No sequence active yet.");
        }).catch(function () { /* panel still works; the first click reports the real error */ });
    }

    poll();
    setInterval(poll, POLL_MS);
})();
