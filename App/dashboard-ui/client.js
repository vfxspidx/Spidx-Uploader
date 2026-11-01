let data = null;

function $(id) { return document.getElementById(id); }
function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
}

function toast(message, kind) {
    const el = $("toast");
    el.textContent = t(message);
    el.className = "show " + (kind || "");
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.className = kind || ""; }, 3600);
}

function setNote(id, message, kind) {
    const el = $(id);
    el.textContent = t(message || "");
    el.className = "note" + (kind ? " " + kind : "") + (id === "forceRefreshNote" || id === "presetNote" ? "" : "");
    if (id === "forceRefreshNote" || id === "presetNote") el.style.marginTop = "0";
}

function fmtTime(ms) {
    if (!ms) return "";
    const d = new Date(ms);
    return d.toLocaleString(I18N_LANG, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function relTime(ms) {
    if (!ms) return "";
    const diff = Math.round((Date.now() - ms) / 1000);
    if (diff < 60) return t("just now");
    if (diff < 3600) return t("{n} min ago", { n: Math.floor(diff / 60) });
    if (diff < 86400) return t("{n} h ago", { n: Math.floor(diff / 3600) });
    return fmtTime(ms);
}

function daysText(n) {
    return n === 1 ? t("{n} day", { n: n }) : t("{n} days", { n: n });
}

/* ---------------- tabs ---------------- */
function switchToPage(pageName) {
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (tb) { tb.classList.toggle("active", tb.dataset.page === pageName); });
    Array.prototype.forEach.call(document.querySelectorAll(".page"), function (p) { p.classList.toggle("active", p.id === "page-" + pageName); });
    try { window.history.replaceState(null, "", "#" + pageName); } catch (err) {}
    window.scrollTo(0, 0);
    if (pageName === "history" || pageName === "overview") loadHistory();
    if (pageName === "templates") loadTemplates();
}
Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (tab) {
    tab.addEventListener("click", function () { switchToPage(tab.dataset.page); });
});

/* ---------------- render ---------------- */
function applySubRowLocks() {
    Array.prototype.forEach.call(document.querySelectorAll(".set-row.sub"), function (row) {
        const dep = $(row.dataset.dep);
        const on = dep && dep.checked;
        row.classList.toggle("locked", !on);
        Array.prototype.forEach.call(row.querySelectorAll("input"), function (i) { i.disabled = !on; });
    });
}

function fmtBytes(n) {
    if (!isFinite(n) || n < 0) return "-";
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + " GB";
    if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
    return Math.max(1, Math.round(n / 1024)) + " KB";
}

function renderUploadProgress(p) {
    var card = $("uploadProgressCard");
    if (!p || !p.total) { card.style.display = "none"; return; }
    card.style.display = "";
    var pct = Math.max(0, Math.min(100, Math.round(100 * p.sent / p.total)));
    $("uploadProgressBar").style.width = pct + "%";
    var title = p.count > 1
        ? t("{file} ({index} of {count})", { file: p.file, index: p.index, count: p.count })
        : p.file;
    $("uploadProgressFile").textContent = title;
    var eta = "";
    if (p.bytesPerSec > 1024 && p.total > p.sent) {
        var secs = Math.round((p.total - p.sent) / p.bytesPerSec);
        eta = " · " + (secs >= 3600 ? t("{h} h {m} min left", { h: Math.floor(secs / 3600), m: Math.round((secs % 3600) / 60) })
              : secs >= 60 ? t("{m} min left", { m: Math.round(secs / 60) }) : t("{s} s left", { s: secs }));
    }
    var speed = p.bytesPerSec > 1024 ? " · " + fmtBytes(p.bytesPerSec) + "/s" : "";
    $("uploadProgressText").textContent = pct + "% - " + t("{sent} of {total}", { sent: fmtBytes(p.sent), total: fmtBytes(p.total) }) + speed + eta
        + (p.resumed ? " · " + t("Continued after an interruption") : "");
}

function batchLabel(batch) {
    if (!batch || !batch.state || batch.state === "idle") return null;
    if (batch.state === "collecting") return t("Collecting {have}/{target}", { have: batch.have || 0, target: batch.target || "?" });
    if (batch.state === "uploading") return t("Uploading");
    if (batch.state === "done") return t("Just finished");
    return batch.state;
}

function render() {
    /* --- tier + helper pills --- */
    const tierPill = $("tierPill");
    // roles: "PRO + SPT" - the pill takes the colour of the highest one
    var pillRoles = (data.roles && data.roles.length) ? data.roles : (data.tier ? [data.tier] : []);
    var pillShown = pillRoles.filter(function (r) { return r !== "free" || pillRoles.length === 1; });
    var pillClass = ["dev", "tester", "pro", "spt", "free"].filter(function (r) { return pillRoles.indexOf(r) !== -1; })[0];
    tierPill.className = "pill " + (pillClass ? "tier-" + pillClass : "off");
    $("tierPillText").textContent = pillRoles.length
        ? pillShown.join(" + ").toUpperCase() + (data.trialDaysRemaining ? " · " + t("{n}d left", { n: data.trialDaysRemaining }) : "")
        : t("tier unknown");

    const helperPill = $("helperPill");
    const fresh = data.statusUpdatedAt && (Date.now() - data.statusUpdatedAt) < 90000;
    helperPill.className = "pill " + (data.engineSeen ? (fresh ? "live" : "warn") : "off");
    $("helperPillText").textContent = data.engineSeen
        ? (fresh ? t("helper running") : t("helper idle"))
        : t("helper not seen");

    $("deviceBanner").classList.toggle("show", !!data.deviceLimitReached);

    /* --- license expiry warning: shown for the last 3 days --- */
    var EXPIRY_WARN_DAYS = 3;
    var expiring = data.tier && data.tier !== "free" && data.trialDaysRemaining && data.trialDaysRemaining <= EXPIRY_WARN_DAYS;
    $("expiryBanner").classList.toggle("show", !!expiring);
    if (expiring) {
        $("expiryText").textContent = t("Your {tier} license expires in {days} ({date}), after which this app falls back to Free.", {
            tier: data.tier.toUpperCase(), days: daysText(data.trialDaysRemaining), date: data.expiresAt
        });
    }

    /* --- big upload progress (video) --- */
    renderUploadProgress(data.uploadProgress);

    /* --- tiles --- */
    const busy = batchLabel(data.batch);
    $("engineState").textContent = busy || (data.engineSeen ? (fresh ? t("Running") : t("Idle")) : t("Not started"));
    $("engineSub").textContent = data.statusUpdatedAt
        ? t("Last reported {when}", { when: relTime(data.statusUpdatedAt) })
        : t("Start the helper from the tray to refresh this.");

    $("destValue").textContent = data.destination === "drive" ? "Google Drive" : "WorkUpload";
    $("destSub").textContent = data.driveAllowed
        ? t("Both destinations available on this tier.")
        : t("Google Drive needs a paid tier.");

    const last = data.lastUpload;
    const lastLink = last && last.links && last.links[0];
    $("lastValue").textContent = last && last.fileNames && last.fileNames.length
        ? (last.fileNames.length === 1 ? last.fileNames[0] : t("{n} files", { n: last.fileNames.length }))
        : "-";
    const lastSub = $("lastSub");
    lastSub.textContent = "";
    if (lastLink) {
        const a = document.createElement("a");
        a.href = lastLink; a.target = "_blank"; a.textContent = lastLink;
        lastSub.appendChild(a);
        lastSub.appendChild(document.createElement("br"));
        lastSub.appendChild(document.createTextNode(relTime(last.savedAt)));
        $("copyLastBtn").style.display = "";
    } else {
        lastSub.textContent = last ? t("Uploaded, but no link was detected.") : t("Nothing uploaded yet.");
        $("copyLastBtn").style.display = "none";
    }

    /* --- destination --- */
    $("destWorkupload").classList.toggle("active", data.destination === "workupload");
    $("destDrive").classList.toggle("active", data.destination === "drive");
    $("destDrive").disabled = !data.driveAllowed;

    /* --- preset --- */
    const setEl = $("presetActionSet");
    const nameEl = $("presetActionName");
    if (document.activeElement !== setEl && document.activeElement !== nameEl) {
        setEl.value = data.cameraRawPreset ? data.cameraRawPreset.actionSet : "";
        nameEl.value = data.cameraRawPreset ? data.cameraRawPreset.actionName : "";
    }
    $("presetClearBtn").style.display = data.cameraRawPreset ? "" : "none";
    setEl.disabled = !data.proFeaturesAllowed;
    nameEl.disabled = !data.proFeaturesAllowed;
    $("presetSaveBtn").disabled = !data.proFeaturesAllowed;
    $("presetLockedNote").style.display = data.proFeaturesAllowed ? "none" : "";

    /* --- saved Camera Raw preset slots --- */
    var slotList = $("presetSlotList");
    var slots = data.cameraRawPresets || [];
    var activeName = data.cameraRawPreset ? data.cameraRawPreset.actionSet + "" + data.cameraRawPreset.actionName : null;
    if (!slots.length) {
        slotList.innerHTML = '<p class="hint" style="margin:0;">' + escapeHtml(t("No saved presets yet.")) + '</p>';
    } else {
        slotList.innerHTML = "";
        slots.forEach(function (slot) {
            var isActive = activeName === (slot.actionSet + "" + slot.actionName);
            var row = document.createElement("div");
            row.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin-bottom:6px;";
            var txt = document.createElement("div");
            txt.style.cssText = "min-width:0;flex:1;overflow:hidden;";
            txt.innerHTML = '<b style="display:block;font-size:13px;">' + escapeHtml(slot.label) + (isActive ? ' <span style="color:#4da3ff;font-weight:600;">' + escapeHtml(t("(active)")) + '</span>' : '') + '</b>'
                + '<span style="display:block;font-size:12px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(slot.actionSet || "-") + ' / ' + escapeHtml(slot.actionName) + '</span>';
            var actions = document.createElement("div");
            actions.style.cssText = "display:flex;gap:6px;flex-shrink:0;";
            var useBtn = document.createElement("button");
            useBtn.className = "btn ghost";
            useBtn.style.cssText = "padding:6px 11px;font-size:11.5px;";
            useBtn.textContent = isActive ? t("Active") : t("Use");
            useBtn.disabled = isActive;
            useBtn.addEventListener("click", function () { useSlot(slot.id); });
            var delBtn = document.createElement("button");
            delBtn.className = "btn danger";
            delBtn.style.cssText = "padding:6px 11px;font-size:11.5px;";
            delBtn.textContent = t("Delete");
            delBtn.addEventListener("click", function () { deleteSlot(slot.id); });
            actions.appendChild(useBtn);
            actions.appendChild(delBtn);
            row.appendChild(txt);
            row.appendChild(actions);
            slotList.appendChild(row);
        });
    }

    /* --- account tab --- */
    var tierLabel = data.tier ? data.tier.charAt(0).toUpperCase() + data.tier.slice(1) : "";
    var summary;
    if (!data.tier) {
        summary = t("Waiting for the helper to report your license...");
    } else if (data.tier === "free") {
        summary = t("Free - no license active. Enter a license code below to unlock Pro.");
    } else if (data.expiresAt) {
        var daysLeft = data.trialDaysRemaining;
        summary = daysLeft
            ? (daysLeft === 1
                ? t("{tier} - expires {date} ({n} day left).", { tier: tierLabel, date: data.expiresAt, n: daysLeft })
                : t("{tier} - expires {date} ({n} days left).", { tier: tierLabel, date: data.expiresAt, n: daysLeft }))
            : t("{tier} - expires {date}.", { tier: tierLabel, date: data.expiresAt });
    } else {
        summary = t("{tier} - lifetime, never expires.", { tier: tierLabel });
    }
    if (data.deviceLimitReached) {
        summary += " " + t("This computer is over the 2-device limit and is running as Free - remove an old device below.");
    }
    $("licenseSummary").textContent = summary;

    $("appVersionLine").textContent = data.appVersion ? t("Current version: {version}", { version: data.appVersion }) : t("Current version unknown.");
    $("footVersion").textContent = data.appVersion ? "v" + data.appVersion : "";
    renderConsent(data.consent);
    renderPresets(data.presets);
    renderHotkey(data.hotkey);

    var aeStatus = data.plugins && data.plugins.ae;
    var pproStatus = data.plugins && data.plugins.ppro;
    var psStatus = data.plugins && data.plugins.ps;
    var vegasStatus = data.plugins && data.plugins.vegas;
    function pluginLabel(p) {
        if (!p) return t("unknown");
        if (!p.installed) return t("not installed");
        var s = t("installed v{version}", { version: p.installedVersion });
        if (p.needsUpdate) s += " " + t("(v{version} available)", { version: p.bundledVersion });
        return s;
    }
    function installLabel(p) {
        if (!p || !p.installed) return t("Install");
        return p.needsUpdate ? t("Update") : t("Reinstall");
    }
    $("pluginStatusAe").textContent = pluginLabel(aeStatus);
    $("pluginStatusPpro").textContent = pluginLabel(pproStatus);
    $("pluginStatusVegas").textContent = pluginLabel(vegasStatus);
    renderPluginUpdates(data.pluginUpdates);
    $("uninstallVegasBtn").disabled = !(vegasStatus && vegasStatus.installed);
    $("installVegasBtn").disabled = false;
    $("installVegasBtn").textContent = installLabel(vegasStatus);
    $("uninstallAeBtn").disabled = !(aeStatus && aeStatus.installed);
    $("uninstallPproBtn").disabled = !(pproStatus && pproStatus.installed);
    $("installAeBtn").disabled = false;
    $("installAeBtn").textContent = installLabel(aeStatus);
    $("installPproBtn").disabled = false;      // the Premiere Pro panel is on every plan since 3.0
    $("installPproBtn").textContent = installLabel(pproStatus);
    // Real install state now comes from actually asking UPIA (/list all)
    // - see refreshPsInstallStatus() server-side. ccxAvailable/upiaAvailable
    // only ever answered "could this be installed", which is why the old
    // version showed Install as always-clickable and Uninstall as
    // available right after a successful install: neither reflected
    // whether Photoshop actually has the panel.
    if (!psStatus || !psStatus.ccxAvailable) {
        $("pluginStatusPs").textContent = t("Photoshop panel (.ccx) not found");
        $("installPsBtn").disabled = true;
        $("installPsBtn").textContent = t("Install");
        $("uninstallPsBtn").disabled = true;
    } else if (!psStatus.upiaAvailable) {
        $("pluginStatusPs").textContent = t("Creative Cloud desktop app required");
        $("installPsBtn").disabled = true;
        $("installPsBtn").textContent = t("Install");
        $("uninstallPsBtn").disabled = true;
    } else if (!psStatus.checked) {
        // status unknown (still checking, or UPIA's list isn't readable) - installing
        // doesn't depend on it, so don't lock the buttons
        $("pluginStatusPs").textContent = t("checking... (use Refresh status)");
        $("installPsBtn").disabled = false;
        $("installPsBtn").textContent = t("Install");
        $("uninstallPsBtn").disabled = false;
    } else if (psStatus.installed) {
        $("pluginStatusPs").textContent = t("installed") + (psStatus.installedVersion ? " v" + psStatus.installedVersion : "")
            + (psStatus.needsUpdate ? " " + t("(v{version} available)", { version: psStatus.bundledVersion }) : "");
        $("installPsBtn").disabled = false;
        $("installPsBtn").textContent = psStatus.needsUpdate ? t("Update") : t("Reinstall");
        $("uninstallPsBtn").disabled = false;
    } else {
        $("pluginStatusPs").textContent = t("not installed");
        $("installPsBtn").disabled = false;
        $("installPsBtn").textContent = t("Install");
        $("uninstallPsBtn").disabled = true;
    }

    /* --- settings --- */
    const s = data.settings;
    const focused = document.activeElement;
    const inSettings = focused && focused.closest && focused.closest("#page-settings");
    if (!inSettings && !window.__settingsDirty) {
        $("preferredBrowser").value = s.preferredBrowser;
        $("notificationsEnabled").checked = s.notifications.enabled;
        $("autoRetryEnabled").checked = s.autoRetry.enabled;
        $("autoRetryMaxAttempts").value = s.autoRetry.maxAttempts;
        $("autoRetryDelaySeconds").value = s.autoRetry.delaySeconds;
        $("cleanupEnabled").checked = s.cleanup.enabled;
        $("cleanupAfterDays").value = s.cleanup.afterDays;
        $("browserIdleEnabled").checked = s.browserIdle.enabled;
        $("browserIdleTimeoutSeconds").value = s.browserIdle.timeoutSeconds;
        $("batchTimeoutSeconds").value = s.batch.timeoutSeconds;
        $("compressionEnabled").checked = s.compression.enabled;
        $("compressionTargetMB").value = s.compression.targetMB;
        $("throttleEnabled").checked = s.throttle.enabled;
        $("throttleMinMs").value = s.throttle.minMs;
        $("throttleMaxMs").value = s.throttle.maxMs;
        applySubRowLocks();
    }

    /* --- events --- */
    const list = $("eventsList");
    list.innerHTML = "";
    $("eventsEmpty").style.display = data.events.length ? "none" : "";
    data.events.forEach(function (ev) {
        const li = document.createElement("li");

        const dot = document.createElement("span");
        dot.className = "ev-dot" + (ev.status === "fail" ? " fail" : ev.status === "ok" ? " ok" : "");

        const body = document.createElement("div");
        body.className = "ev-body";

        const summary = document.createElement("div");
        summary.className = "ev-summary" + (ev.status === "fail" ? " fail" : "");
        summary.textContent = ev.summary;

        const time = document.createElement("div");
        time.className = "ev-time";
        time.textContent = fmtTime(ev.time);

        body.appendChild(summary);
        body.appendChild(time);
        li.appendChild(dot);
        li.appendChild(body);
        list.appendChild(li);
    });
}

Array.prototype.forEach.call(document.querySelectorAll(".set-row .switch input"), function (input) {
    input.addEventListener("change", applySubRowLocks);
});

/* ---------------- data ---------------- */
async function refresh() {
    try {
        const res = await fetch("/data");
        if (!res.ok) {
            const errBody = await res.json().catch(() => ({}));
            throw new Error(errBody.error || ("HTTP " + res.status));
        }
        data = await res.json();
        render();
        renderExtras();
        $("dashboardErrorBanner").classList.remove("show");
        if (!tourStarted) {
            tourStarted = true;
            if (!data.tourSeen) setTimeout(startTour, 500); // small delay so the page visibly settles first
        }
    } catch (e) {
        console.error("Dashboard refresh failed:", e);
        $("dashboardErrorText").textContent = t("Couldn't load live data ({error}). Retrying...", { error: e.message });
        $("dashboardErrorBanner").classList.add("show");
    }
}

function restartMessage(verb, restartStatus) {
    if (restartStatus === "now") return t("{action} - helper is restarting now, ready in a few seconds.", { action: verb });
    if (restartStatus === "deferred") return t("{action} - will restart once the current upload finishes.", { action: verb });
    return t("{action} - will apply next time the helper starts.", { action: verb });
}

$("uploadCancelBtn").addEventListener("click", function () {
    if (!confirm(t("Cancel this upload? A half-finished upload is discarded and has to start again from the beginning."))) return;
    $("uploadCancelBtn").disabled = true;
    fetch("/cancel-upload", { method: "POST" }).then(function (r) { return r.json(); }).then(function (res) {
        $("uploadCancelNote").textContent = res && res.ok ? t("Cancelling...") : t("Could not cancel.");
        setTimeout(function () { $("uploadCancelBtn").disabled = false; $("uploadCancelNote").textContent = ""; refresh(); }, 3000);
    }).catch(function () { $("uploadCancelBtn").disabled = false; $("uploadCancelNote").textContent = t("Could not cancel."); });
});

$("copyLastBtn").addEventListener("click", function () {
    const link = data && data.lastUpload && data.lastUpload.links && data.lastUpload.links.join("\n");
    if (!link) return;
    navigator.clipboard.writeText(link).then(
        function () { toast("Link copied to clipboard", "ok"); },
        function () { toast("Could not access the clipboard", "err"); }
    );
});

$("forceRefreshBtn").addEventListener("click", async function () {
    setNote("forceRefreshNote", "Refreshing...");
    try {
        const res = await fetch("/force-refresh-tier", { method: "POST" });
        const result = await res.json();
        if (result.ok) {
            setNote("forceRefreshNote", restartMessage(t("Cache cleared"), result.restarted), "ok");
            toast("Tier cache cleared", "ok");
        } else {
            setNote("forceRefreshNote", result.message || "Could not refresh.", "err");
        }
    } catch (e) {
        setNote("forceRefreshNote", "Could not reach the dashboard server.", "err");
    }
    refresh();
});

/* ---------------- account tab ---------------- */
$("logoutBtn").addEventListener("click", async function () {
    if (!confirm(t("Log out? This clears your Google sign-in and restarts Spidx Uploader - the tray icon will briefly disappear and come back, and you'll sign in again."))) return;
    setNote("logoutNote", "Logging out...");
    try {
        const res = await fetch("/logout", { method: "POST" });
        const result = await res.json();
        if (result.ok) {
            setNote("logoutNote", result.canQuit ? "Logged out - restarting..." : "Logged out. Restart the app manually from the tray.", "ok");
        } else {
            setNote("logoutNote", result.message || "Could not log out.", "err");
        }
    } catch (e) {
        // A genuine fetch failure (server unreachable, network error, etc.)
        // used to be swallowed here as if it were success, on the theory
        // that the app quitting out from under the request would also land
        // here. It won't: the server answers with ok:true a full 300ms
        // before it actually restarts, specifically so this fetch has time
        // to complete first. So if we're here, something real broke -
        // report it instead of hiding it behind a fake "restarting" message.
        setNote("logoutNote", t("Could not reach the dashboard server: {error}", { error: e.message }), "err");
    }
});

function renderUpdateInfo(info) {
    if (!info) return;
    if (info.hasUpdate) {
        setNote("updateNote", t("Version {version} is available.", { version: info.latestVersion }), "ok");
        $("openReleaseBtn").style.display = "";
        $("openReleaseBtn").onclick = function () { window.open(info.downloadUrl, "_blank"); };
        // "Install update" only shows up if the release actually has a .exe
        // asset to fetch (findInstallerAsset() in update-check.js) - if not,
        // "Open release page" is the only way, same as before.
        $("installUpdateBtn").style.display = info.installerAssetUrl ? "" : "none";
    } else {
        setNote("updateNote", info.lastError ? t("Could not check ({error}).", { error: info.lastError }) : t("You're up to date."), info.lastError ? "err" : "ok");
        $("openReleaseBtn").style.display = "none";
        $("installUpdateBtn").style.display = "none";
    }
}
fetch("/update-info").then(function (r) { return r.json(); }).then(renderUpdateInfo).catch(function () {});
$("checkUpdateBtn").addEventListener("click", async function () {
    setNote("updateNote", "Checking...");
    try {
        const res = await fetch("/check-update", { method: "POST" });
        renderUpdateInfo(await res.json());
    } catch (e) {
        setNote("updateNote", "Could not reach the dashboard server.", "err");
    }
});
$("installUpdateBtn").addEventListener("click", async function () {
    if (!confirm(t("Download and launch the installer now? Close Photoshop/After Effects/Premiere first if they're open."))) return;
    var btn = $("installUpdateBtn");
    btn.disabled = true;
    setNote("updateNote", "Downloading update...");
    try {
        const res = await fetch("/install-update", { method: "POST" });
        const data = await res.json();
        if (data.ok) {
            setNote("updateNote", "Downloaded. The installer window should open now - follow its steps to finish updating.", "ok");
        } else {
            setNote("updateNote", data.message || "Could not download the update.", "err");
        }
    } catch (e) {
        setNote("updateNote", "Could not reach the dashboard server.", "err");
    }
    btn.disabled = false;
});

function uninstallPlugin(key, btnId) {
    return async function () {
        if (!confirm(t("Uninstall this plugin? A console window will open to remove it - close the host app first if it's running."))) return;
        setNote("pluginNote", "Opening uninstaller...");
        try {
            const res = await fetch("/uninstall-plugin", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ plugin: key })
            });
            const result = await res.json();
            setNote("pluginNote", result.ok ? "Uninstaller opened - follow the console window." : (result.message || "Could not uninstall."), result.ok ? "ok" : "err");
        } catch (e) {
            setNote("pluginNote", "Could not reach the dashboard server.", "err");
        }
    };
}
$("uninstallAeBtn").addEventListener("click", uninstallPlugin("ae"));
$("uninstallPproBtn").addEventListener("click", uninstallPlugin("ppro"));
$("uninstallVegasBtn").addEventListener("click", uninstallPlugin("vegas"));
$("uninstallPsBtn").addEventListener("click", uninstallPlugin("ps"));

function installPlugin(key) {
    return async function () {
        setNote("pluginNote", "Opening installer...");
        try {
            const res = await fetch("/install-plugin", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ plugin: key })
            });
            const result = await res.json();
            const okMsg = key === "ps"
                ? t("Installer opened (allow the administrator prompt) - follow the console window; this page updates by itself when it finishes.")
                : t("Installer opened - follow the console window.");
            setNote("pluginNote", result.ok ? okMsg : (result.message || "Could not install."), result.ok ? "ok" : "err");
        } catch (e) {
            setNote("pluginNote", "Could not reach the dashboard server.", "err");
        }
    };
}
$("installAeBtn").addEventListener("click", installPlugin("ae"));
$("installPproBtn").addEventListener("click", installPlugin("ppro"));
$("installVegasBtn").addEventListener("click", installPlugin("vegas"));
$("installPsBtn").addEventListener("click", installPlugin("ps"));
$("refreshPsStatusBtn").addEventListener("click", async function () {
    setNote("pluginNote", "Checking...");
    try {
        await fetch("/refresh-ps-status", { method: "POST" });
        setTimeout(refresh, 800); // give the UPIA /list call a moment to finish
    } catch (e) {
        setNote("pluginNote", "Could not reach the dashboard server.", "err");
    }
});

$("backupBtn").addEventListener("click", function () {
    window.open("/backup-config", "_blank");
});
$("restoreBtn").addEventListener("click", function () { $("restoreFile").click(); });
$("restoreFile").addEventListener("change", async function () {
    const file = this.files && this.files[0];
    this.value = "";
    if (!file) return;
    setNote("backupNote", "Restoring...");
    try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const res = await fetch("/restore-config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(parsed)
        });
        const result = await res.json();
        setNote("backupNote", result.ok ? restartMessage(t("Restored"), result.restarted) : (result.message || "Could not restore."), result.ok ? "ok" : "err");
        if (result.ok) refresh();
    } catch (e) {
        setNote("backupNote", "That file isn't valid JSON.", "err");
    }
});


/* ---------------- global shortcut ---------------- */
var hotkeyLoadedOnce = false;
var HOTKEY_DEFAULTS = { send: "Ctrl+Alt+U", sendPs: "Ctrl+Alt+Shift+U" };
var HOTKEY_NAMED = { " ": "Space", "Tab": "Tab", "Enter": "Enter", "Insert": "Insert", "Delete": "Delete", "Home": "Home", "End": "End",
    "PageUp": "PageUp", "PageDown": "PageDown", "ArrowLeft": "Left", "ArrowUp": "Up", "ArrowRight": "Right", "ArrowDown": "Down", "PrintScreen": "PrintScreen" };

// Turns a keydown into "Ctrl+Alt+U" (null while only modifiers are held / for keys the shortcut can't use).
function hotkeyFromEvent(e) {
    var key = e.key;
    if (key === "Control" || key === "Alt" || key === "Shift" || key === "Meta") return null;
    var name = null;
    if (/^[a-zA-Z]$/.test(key)) name = key.toUpperCase();
    else if (/^[0-9]$/.test(key)) name = key;
    else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) name = key;
    else if (HOTKEY_NAMED[key]) name = HOTKEY_NAMED[key];
    if (!name) return null;
    if (!(e.ctrlKey || e.altKey || e.shiftKey || e.metaKey)) return null;
    return (e.ctrlKey ? "Ctrl+" : "") + (e.altKey ? "Alt+" : "") + (e.shiftKey ? "Shift+" : "") + (e.metaKey ? "Win+" : "") + name;
}

function wireHotkeyInput(id) {
    var input = $(id);
    var before = "";
    input.addEventListener("focus", function () { before = input.value; input.placeholder = t("Press the keys..."); input.select(); });
    input.addEventListener("blur", function () { input.placeholder = ""; if (!input.value) input.value = before; });
    input.addEventListener("keydown", function (e) {
        e.preventDefault();
        if (e.key === "Escape") { input.value = before; input.blur(); return; }
        var combo = hotkeyFromEvent(e);
        if (combo) { input.value = combo; before = combo; input.blur(); }
    });
}
wireHotkeyInput("hotkeySend");
wireHotkeyInput("hotkeySendPs");

function renderHotkey(info) {
    if (!info) return;
    if (!hotkeyLoadedOnce) {
        hotkeyLoadedOnce = true;
        $("hotkeyEnabled").checked = info.config.enabled;
        $("hotkeySend").value = info.config.send;
        $("hotkeySendPs").value = info.config.sendPs;
        applySubRowLocks();
    }
    var el = $("hotkeyStatus");
    var s = info.status;
    var text, kind = "";
    if (!info.state.supported) { text = t("The global shortcut works on Windows only."); kind = "err"; }
    else if (!info.config.enabled) { text = t("Off."); }
    else if (info.state.lastError) { text = info.state.lastError; kind = "err"; }
    else if (!s) { text = t("Starting... (the first start builds a small helper program - a few seconds).");}
    else if (s.error) { text = t("{error} Pick another shortcut and save.", { error: s.error }); kind = "err"; }
    else { text = t("Active: {send} sends a frame, {sendPs} sends it through Photoshop.", { send: s.send.combo, sendPs: s.sendPs.combo }); kind = "ok"; }
    el.textContent = text;
    el.className = "note" + (kind ? " " + kind : "");
}

$("hotkeySaveBtn").addEventListener("click", async function () {
    var out = await presetRequest("/save-hotkey", { enabled: $("hotkeyEnabled").checked, send: $("hotkeySend").value, sendPs: $("hotkeySendPs").value });
    setNote("hotkeyNote", out.ok ? "Saved - applied in a few seconds." : (out.message || "Could not save."), out.ok ? "ok" : "err");
    if (out.ok) { hotkeyLoadedOnce = false; refresh(); }
});

$("hotkeyResetBtn").addEventListener("click", function () {
    $("hotkeySend").value = HOTKEY_DEFAULTS.send;
    $("hotkeySendPs").value = HOTKEY_DEFAULTS.sendPs;
    $("hotkeyEnabled").checked = true;
    applySubRowLocks();
    setNote("hotkeyNote", "Defaults restored - press Save to apply.", "");
});

/* ---------------- client presets ---------------- */
function presetRequest(url, body) {
    return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }).then(function (r) { return r.json(); });
}

function renderPresets(info) {
    var list = $("presetList");
    list.textContent = "";
    var items = (info && info.items) || [];
    $("presetsEmpty").style.display = items.length ? "none" : "";
    items.forEach(function (p) {
        var row = document.createElement("div");
        row.className = "hist-row";
        row.style.gridTemplateColumns = "minmax(0, 1fr) auto";

        var main = document.createElement("div");
        main.className = "hist-main";
        var name = document.createElement("div");
        name.className = "hist-files";
        name.textContent = p.name;
        main.appendChild(name);
        var chips = document.createElement("div");
        chips.className = "hist-chips";
        if (p.active) chips.appendChild(histChip(p.modified ? t("Active (modified)") : t("Active"), p.modified ? "ps" : "src"));
        p.summary.forEach(function (s) { chips.appendChild(histChip(s)); });
        main.appendChild(chips);
        row.appendChild(main);

        var actions = document.createElement("div");
        actions.className = "hist-actions";
        function act(label, fn) {
            var b = document.createElement("button");
            b.className = "mini-btn";
            b.textContent = label;
            b.addEventListener("click", fn);
            actions.appendChild(b);
        }
        act(p.active && !p.modified ? t("Applied") : t("Apply"), async function () {
            var out = await presetRequest("/presets/apply", { name: p.name });
            setNote("presetsNote", out.ok ? (t("Preset “{name}” applied.", { name: p.name }) + (out.message ? " " + t(out.message) : "")) : (out.message || "Could not apply."), out.ok ? "ok" : "err");
            refresh();
        });
        act(t("Update from current"), async function () {
            if (!confirm(t("Overwrite preset “{name}” with the current setup?", { name: p.name }))) return;
            var out = await presetRequest("/presets/save", { name: p.name, overwrite: true });
            setNote("presetsNote", out.ok ? "Preset updated." : (out.message || "Could not update."), out.ok ? "ok" : "err");
            refresh();
        });
        act(t("Delete"), async function () {
            if (!confirm(t("Delete preset “{name}”?", { name: p.name }))) return;
            await presetRequest("/presets/delete", { name: p.name });
            refresh();
        });
        row.appendChild(actions);
        list.appendChild(row);
    });
}

$("presetSaveClientBtn").addEventListener("click", async function () {
    var name = ($("presetName").value || "").trim();
    if (!name) { setNote("presetsNote", "Give the preset a name first.", "err"); return; }
    var out = await presetRequest("/presets/save", { name: name });
    setNote("presetsNote", out.ok ? t("Saved “{name}”.", { name: name }) : (out.message || "Could not save."), out.ok ? "ok" : "err");
    if (out.ok) $("presetName").value = "";
    refresh();
});

/* ---------------- upload history ---------------- */
var historyItems = [];

function histChip(text, cls) {
    var c = document.createElement("span");
    c.className = "chip" + (cls ? " " + cls : "");
    c.textContent = text;
    return c;
}

async function loadHistory() {
    try {
        var res = await fetch("/history");
        var out = await res.json();
        historyItems = out.items || [];
        renderHistory();
    } catch (e) { /* the next poll retries */ }
}

$("histSearch").addEventListener("input", renderHistory);
$("histClearBtn").addEventListener("click", async function () {
    if (!historyItems.length) return;
    if (!confirm(t("Delete the whole upload history? (The uploaded files and their links stay valid - only this list is cleared.)"))) return;
    await fetch("/history/clear", { method: "POST" });
    loadHistory();
    toast("History cleared.", "ok");
});
setInterval(function () { if ($("page-history").classList.contains("active") || $("page-overview").classList.contains("active")) loadHistory(); }, 5000);
document.querySelector('.tab[data-page="history"]').addEventListener("click", loadHistory);

/* ---------------- legal consent ---------------- */
function renderConsent(consent) {
    var banner = $("legalBanner");
    if (!consent) { banner.style.display = "none"; return; }
    banner.style.display = consent.accepted ? "none" : "";
    if (!consent.accepted) {
        $("legalBannerTitle").textContent = consent.acceptedVersion
            ? t("The Terms of Service or Privacy Policy changed")
            : t("Please review the Terms of Service, the EULA and the Privacy Policy");
        $("legalBannerText").textContent = consent.acceptedVersion
            ? t("You accepted an earlier version ({version}). Please read the current texts and accept them to keep using Spidx Uploader.", { version: consent.acceptedVersion })
            : t("Spidx Uploader asks you to accept them once. Nothing is blocked while you read them.");
    }
    $("consentLine").textContent = consent.accepted
        ? t("You accepted version {version} on {date}.", { version: consent.acceptedVersion, date: new Date(consent.acceptedAt).toLocaleDateString(I18N_LANG) })
        : t("Not accepted yet.");
}

$("acceptLegalBtn").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    try {
        var res = await fetch("/accept-legal", { method: "POST" });
        var out = await res.json();
        if (out.ok) { renderConsent(out.consent); toast("Thanks - saved.", "ok"); }
        else toast(out.message || "Could not save.", "err");
    } catch (e) {
        toast("Could not reach the dashboard server.", "err");
    }
    btn.disabled = false;
});

/* ---------------- plugin updates ---------------- */
function renderPluginUpdates(info) {
    var label = $("pluginUpdatesStatus");
    var dl = $("downloadPluginUpdatesBtn");
    if (!info) { label.textContent = t("unknown"); dl.style.display = "none"; return; }
    if (info.updates && info.updates.length) {
        label.textContent = t("available: {list}", { list: info.updates.map(function (u) { return u.label + " (" + u.remoteVersion + ")"; }).join(", ") });
        dl.style.display = "";
    } else {
        label.textContent = info.error ? t("couldn't check ({error})", { error: info.error }) : t("up to date");
        dl.style.display = "none";
    }
}

$("checkPluginUpdatesBtn").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    setNote("pluginNote", "Checking GitHub...");
    try {
        var res = await fetch("/plugin-updates?force=1");
        var info = await res.json();
        renderPluginUpdates(info);
        setNote("pluginNote", info.error ? t("Could not check: {error}", { error: info.error }) : (info.updates.length ? t("Plugin updates found.") : t("All plugins are up to date.")), info.error ? "err" : "ok");
    } catch (e) {
        setNote("pluginNote", "Could not reach the dashboard server.", "err");
    }
    btn.disabled = false;
});

$("downloadPluginUpdatesBtn").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    setNote("pluginNote", "Downloading plugin updates...");
    try {
        var res = await fetch("/download-plugin-updates", { method: "POST" });
        var out = await res.json();
        var failed = (out.results || []).filter(function (r) { return !r.ok; });
        if (failed.length) {
            setNote("pluginNote", t("Some updates failed: {list}", { list: failed.map(function (r) { return r.label + " - " + t(r.message || ""); }).join("; ") }), "err");
        } else if (!(out.results || []).length) {
            setNote("pluginNote", out.message || "Nothing to download.", out.ok ? "ok" : "err");
        } else {
            setNote("pluginNote", "Downloaded. Now close the host app and click Update next to each plugin above to put the new version in place.", "ok");
        }
        refresh();
    } catch (e) {
        setNote("pluginNote", "Could not reach the dashboard server.", "err");
    }
    btn.disabled = false;
});

/* ---------------- diagnostics ---------------- */
var STATUS_COLORS = { ok: "var(--ok)", warn: "#ffb020", fail: "var(--err)", info: "var(--text-dim)" };
var STATUS_WORDS = { ok: t("OK"), warn: t("WARN"), fail: t("FAIL"), info: t("info") };

function renderSelfTest(result) {
    var box = $("selfTestResults");
    box.textContent = "";
    var head = document.createElement("div");
    head.style.cssText = "font-size:12.5px;font-weight:600;margin-bottom:8px;";
    head.textContent = t("{ok} ok, {warn} warning(s), {fail} failed", { ok: result.summary.ok, warn: result.summary.warn, fail: result.summary.fail });
    box.appendChild(head);
    result.checks.forEach(function (c) {
        var row = document.createElement("div");
        row.style.cssText = "display:flex;gap:10px;align-items:baseline;padding:6px 10px;border:1px solid var(--line);border-radius:8px;margin-bottom:5px;font-size:12px;";
        var tag = document.createElement("span");
        tag.style.cssText = "flex-shrink:0;width:42px;font-weight:700;color:" + (STATUS_COLORS[c.status] || "inherit") + ";";
        tag.textContent = STATUS_WORDS[c.status] || c.status;
        var txt = document.createElement("span");
        txt.style.cssText = "min-width:0;word-break:break-word;";
        var strong = document.createElement("b");
        strong.textContent = t(c.label);
        txt.appendChild(strong);
        if (c.detail) txt.appendChild(document.createTextNode(" - " + t(c.detail)));
        row.appendChild(tag);
        row.appendChild(txt);
        box.appendChild(row);
    });
}

$("selfTestBtn").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    setNote("diagNote", "Running checks...");
    try {
        var res = await fetch("/self-test");
        renderSelfTest(await res.json());
        setNote("diagNote", "");
    } catch (e) {
        setNote("diagNote", "Could not run the self-test.", "err");
    }
    btn.disabled = false;
});

$("makeDiagBtn").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    setNote("diagNote", "Collecting files...");
    try {
        var res = await fetch("/make-diagnostics", { method: "POST" });
        var out = await res.json();
        if (!out.ok) {
            setNote("diagNote", out.message || "Could not create the file.", "err");
        } else {
            setNote("diagNote", t("Created: {path} - the folder is opening. Send that .zip to support.", { path: out.path }), "ok");
            fetch("/open-diagnostics-folder", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: out.path })
            });
        }
    } catch (e) {
        setNote("diagNote", "Could not reach the dashboard server.", "err");
    }
    btn.disabled = false;
});

// Support: the address is a mailto link; many people have no mail program, so "Copy address" is there too.
$("copySupportBtn").addEventListener("click", function () {
    var address = $("supportLink").textContent;
    function done(ok) { $("copySupportNote").textContent = ok ? t("Copied.") : t("Copy failed - select the address and copy it."); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(address).then(function () { done(true); }, function () { done(false); });
    } else {
        done(false);
    }
});

function describeTier(result) {
    if (!result.tier) return "";
    var label = String(result.tier).toUpperCase().replace(/[+,| ]+/g, " + "); // "pro+spt" -> "PRO + SPT"
    // null trialDaysRemaining = no expiry (lifetime), same convention the
    // license server uses.
    if (!result.trialDaysRemaining) return t("{tier} (lifetime)", { tier: label });
    return result.trialDaysRemaining === 1
        ? t("{tier} ({n} day left)", { tier: label, n: result.trialDaysRemaining })
        : t("{tier} ({n} days left)", { tier: label, n: result.trialDaysRemaining });
}

$("expiryEnterCode").addEventListener("click", function (e) {
    e.preventDefault();
    document.querySelector('.tab[data-page="account"]').click();
    $("licenseCodeInput").focus();
});

$("licenseRedeemBtn").addEventListener("click", async function () {
    const input = $("licenseCodeInput");
    const code = input.value.trim();

    if (!code) {
        setNote("licenseNote", "Enter a code first.", "err");
        return;
    }

    setNote("licenseNote", "Activating...");
    try {
        const res = await fetch("/redeem-license", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code: code })
        });
        const result = await res.json();
        if (result.ok) {
            input.value = "";
            const restartNote = result.restarted === "now"
                ? " " + t("Helper is restarting now.")
                : result.restarted === "deferred" ? " " + t("Helper will restart once the current upload finishes.") : "";
            const tierNote = describeTier(result);
            setNote("licenseNote", (result.ambiguous
                ? t(result.message || "") + " " + t("Current license: {tier}.", { tier: tierNote })
                : t("Activated - you now have {tier}.", { tier: tierNote })) + restartNote, "ok");
            toast(t("License activated - {tier}", { tier: tierNote }), "ok");
        } else {
            setNote("licenseNote", result.message || "Could not activate this code.", "err");
        }
    } catch (e) {
        setNote("licenseNote", "Could not reach the dashboard server.", "err");
    }
    refresh();
    loadDevices();
});
$("licenseCodeInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") $("licenseRedeemBtn").click();
});

/* ---------------- devices ---------------- */
function formatDeviceDate(value) {
    if (!value) return "";
    var d = new Date(value);
    if (isNaN(d.getTime())) return "";
    return d.toISOString().slice(0, 10);
}

async function loadDevices() {
    var list = $("deviceList");
    try {
        const res = await fetch("/list-devices");
        const result = await res.json();
        if (!result.ok) {
            list.innerHTML = '<p class="hint" style="margin:0;">' + escapeHtml(result.message ? t(result.message) : t("Could not load devices.")) + '</p>';
            return;
        }
        var devices = result.devices || [];
        if (!devices.length) {
            list.innerHTML = '<p class="hint" style="margin:0;">' + escapeHtml(t("No devices registered yet - a device is added the first time you use a paid license on it.")) + '</p>';
            return;
        }
        list.innerHTML = "";
        devices.forEach(function (device) {
            var row = document.createElement("div");
            row.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin-bottom:6px;";
            var txt = document.createElement("div");
            txt.style.cssText = "min-width:0;flex:1;overflow:hidden;";
            var added = formatDeviceDate(device.addedAt);
            var label = device.name ? escapeHtml(device.name) : escapeHtml(device.isThisDevice ? t("This computer") : t("Another computer"));
            txt.innerHTML = '<b style="display:block;font-size:13px;">' + label
                + (device.isThisDevice ? ' <span style="color:#4da3ff;font-weight:600;">' + escapeHtml(t("(you are here)")) + '</span>' : '') + '</b>'
                + '<span style="display:block;font-size:12px;color:var(--dim);">' + escapeHtml(t("ID {id}", { id: String(device.deviceId).slice(0, 8) }))
                + (added ? " · " + escapeHtml(t("added {date}", { date: added })) : "") + '</span>';
            var btn = document.createElement("button");
            btn.className = "btn danger";
            btn.style.cssText = "padding:6px 11px;font-size:11.5px;flex-shrink:0;";
            btn.textContent = t("Remove");
            btn.addEventListener("click", function () { removeDevice(device); });
            row.appendChild(txt);
            row.appendChild(btn);
            list.appendChild(row);
        });
    } catch (e) {
        list.innerHTML = '<p class="hint" style="margin:0;">' + escapeHtml(t("Could not reach the dashboard server.")) + '</p>';
    }
}

async function removeDevice(device) {
    var warning = device.isThisDevice
        ? t("Remove THIS computer from your license? It will drop to Free until it re-registers (it takes a free slot again next time the helper checks in, if one is available).")
        : t("Remove this computer from your license? It will drop to Free the next time it checks in.");
    if (!confirm(warning)) return;
    setNote("devicesNote", "Removing...");
    try {
        const res = await fetch("/remove-device", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deviceId: device.deviceId })
        });
        const result = await res.json();
        setNote("devicesNote", result.ok ? "Removed." : (result.message || "Could not remove that device."), result.ok ? "ok" : "err");
        if (result.ok) { loadDevices(); refresh(); }
    } catch (e) {
        setNote("devicesNote", "Could not reach the dashboard server.", "err");
    }
}

$("devicesRefreshBtn").addEventListener("click", function () {
    setNote("devicesNote", "");
    loadDevices();
});
loadDevices();

$("destWorkupload").addEventListener("click", function () { setDestination("workupload"); });
$("destDrive").addEventListener("click", function () { setDestination("drive"); });

async function setDestination(dest) {
    setNote("destNote", "Switching...");
    try {
        const res = await fetch("/set-destination", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ destination: dest })
        });
        const result = await res.json();
        if (result.ok) {
            setNote("destNote", restartMessage(t("Switched"), result.restarted), "ok");
            toast(t("Destination: {name}", { name: dest === "drive" ? "Google Drive" : "WorkUpload" }), "ok");
        } else {
            setNote("destNote", result.message || "Could not save the destination.", "err");
        }
    } catch (e) {
        setNote("destNote", "Could not reach the dashboard server.", "err");
    }
    refresh();
}

$("presetSaveBtn").addEventListener("click", async function () {
    const actionSet = $("presetActionSet").value.trim();
    const actionName = $("presetActionName").value.trim();

    if (!actionSet || !actionName) {
        setNote("presetNote", "Enter both the Action Set and Action name.", "err");
        return;
    }

    setNote("presetNote", "Saving...");
    try {
        const res = await fetch("/set-preset", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ actionSet: actionSet, actionName: actionName })
        });
        const result = await res.json();
        if (result.ok) {
            setNote("presetNote", restartMessage(t("Saved"), result.restarted), "ok");
            toast("Preset Action saved", "ok");
        } else {
            setNote("presetNote", result.message || "Could not save the preset.", "err");
        }
    } catch (e) {
        setNote("presetNote", "Could not save the preset.", "err");
    }
    refresh();
});

$("presetClearBtn").addEventListener("click", async function () {
    $("presetActionSet").value = "";
    $("presetActionName").value = "";
    try {
        const res = await fetch("/set-preset", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ actionSet: "", actionName: "" })
        });
        const result = await res.json();
        if (result.ok) {
            setNote("presetNote", restartMessage(t("Cleared"), result.restarted), "ok");
            toast("Preset cleared", "ok");
        } else {
            setNote("presetNote", result.message || "Could not clear the preset.", "err");
        }
    } catch (e) {
        setNote("presetNote", "Could not clear the preset.", "err");
    }
    refresh();
});

/* ---------------- saved Camera Raw preset slots ---------------- */
$("presetSaveSlotBtn").addEventListener("click", async function () {
    const actionSet = $("presetActionSet").value.trim();
    const actionName = $("presetActionName").value.trim();
    if (!actionName) {
        setNote("presetSlotNote", "Fill in the Action Set/Name fields above first.", "err");
        return;
    }
    const label = prompt(t("Name this preset (e.g. \"Client A\", \"Warm grade\"):"), "");
    if (label === null) return; // cancelled
    if (!label.trim()) {
        setNote("presetSlotNote", "Give this preset a name.", "err");
        return;
    }
    setNote("presetSlotNote", "Saving...");
    try {
        const res = await fetch("/save-preset-slot", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ label: label.trim(), actionSet, actionName })
        });
        const result = await res.json();
        setNote("presetSlotNote", result.ok ? "Saved." : (result.message || "Could not save."), result.ok ? "ok" : "err");
        if (result.ok) refresh();
    } catch (e) {
        setNote("presetSlotNote", "Could not reach the dashboard server.", "err");
    }
});

async function useSlot(id) {
    setNote("presetSlotNote", "Switching...");
    try {
        const res = await fetch("/use-preset-slot", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id })
        });
        const result = await res.json();
        if (result.ok) {
            setNote("presetSlotNote", restartMessage(t("Switched to \"{name}\"", { name: result.slot.label }), result.restarted), "ok");
            toast("Camera Raw preset switched", "ok");
            refresh();
        } else {
            setNote("presetSlotNote", result.message || "Could not switch.", "err");
        }
    } catch (e) {
        setNote("presetSlotNote", "Could not reach the dashboard server.", "err");
    }
}

async function deleteSlot(id) {
    if (!confirm(t("Delete this saved preset? This doesn't affect the active Camera Raw preset if it's currently in use."))) return;
    try {
        const res = await fetch("/delete-preset-slot", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id })
        });
        const result = await res.json();
        if (result.ok) refresh();
        else setNote("presetSlotNote", result.message || "Could not delete.", "err");
    } catch (e) {
        setNote("presetSlotNote", "Could not reach the dashboard server.", "err");
    }
}

$("saveSettingsBtn").addEventListener("click", async function () {
    setNote("saveStatus", "Saving...");

    const payload = {
        preferredBrowser: $("preferredBrowser").value,
        notifications: { enabled: $("notificationsEnabled").checked },
        autoRetry: {
            enabled: $("autoRetryEnabled").checked,
            maxAttempts: Number($("autoRetryMaxAttempts").value),
            delaySeconds: Number($("autoRetryDelaySeconds").value)
        },
        cleanup: {
            enabled: $("cleanupEnabled").checked,
            afterDays: Number($("cleanupAfterDays").value)
        },
        browserIdle: {
            enabled: $("browserIdleEnabled").checked,
            timeoutSeconds: Number($("browserIdleTimeoutSeconds").value)
        },
        batch: { timeoutSeconds: Number($("batchTimeoutSeconds").value) },
        throttle: {
            enabled: $("throttleEnabled").checked,
            minMs: Number($("throttleMinMs").value),
            maxMs: Number($("throttleMaxMs").value)
        },
        compression: { enabled: $("compressionEnabled").checked, targetMB: Number($("compressionTargetMB").value) }
    };

    try {
        const res = await fetch("/save-settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        const result = await res.json();
        if (result.ok) {
            setNote("saveStatus", restartMessage(t("Saved"), result.restarted), "ok");
            toast("Settings saved", "ok");
        } else {
            setNote("saveStatus", result.message || "Could not save settings.", "err");
        }
    } catch (e) {
        setNote("saveStatus", "Could not reach the dashboard server.", "err");
    }
});

/* ---------------- first-run tour ---------------- */
var TOUR_STEPS = [
    { page: "overview", anchor: "tourCardDest", text: t("Switch between WorkUpload and Google Drive here - it takes effect immediately, no restart needed.") },
    { page: "overview", anchor: "tourCardPreset", text: t("Set a Photoshop Action to run automatically on every file right before it uploads (Pro tiers).") },
    { page: "status", anchor: "tourCardPlugins", text: t("Install or update your Photoshop, After Effects, Premiere Pro panels and the VEGAS Pro plugin from here.") },
    { page: "settings", anchor: "tourCardSettings", text: t("Auto-cleanup, retry behavior, and other advanced options live here.") }
];
var tourStarted = false;
var tourIndex = 0;
var tourBackdrop = null, tourSpotlight = null, tourBubble = null;

function tourPositionOn(el) {
    var r = el.getBoundingClientRect();
    var pad = 8;
    tourSpotlight.style.top = (r.top - pad) + "px";
    tourSpotlight.style.left = (r.left - pad) + "px";
    tourSpotlight.style.width = (r.width + pad * 2) + "px";
    tourSpotlight.style.height = (r.height + pad * 2) + "px";

    var bubbleTop = r.bottom + 16;
    var bubbleLeft = Math.min(Math.max(r.left, 16), window.innerWidth - 316);
    if (bubbleTop + 160 > window.innerHeight) bubbleTop = Math.max(16, r.top - 170); // flip above if it'd overflow the bottom
    tourBubble.style.top = bubbleTop + "px";
    tourBubble.style.left = bubbleLeft + "px";
}

function tourShowStep(i) {
    var step = TOUR_STEPS[i];
    if (!step) { tourEnd(); return; }
    switchToPage(step.page);
    // wait a tick for the page switch to actually lay out before measuring the target
    requestAnimationFrame(function () {
        var el = $(step.anchor);
        if (!el) { tourIndex++; tourShowStep(tourIndex); return; }
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        setTimeout(function () {
            tourPositionOn(el);
            tourBubble.querySelector(".step").textContent = t("Step {n} of {total}", { n: i + 1, total: TOUR_STEPS.length });
            tourBubble.querySelector("p").textContent = step.text;
            tourBubble.querySelector(".next").textContent = (i === TOUR_STEPS.length - 1) ? t("Done") : t("Next");
        }, 220); // matches the smooth-scroll's rough settle time
    });
}

function tourEnd() {
    if (tourSpotlight) tourSpotlight.remove();
    if (tourBubble) tourBubble.remove();
    if (tourBackdrop) tourBackdrop.remove();
    tourBackdrop = tourSpotlight = tourBubble = null;
    fetch("/mark-tour-seen", { method: "POST" }).catch(function () {});
}

function startTour() {
    tourIndex = 0;

    tourBackdrop = document.createElement("div");
    tourBackdrop.className = "tour-backdrop";
    document.body.appendChild(tourBackdrop);
    requestAnimationFrame(function () { tourBackdrop.classList.add("show"); });

    tourSpotlight = document.createElement("div");
    tourSpotlight.className = "tour-spotlight";
    document.body.appendChild(tourSpotlight);

    tourBubble = document.createElement("div");
    tourBubble.className = "tour-bubble";
    tourBubble.innerHTML = '<div class="step"></div><p></p><div class="row"><button class="skip">' + escapeHtml(t("Skip tour")) + '</button><button class="next">' + escapeHtml(t("Next")) + '</button></div>';
    document.body.appendChild(tourBubble);

    tourBubble.querySelector(".skip").addEventListener("click", tourEnd);
    tourBubble.querySelector(".next").addEventListener("click", function () { tourIndex++; tourShowStep(tourIndex); });

    tourShowStep(tourIndex);
}

$("tourReplayBtn").addEventListener("click", function () { startTour(); });

/* ---------------- language picker ---------------- */
(function () {
    var sel = $("langSelect");
    var autoOpt = document.createElement("option");
    autoOpt.value = "auto";
    autoOpt.textContent = t("Automatic (system language)");
    sel.appendChild(autoOpt);
    I18N_LANGS.forEach(function (l) {
        var o = document.createElement("option");
        o.value = l.code;
        o.textContent = l.name; // native name - never translated
        sel.appendChild(o);
    });
    sel.value = I18N_PREF;
    if (sel.value !== I18N_PREF) sel.value = "auto";
    sel.addEventListener("change", async function () {
        var wanted = sel.value;
        try {
            var out = await presetRequest("/set-language", { language: wanted });
            if (out.ok) { location.reload(); return; }
            setNote("langNote", out.message || "Could not save the language.", "err");
        } catch (e) {
            setNote("langNote", "Could not reach the dashboard server.", "err");
        }
        sel.value = I18N_PREF;
        if (sel.value !== I18N_PREF) sel.value = "auto";
    });
})();

/* ======================================================================
   v3 shell: hero, recent uploads, history rows, health, settings UI,
   theme, keyboard shortcuts. (No backslashes / backticks in here - this
   whole file lives inside a template literal in dashboard.js.)
   ==================================================================== */
var NL = String.fromCharCode(10);
var UI = window.SPIDX_UI || {};

function saveUi(patch) {
    fetch("/set-ui", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }).catch(function () {});
}

function copyText(text, okMsg) {
    var done = function (ok) { toast(ok ? okMsg : "Could not copy.", ok ? "ok" : "err"); };
    try { navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); }); }
    catch (e) { done(false); }
}

/* ---------------- theme ---------------- */
(function themeUi() {
    var seg = $("themeSeg");
    function mark() {
        var cur = window.spidxGetTheme ? window.spidxGetTheme() : "auto";
        Array.prototype.forEach.call(seg.querySelectorAll("button"), function (b) { b.classList.toggle("active", b.getAttribute("data-theme-set") === cur); });
    }
    Array.prototype.forEach.call(seg.querySelectorAll("button"), function (b) {
        b.addEventListener("click", function () {
            var c = b.getAttribute("data-theme-set");
            if (window.spidxSetTheme) window.spidxSetTheme(c);
            mark();
            saveUi({ theme: c });
        });
    });
    mark();
})();

/* ---------------- file kinds / thumbnails / day labels ---------------- */
function fileKind(name) {
    var s = String(name || "");
    var i = s.lastIndexOf(".");
    var ext = i >= 0 ? s.slice(i + 1).toLowerCase() : "";
    if (["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"].indexOf(ext) !== -1) return { k: "img", ext: ext };
    if (["mp4", "mov", "mkv", "avi", "webm", "m4v", "wmv"].indexOf(ext) !== -1) return { k: "vid", ext: ext };
    return { k: "oth", ext: ext };
}

function makeThumb(e) {
    var kind = fileKind(e.files && e.files[0]);
    var th = document.createElement("div");
    th.className = "thumb " + kind.k;
    if (e.thumb) {
        var img = document.createElement("img");
        img.src = e.thumb;
        img.alt = "";
        th.appendChild(img);
    } else {
        th.textContent = (kind.ext || "file").toUpperCase().slice(0, 4);
    }
    return th;
}

function shortUrl(u) {
    try { var x = new URL(u); return x.host + (x.pathname.length > 1 ? x.pathname : ""); } catch (err) { return u; }
}

function dayLabel(ms) {
    var d = new Date(ms);
    var now = new Date();
    var a = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    var b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var diff = Math.round((b - a) / 86400000);
    if (diff === 0) return t("Today");
    if (diff === 1) return t("Yesterday");
    return d.toLocaleDateString(I18N_LANG, { weekday: "long", day: "numeric", month: "long" });
}

function clockTime(ms) {
    return new Date(ms).toLocaleTimeString(I18N_LANG, { hour: "2-digit", minute: "2-digit" });
}

function historyRow(e, compact) {
    var row = document.createElement("div");
    row.className = "h-row" + (compact ? " compact" : "");
    row.appendChild(makeThumb(e));

    var main = document.createElement("div");
    main.className = "h-main";
    var name = document.createElement("div");
    name.className = "h-name";
    name.textContent = e.files[0] + (e.files.length > 1 ? "  " + t("+{n} more", { n: e.files.length - 1 }) : "");
    name.title = e.files.join(", ");
    main.appendChild(name);

    var meta = document.createElement("div");
    meta.className = "h-meta";
    meta.appendChild(document.createTextNode(compact ? relTime(e.time) : clockTime(e.time)));
    meta.appendChild(histChip(e.destination === "drive" ? "Google Drive" : "WorkUpload"));
    if (!compact) {
        if (e.folder) meta.appendChild(histChip(e.folder));
        if (e.preset) meta.appendChild(histChip(t("Preset: {name}", { name: e.preset })));
        if (e.source === "vegas") meta.appendChild(histChip("VEGAS Pro", "src"));
        if (e.viaPhotoshop) meta.appendChild(histChip(t("via Photoshop"), "ps"));
        if (e.links && e.links[0]) {
            var a = document.createElement("a");
            a.href = e.links[0];
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            a.textContent = shortUrl(e.links[0]) + (e.links.length > 1 ? "  +" + (e.links.length - 1) : "");
            a.title = e.links.join(NL);
            meta.appendChild(a);
        }
    }
    main.appendChild(meta);
    row.appendChild(main);

    var actions = document.createElement("div");
    actions.className = "h-actions";
    if (e.links && e.links.length) {
        var copy = document.createElement("button");
        copy.className = "mini-btn";
        copy.textContent = e.links.length > 1 ? t("Copy {n}", { n: e.links.length }) : t("Copy link");
        copy.addEventListener("click", function () { copyText(e.links.join(NL), "Link copied."); });
        actions.appendChild(copy);
        if (!compact) {
            var open = document.createElement("a");
            open.className = "mini-btn";
            open.style.textDecoration = "none";
            open.href = e.links[0];
            open.target = "_blank";
            open.rel = "noopener noreferrer";
            open.textContent = t("Open");
            actions.appendChild(open);
        }
    }
    if (!compact) {
        var del = document.createElement("button");
        del.className = "mini-btn";
        del.textContent = t("Remove");
        del.addEventListener("click", async function () {
            await fetch("/history/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: e.id }) });
            loadHistory();
        });
        actions.appendChild(del);
    }
    row.appendChild(actions);
    return row;
}

/* ---------------- history page: search + filters + day groups ---------------- */
var histFilter = "all";
var HIST_FILTERS = [
    ["all", "All"], ["img", "Images"], ["vid", "Video"],
    ["drive", "Google Drive"], ["workupload", "WorkUpload"], ["vegas", "VEGAS Pro"]
];

function histMatchesFilter(e) {
    var k = fileKind(e.files && e.files[0]).k;
    switch (histFilter) {
        case "img": return k === "img";
        case "vid": return k === "vid";
        case "drive": return e.destination === "drive";
        case "workupload": return e.destination !== "drive";
        case "vegas": return e.source === "vegas";
        default: return true;
    }
}

function renderHistFilters() {
    var box = $("histFilters");
    box.textContent = "";
    HIST_FILTERS.forEach(function (f) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "fchip" + (histFilter === f[0] ? " active" : "");
        b.textContent = t(f[1]);
        b.addEventListener("click", function () { histFilter = f[0]; renderHistFilters(); renderHistory(); });
        box.appendChild(b);
    });
}

function renderRecent() {
    var list = $("recentList");
    list.textContent = "";
    var items = historyItems.slice(0, 5);
    $("recentEmpty").style.display = items.length ? "none" : "";
    items.forEach(function (e) { list.appendChild(historyRow(e, true)); });
}

function renderHistory() {
    var list = $("histList");
    var q = ($("histSearch").value || "").toLowerCase().trim();
    list.textContent = "";
    var shown = historyItems.filter(function (e) {
        if (!histMatchesFilter(e)) return false;
        if (!q) return true;
        return (e.files.join(" ") + " " + (e.folder || "") + " " + (e.preset || "") + " " + (e.destination || "") + " " + (e.source || "")).toLowerCase().indexOf(q) !== -1;
    });
    $("histEmpty").style.display = shown.length ? "none" : "";
    $("histEmpty").textContent = historyItems.length ? t("Nothing matches your search.") : t("No uploads yet - the next one shows up here.");
    var lastDay = "";
    shown.forEach(function (e) {
        var dl = dayLabel(e.time);
        if (dl !== lastDay) {
            var label = document.createElement("div");
            label.className = "daylabel";
            label.textContent = dl;
            list.appendChild(label);
            lastDay = dl;
        }
        list.appendChild(historyRow(e, false));
    });
    renderRecent();
}

renderHistFilters();
$("recentAll").addEventListener("click", function () { switchToPage("history"); });
$("heroCopyBtn").addEventListener("click", function () { $("copyLastBtn").click(); });

/* ---------------- hero ---------------- */
function renderHero() {
    var orb = $("heroOrb");
    var fresh = !!(data.statusUpdatedAt && (Date.now() - data.statusUpdatedAt) < 90000);
    var dest = data.destination === "drive" ? "Google Drive" : "WorkUpload";
    var up = data.uploadProgress;
    var b = data.batch;
    var cls, title, sub;

    if (up && up.total) {
        cls = "busy"; title = t("Uploading");
        sub = up.file + " · " + Math.max(0, Math.min(100, Math.round(100 * up.sent / up.total))) + "%";
    } else if (b && b.state === "uploading") {
        cls = "busy"; title = t("Uploading");
        sub = t("Your files are on their way to {dest}.", { dest: dest });
    } else if (b && b.state === "collecting") {
        cls = "busy"; title = t("Collecting {have}/{target}", { have: b.have || 0, target: b.target || "?" });
        sub = t("Waiting for the rest of the batch.");
    } else if (!data.engineSeen) {
        cls = "err"; title = t("Helper not running");
        sub = t("Start Spidx Uploader from the tray icon or the desktop shortcut.");
    } else if (!fresh) {
        cls = "warn"; title = t("Helper idle");
        sub = t("Last reported {when}", { when: relTime(data.statusUpdatedAt) });
    } else {
        cls = "ok"; title = t("Ready to upload");
        sub = t("Files go to {dest}. Press Upload in a Spidx panel or use the global shortcut.", { dest: dest });
    }
    orb.className = "orb " + cls;
    $("heroTitle").textContent = title;
    $("heroSub").textContent = sub;

    var chips = $("heroChips");
    chips.textContent = "";
    chips.appendChild(histChip(dest, "src"));
    if (data.presets && data.presets.active) chips.appendChild(histChip(t("Preset: {name}", { name: data.presets.active })));
    var roles = (data.roles && data.roles.length) ? data.roles : (data.tier ? [data.tier] : []);
    if (roles.length) chips.appendChild(histChip(roles.join(" + ").toUpperCase()));
    var rn = data.renders;
    if (rn && rn.limit != null) chips.appendChild(histChip(t("Renders this month: {used} of {limit}", { used: rn.used, limit: rn.limit }), rn.remaining <= 3 ? "ps" : ""));

    var last = data.lastUpload;
    $("heroCopyBtn").style.display = (last && last.links && last.links[0]) ? "" : "none";
}

/* ---------------- status / health ---------------- */
function panelHealth(label, p, allowed) {
    if (!p) return { state: "", title: label, detail: t("unknown") };
    if (!p.installed) return { state: "", title: label, detail: t("not installed") };
    if (p.needsUpdate) return { state: "warn", title: label, detail: t("installed v{version}", { version: p.installedVersion }) + " · " + t("(v{version} available)", { version: p.bundledVersion }) };
    return { state: "ok", title: label, detail: t("installed v{version}", { version: p.installedVersion }) };
}

function healthItems() {
    var items = [];
    var fresh = !!(data.statusUpdatedAt && (Date.now() - data.statusUpdatedAt) < 90000);
    items.push({
        state: data.engineSeen ? (fresh ? "ok" : "warn") : "fail",
        title: t("Helper"),
        detail: data.engineSeen
            ? (fresh ? t("Running") : t("Idle")) + " · " + t("Last reported {when}", { when: relTime(data.statusUpdatedAt) })
            : t("Not seen - start it from the tray icon.")
    });

    var roles = (data.roles && data.roles.length) ? data.roles.join(" + ").toUpperCase() : "";
    items.push({
        state: !data.tier ? "warn" : (data.deviceLimitReached ? "warn" : "ok"),
        title: t("License"),
        detail: !data.tier
            ? t("Waiting for the helper to report your license...")
            : roles + (data.trialDaysRemaining ? " · " + t("{n}d left", { n: data.trialDaysRemaining }) : "") + (data.deviceLimitReached ? " · " + t("Device limit reached") : "")
    });

    items.push({
        state: (data.destination === "drive" && !data.driveAllowed) ? "warn" : "ok",
        title: t("Destination"),
        detail: data.destination === "drive" ? "Google Drive" : "WorkUpload"
    });

    var P = data.plugins || {};
    items.push(panelHealth(t("After Effects panel"), P.ae));
    items.push(panelHealth(t("Premiere Pro panel"), P.ppro, data.pproAllowed));
    items.push(panelHealth(t("VEGAS Pro plugin"), P.vegas));

    var ps = P.ps;
    if (!ps || !ps.ccxAvailable) items.push({ state: "", title: t("Photoshop panel"), detail: t("Photoshop panel (.ccx) not found") });
    else if (!ps.upiaAvailable) items.push({ state: "warn", title: t("Photoshop panel"), detail: t("Creative Cloud desktop app required") });
    else if (!ps.checked) items.push({ state: "", title: t("Photoshop panel"), detail: t("checking... (use Refresh status)") });
    else items.push(panelHealth(t("Photoshop panel"), ps));

    var rn = data.renders;
    if (rn) {
        items.push({
            state: rn.limit == null ? "ok" : (rn.remaining === 0 ? "fail" : (rn.remaining <= 3 ? "warn" : "ok")),
            title: t("Video renders"),
            detail: rn.limit == null ? t("Unlimited") : t("{used} of {limit} used this month", { used: rn.used, limit: rn.limit })
        });
    }

    var hk = data.hotkey;
    if (hk && hk.config && hk.config.enabled) {
        var hkErr = (hk.state && hk.state.lastError) || (hk.status && hk.status.error);
        items.push({
            state: hkErr ? "fail" : (hk.status ? "ok" : "warn"),
            title: t("Global shortcut"),
            detail: hkErr ? String(hkErr) : (hk.status && hk.status.send ? hk.status.send.combo : t("Starting..."))
        });
    } else {
        items.push({ state: "", title: t("Global shortcut"), detail: t("Off.") });
    }

    if (data.consent) {
        items.push({
            state: data.consent.accepted ? "ok" : "warn",
            title: t("Terms and privacy"),
            detail: data.consent.accepted ? t("Accepted") : t("Not accepted yet.")
        });
    }
    return items;
}

function renderHealth() {
    var items = healthItems();
    var grid = $("healthGrid");
    grid.textContent = "";
    var worst = "";
    items.forEach(function (it) {
        var el = document.createElement("div");
        el.className = "h-item";
        var dot = document.createElement("span");
        dot.className = "h-dot" + (it.state ? " " + it.state : "");
        var box = document.createElement("div");
        var b = document.createElement("b");
        b.textContent = it.title;
        var s = document.createElement("span");
        s.textContent = it.detail;
        box.appendChild(b);
        box.appendChild(s);
        el.appendChild(dot);
        el.appendChild(box);
        grid.appendChild(el);
        if (it.state === "fail") worst = "fail";
        else if (it.state === "warn" && worst !== "fail") worst = "warn";
    });
    var badge = $("statusBadge");
    badge.className = "badge" + (worst ? " show" : "") + (worst === "fail" ? " err" : "");
}

$("copyReportBtn").addEventListener("click", function () {
    if (!data) return;
    var lines = ["Spidx Uploader " + (data.appVersion ? "v" + data.appVersion : "")];
    healthItems().forEach(function (it) {
        lines.push("[" + (it.state ? it.state.toUpperCase() : "--") + "] " + it.title + ": " + it.detail);
    });
    var done = function (ok) { setNote("reportNote", ok ? "Report copied - paste it into your message to support." : "Could not copy.", ok ? "ok" : "err"); };
    try { navigator.clipboard.writeText(lines.join(NL)).then(function () { done(true); }, function () { done(false); }); }
    catch (e) { done(false); }
});


/* ---------------- Templates (SPT text templates for After Effects) ---------------- */
var tplState = { entitled: true, items: [], files: [], presets: [], pack: null, mogrts: 0 };
var tplEditing = -1;     // index being edited, -1 = a new one

async function loadTemplates() {
    try {
        var res = await fetch("/templates");
        tplState = await res.json();
    } catch (e) { setNote("tplNote", "Could not reach the dashboard server.", "err"); return; }
    renderTemplates();
}

function tplStatus(it) {
    if (!it.fileExists) return { cls: "fail", text: t("File missing") };
    if (it.compFound === false) return { cls: "warn", text: t("Composition not found in the file") };
    return { cls: "ok", text: t("Ready") };
}

// position of items[i] inside the user-only list that is sent to the server
function tplUserIndex(i) {
    var n = 0;
    for (var k = 0; k < i; k++) if (tplState.items[k].source === "user") n++;
    return n;
}

function tplCurrentList() {
    // the server keeps its own entries; only the user's are sent back
    return tplState.items.filter(function (x) { return x.source === "user"; }).map(function (x) { return { file: x.file, comp: x.comp, name: x.name, textLayer: x.textLayer }; });
}

async function tplSaveList(list, okNote) {
    var res = await fetch("/templates/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: list }) });
    var out = await res.json();
    if (!out.ok) { setNote("tplNote", out.message || "Could not save.", "err"); return false; }
    if (okNote) setNote("tplNote", okNote, "ok");
    await loadTemplates();
    return true;
}

function fmtMB(n) { return n == null ? "-" : (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB"); }

function packLineText() {
    var p = tplState.pack;
    if (!p) return t("Waiting for the helper...");
    var line = p.version ? t("Thumbnail Pack version {version} - {count} files", { version: p.version, count: p.count }) : t("Thumbnail Pack");
    return p.message ? line + " - " + t(p.message) : line;
}

function renderTemplates() {
    var locked = tplState.entitled === false;
    $("tplLocked").style.display = locked ? "" : "none";
    $("tplPackRow").style.display = locked ? "none" : "";
    $("tplAddBtn").style.display = locked ? "none" : "";
    $("tplGrid").style.display = locked ? "none" : "";
    $("tplEmpty").style.display = "none";
    $("tplFiles").previousElementSibling.style.display = locked ? "none" : "";
    $("tplPresets").previousElementSibling.style.display = locked ? "none" : "";
    $("tplFiles").style.display = locked ? "none" : "";
    $("tplPresets").style.display = locked ? "none" : "";
    if (locked) { $("tplForm").style.display = "none"; return; }
    $("tplPackLine").textContent = packLineText() + (tplState.mogrts ? " - " + t("{n} Premiere Pro templates (MOGRT)", { n: tplState.mogrts }) : "");

    var grid = $("tplGrid");
    grid.textContent = "";
    $("tplEmpty").style.display = tplState.items.length ? "none" : "";
    tplState.items.forEach(function (it, i) {
        var st = tplStatus(it);
        var card = document.createElement("div");
        card.className = "tpl-card";
        var prev = document.createElement("div");
        prev.className = "tpl-prev";
        prev.textContent = "AEP";
        var box = document.createElement("div");
        var b = document.createElement("b");
        b.textContent = it.name;
        if (it.source === "pack") {
            var chip = document.createElement("span");
            chip.className = "tpl-chip";
            chip.textContent = t("Pack");
            b.appendChild(chip);
        }
        var meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent = it.file + " \u00b7 " + it.comp + " \u00b7 " + t("Fills layer {layer}", { layer: it.textLayer || "NICK" });
        box.appendChild(b);
        box.appendChild(meta);
        var state = document.createElement("div");
        state.className = "tpl-state";
        var dot = document.createElement("span");
        dot.className = "h-dot " + st.cls;
        state.appendChild(dot);
        state.appendChild(document.createTextNode(st.text));
        var actions = document.createElement("div");
        actions.className = "tpl-actions";
        var edit = document.createElement("button");
        edit.className = "mini-btn";
        edit.textContent = t("Edit");
        edit.addEventListener("click", function () { tplOpenForm(i); });
        var del = document.createElement("button");
        del.className = "mini-btn";
        del.textContent = t("Remove");
        del.addEventListener("click", async function () {
            if (!confirm(t("Remove the template \u201c{name}\u201d? The .aep file stays.", { name: it.name }))) return;
            var list = tplCurrentList();
            list.splice(tplUserIndex(i), 1);
            tplSaveList(list, "Template removed.");
        });
        if (it.source === "pack") { edit.disabled = true; del.disabled = true; edit.title = del.title = t("Managed by the Thumbnail Pack"); }
        actions.appendChild(edit);
        actions.appendChild(del);
        card.appendChild(prev);
        card.appendChild(box);
        card.appendChild(state);
        card.appendChild(actions);
        grid.appendChild(card);
    });

    var files = $("tplFiles");
    files.textContent = "";
    if (!tplState.files.length) {
        var none = document.createElement("div");
        none.className = "hint";
        none.textContent = t("No .aep files yet.");
        files.appendChild(none);
    }
    tplState.files.forEach(function (f) {
        var used = f.managed || tplState.items.some(function (x) { return x.file === f.name; });
        var row = document.createElement("div");
        row.className = "tpl-row";
        var main = document.createElement("div");
        main.className = "grow";
        var b = document.createElement("b");
        b.textContent = f.name;
        var meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent = fmtMB(f.size) + (f.managed ? " \u00b7 " + t("Managed by the Thumbnail Pack") : (used ? " \u00b7 " + t("used by a template") : ""));
        main.appendChild(b);
        main.appendChild(meta);
        var del = document.createElement("button");
        del.className = "mini-btn";
        del.textContent = t("Delete file");
        del.disabled = used;
        del.addEventListener("click", async function () {
            if (!confirm(t("Delete {file} from the templates folder?", { file: f.name }))) return;
            var out = await presetRequest("/templates/delete-file", { file: f.name });
            setNote("tplNote", out.ok ? "File deleted." : (out.message || "Could not delete."), out.ok ? "ok" : "err");
            loadTemplates();
        });
        row.appendChild(main);
        row.appendChild(del);
        files.appendChild(row);
    });

    var presets = $("tplPresets");
    presets.textContent = "";
    if (!tplState.presets.length) {
        var np = document.createElement("div");
        np.className = "hint";
        np.textContent = t("No presets are bundled with this panel yet.");
        presets.appendChild(np);
    }
    tplState.presets.forEach(function (p) {
        var row = document.createElement("div");
        row.className = "tpl-row";
        var dot = document.createElement("span");
        dot.className = "h-dot " + (p.exists ? "ok" : "fail");
        var main = document.createElement("div");
        main.className = "grow";
        var b = document.createElement("b");
        b.textContent = p.name;
        var meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent = p.file + " \u00b7 " + (p.exists ? fmtMB(p.size) : t("File missing"));
        main.appendChild(b);
        main.appendChild(meta);
        row.appendChild(dot);
        row.appendChild(main);
        presets.appendChild(row);
    });
}

function tplOpenForm(index, presetFile) {
    tplEditing = index;
    var it = index >= 0 ? tplState.items[index] : { file: presetFile || "", comp: "", name: "", textLayer: "" };
    var sel = $("tplFormFile");
    sel.textContent = "";
    var names = tplState.files.map(function (f) { return f.name; });
    if (it.file && names.indexOf(it.file) === -1) names.push(it.file);
    names.forEach(function (n) {
        var o = document.createElement("option");
        o.value = n;
        o.textContent = n;
        sel.appendChild(o);
    });
    sel.value = it.file || (names[0] || "");
    $("tplFormComp").value = it.comp;
    $("tplFormName").value = it.name;
    $("tplFormLayer").value = it.textLayer;
    $("tplFormTitle").textContent = index >= 0 ? t("Edit template") : t("New template");
    setNote("tplFormNote", "", "");
    $("tplForm").style.display = "";
    $("tplForm").scrollIntoView({ block: "center", behavior: "smooth" });
    $("tplFormComp").focus();
}

$("tplFormCancel").addEventListener("click", function () { $("tplForm").style.display = "none"; });

$("tplSyncBtn").addEventListener("click", async function () {
    $("tplSyncBtn").disabled = true;
    try { await fetch("/pack-sync", { method: "POST" }); } catch (e) {}
    setNote("tplNote", "Checking for Pack updates...", "");
    setTimeout(function () { $("tplSyncBtn").disabled = false; loadTemplates(); }, 4000);
});

$("tplFormSave").addEventListener("click", async function () {
    var entry = {
        file: $("tplFormFile").value,
        comp: ($("tplFormComp").value || "").trim(),
        name: ($("tplFormName").value || "").trim(),
        textLayer: ($("tplFormLayer").value || "").trim()
    };
    if (!entry.file) { setNote("tplFormNote", "Add an .aep file first.", "err"); return; }
    if (!entry.comp) { setNote("tplFormNote", "Every template needs the name of its composition.", "err"); return; }
    var list = tplCurrentList();
    if (tplEditing >= 0) list[tplUserIndex(tplEditing)] = entry; else list.push(entry);
    var ok = await tplSaveList(list, "Template saved - open the SPT tab in After Effects to use it.");
    if (ok) $("tplForm").style.display = "none";
});

$("tplAddBtn").addEventListener("click", function () { $("tplFile").click(); });

$("tplFile").addEventListener("change", async function () {
    var file = this.files && this.files[0];
    this.value = "";
    if (!file) return;
    setNote("tplNote", "Uploading...", "");
    try {
        var res = await fetch("/templates/add-file?filename=" + encodeURIComponent(file.name), { method: "POST", body: file });
        var out = await res.json();
        if (!out.ok) { setNote("tplNote", out.message || "Could not add the file.", "err"); return; }
        await loadTemplates();
        setNote("tplNote", "File added - now tell the panel which composition to use.", "ok");
        tplOpenForm(-1, out.name);
    } catch (e) {
        setNote("tplNote", "Could not reach the dashboard server.", "err");
    }
});

/* ---------------- update banner: new app version and/or newer bundled panels ---------------- */
var appUpdateInfo = null;

async function loadUpdateInfo() {
    try {
        var res = await fetch("/update-info");
        appUpdateInfo = await res.json();
    } catch (e) { /* offline: the banner just stays hidden */ }
    renderUpdateBanner();
}

function renderUpdateBanner() {
    var box = $("updateBanner");
    var parts = [];
    var goto = "status";
    var linkText = t("Update panels");
    if (appUpdateInfo && appUpdateInfo.hasUpdate) {
        parts.push(t("Spidx Uploader {version} is available.", { version: appUpdateInfo.latestVersion }));
        goto = "account";
        linkText = t("View update");
    }
    var stale = [];
    var P = (data && data.plugins) || {};
    [["ae", "After Effects"], ["ppro", "Premiere Pro"], ["vegas", "VEGAS Pro"], ["ps", "Photoshop"]].forEach(function (k) {
        if (P[k[0]] && P[k[0]].installed && P[k[0]].needsUpdate) stale.push(k[1]);
    });
    var remote = data && data.pluginUpdates && data.pluginUpdates.updates;
    (remote || []).forEach(function (u) { if (u && u.label && stale.indexOf(u.label) === -1) stale.push(u.label); });
    if (stale.length) parts.push(t("Newer panels are available for: {list}.", { list: stale.join(", ") }));
    box.classList.toggle("show", parts.length > 0);
    if (!parts.length) return;
    $("updateBannerText").textContent = parts.join(" ");
    var link = $("updateBannerLink");
    link.textContent = linkText;
    link.onclick = function (ev) {
        ev.preventDefault();
        if (goto === "account") fetch("/open-updater", { method: "POST" }).catch(function () {});   // an app update: the Updater window
        else switchToPage(goto);
    };
}

/* ---------------- free plan: video-render allowance ---------------- */
function renderFailBanner() {
    var n = (data && data.failedUploads) || 0;
    $("failBanner").classList.toggle("show", n > 0);
    if (n > 0) $("failBannerText").textContent = t("Uploads that did not go through: {n}.", { n: n });
}

$("failRetryBtn").addEventListener("click", function () {
    $("failRetryBtn").disabled = true;
    fetch("/retry-failed", { method: "POST" }).catch(function () {});
    setTimeout(function () { $("failRetryBtn").disabled = false; }, 4000);
});

function renderRenderBanner() {
    var box = $("renderBanner");
    var rn = data && data.renders;
    var show = !!(rn && rn.limit != null && rn.remaining <= 3);
    box.classList.toggle("show", show);
    if (!show) return;
    $("renderBannerText").textContent = rn.remaining === 0
        ? t("You have used all {limit} free video renders this month. Pro has unlimited renders.", { limit: rn.limit })
        : t("{used} of {limit} free video renders used this month. Pro has unlimited renders.", { used: rn.used, limit: rn.limit });
}

$("openUpdaterBtn").addEventListener("click", function () { fetch("/open-updater", { method: "POST" }).catch(function () {}); });

function renderExtras() {
    renderHero();
    renderHealth();
    renderFailBanner();
    renderRenderBanner();
    renderUpdateBanner();
    $("sideVersion").textContent = data.appVersion ? "v" + data.appVersion : "";
}

/* ---------------- settings: folds, search, autosave, reset ---------------- */
(function settingsUi() {
    var foldEls = Array.prototype.slice.call(document.querySelectorAll(".set-fold"));
    var saved = {};
    if (UI.folds) Object.keys(UI.folds).forEach(function (k) { saved[k] = !!UI.folds[k]; });
    var searching = false;

    foldEls.forEach(function (f) {
        var id = f.getAttribute("data-fold");
        f._defOpen = f.classList.contains("open");
        if (saved[id] != null) f.classList.toggle("open", saved[id]);
        f.querySelector(".fold-head").addEventListener("click", function () {
            if (searching) return;
            var open = !f.classList.contains("open");
            f.classList.toggle("open", open);
            saved[id] = open;
            saveUi({ folds: saved });
        });
    });

    function applySearch() {
        var q = ($("setSearch").value || "").toLowerCase().trim();
        searching = !!q;
        var anyShown = false;
        foldEls.forEach(function (f) {
            var id = f.getAttribute("data-fold");
            var blocks = Array.prototype.slice.call(f.querySelectorAll(".set-block"));
            if (!q) {
                f.classList.remove("hide");
                blocks.forEach(function (b) { b.classList.remove("hide"); });
                f.classList.toggle("open", saved[id] != null ? saved[id] : f._defOpen);
                anyShown = true;
                return;
            }
            var headHit = (f.querySelector(".fold-head").textContent || "").toLowerCase().indexOf(q) !== -1;
            var hit = headHit;
            if (blocks.length) {
                blocks.forEach(function (b) {
                    var m = headHit || (b.textContent || "").toLowerCase().indexOf(q) !== -1;
                    b.classList.toggle("hide", !m);
                    if (m) hit = true;
                });
            } else if (!hit) {
                hit = (f.querySelector(".fold-body").textContent || "").toLowerCase().indexOf(q) !== -1;
            }
            f.classList.toggle("hide", !hit);
            f.classList.toggle("open", hit);
            if (hit) anyShown = true;
        });
        $("setEmpty").style.display = anyShown ? "none" : "";
    }
    $("setSearch").addEventListener("input", applySearch);

    // autosave: any change inside the helper-settings folds saves after a short pause
    var saveTimer = null;
    function scheduleSave() {
        window.__settingsDirty = true;
        setNote("saveStatus", "Saving...", "");
        clearTimeout(saveTimer);
        saveTimer = setTimeout(function () {
            $("saveSettingsBtn").click();
            setTimeout(function () { window.__settingsDirty = false; }, 2500);
        }, 800);
    }
    Array.prototype.forEach.call(document.querySelectorAll("#tourCardSettings input, #tourCardSettings select"), function (el) {
        el.addEventListener("change", scheduleSave);
    });

    Array.prototype.forEach.call(document.querySelectorAll("[data-reset]"), function (btn) {
        btn.addEventListener("click", function () {
            var scope = document.getElementById(btn.getAttribute("data-reset"));
            if (!scope) return;
            Array.prototype.forEach.call(scope.querySelectorAll("[data-default]"), function (el) {
                var d = el.getAttribute("data-default");
                if (el.type === "checkbox") el.checked = d === "1";
                else el.value = d;
            });
            applySubRowLocks();
            scheduleSave();
        });
    });
})();

/* ---------------- keyboard: 1-6 pages, "/" search, Esc leaves a field ---------------- */
document.addEventListener("keydown", function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var tag = ((e.target && e.target.tagName) || "").toLowerCase();
    var typing = tag === "input" || tag === "textarea" || tag === "select" || (e.target && e.target.isContentEditable);
    if (typing) {
        if (e.key === "Escape" && e.target.blur) e.target.blur();
        return;
    }
    var pages = { "1": "overview", "2": "history", "3": "activity", "4": "templates", "5": "settings", "6": "status", "7": "account" };
    if (pages[e.key]) { switchToPage(pages[e.key]); e.preventDefault(); return; }
    if (e.key === "/") {
        var cur = document.querySelector(".page.active");
        var id = cur ? cur.id : "";
        if (id !== "page-history" && id !== "page-settings") { switchToPage("history"); id = "page-history"; }
        var input = $(id === "page-settings" ? "setSearch" : "histSearch");
        input.focus();
        e.preventDefault();
    }
});

function openFromHash() {
    var h = (location.hash || "").slice(1);
    if (["overview", "history", "activity", "templates", "settings", "status", "account"].indexOf(h) !== -1) switchToPage(h);
}
window.addEventListener("hashchange", openFromHash);
openFromHash();
loadHistory();
loadUpdateInfo();
setInterval(loadUpdateInfo, 30 * 60 * 1000);

refresh();
setInterval(refresh, 4000);
