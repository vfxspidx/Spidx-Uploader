/* Spidx Updater window: checks for an update, downloads and starts the installer, repairs the panels.
   Everything runs through the endpoints the Dashboard server already has (/check-update, /install-update,
   /update-progress, /cancel-update, /install-plugin, /data). */
var $ = function (id) { return document.getElementById(id); };
var stage = $("stage"), ring = $("ring"), arc = $("arc");
var info = null, currentVersion = "", pollTimer = null, busyRepair = false, lastBytes = 0, lastTime = 0, speed = 0;
var NOTES_URL = "https://spidxuploader.com/changelog";

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function stripV(v) { return String(v || "").replace(/^v/i, ""); }
function fmtMB(n) { return (n / 1048576).toFixed(n >= 104857600 ? 0 : 1) + " MB"; }

function mark(mode, pct) {          // spin | prog | ok | err | idle
    ring.setAttribute("class", "ring " + mode);
    arc.style.strokeDashoffset = mode === "prog" ? String(100 - Math.max(0, Math.min(100, pct || 0))) : "";
}

function show(state, o) {
    stage.setAttribute("data-state", state);
    $("title").textContent = o.title || "";
    var sub = $("sub"); sub.textContent = o.sub || "";
    var pill = $("pill"); pill.hidden = !o.pill; pill.textContent = o.pill || "";
    $("meter").hidden = !o.meter;
    $("steps").hidden = !o.steps;
    mark(o.ring || "idle", o.pct);
    var main = $("mainBtn"); main.textContent = o.main || t("Close"); main.disabled = !!o.mainDisabled; main.hidden = !!o.mainHidden; main.onclick = o.onMain || closeWindow;
    $("cancelBtn").hidden = !o.cancel; $("cancelBtn").onclick = o.onCancel || null;
    $("notesBtn").hidden = o.notes === false;
    $("notesBtn").href = (info && info.downloadUrl) || NOTES_URL;
    $("repairBtn").hidden = !!o.hideRepair;
    if (window.applyI18n) window.applyI18n(document.body);
}

function closeWindow() {
    window.close();
    setTimeout(function () { if (!window.closed) $("sub").textContent = t("You can close this window now."); }, 300);
}

/* ---- check ---- */
async function check(force) {
    show("checking", { title: t("Checking for updates"), ring: "spin", mainHidden: true, notes: false, hideRepair: true });
    var res = null, data = null;
    try {
        var both = await Promise.all([
            fetch("/check-update", { method: "POST" }).then(function (r) { return r.json(); }),
            fetch("/data").then(function (r) { return r.json(); }),
            sleep(900)
        ]);
        res = both[0]; data = both[1];
    } catch (e) { res = null; }
    if (data && data.appVersion) currentVersion = data.appVersion;
    if (!res || res.ok === false || (res.lastError && !res.latestVersion)) {
        info = null;
        show("error", { title: t("Could not check for updates"), sub: t("Check your internet connection and try again."), ring: "err", main: t("Try again"), onMain: function () { check(true); }, notes: false });
        return;
    }
    info = res;
    if (res.hasUpdate) {
        show("update", {
            title: t("Update available"), pill: "v" + stripV(currentVersion) + "  \u2192  v" + stripV(res.latestVersion),
            sub: res.installerAssetSize ? t("Download size: {size}", { size: fmtMB(res.installerAssetSize) }) : "",
            ring: "idle", main: t("Update now"), onMain: startUpdate
        });
    } else {
        show("latest", { title: t("You have the latest version"), pill: "Spidx Uploader " + stripV(currentVersion || (res.latestVersion || "")), ring: "ok", main: t("Close") });
    }
}

/* ---- download + installer ---- */
async function startUpdate() {
    lastBytes = 0; lastTime = Date.now(); speed = 0;
    show("download", { title: t("Downloading the update"), meter: true, ring: "prog", pct: 0, cancel: true, notes: false, hideRepair: true, mainHidden: true,
        onCancel: cancelUpdate });
    $("meterFill").style.width = "0%"; $("meterLeft").textContent = ""; $("meterRight").textContent = "";
    var done = fetch("/install-update", { method: "POST" }).then(function (r) { return r.json(); });
    clearInterval(pollTimer);
    pollTimer = setInterval(pollProgress, 450);
    var res;
    try { res = await done; } catch (e) { res = { ok: false, message: e.message }; }
    clearInterval(pollTimer);
    if (res.ok) {
        show("installer", { title: t("The installer is running"), sub: t("Follow the installer window. Spidx Uploader restarts when it is done."), ring: "ok", notes: false, hideRepair: true, main: t("Close") });
    } else if (/cancel/i.test(res.message || "")) {
        check(false);
    } else {
        show("error", { title: t("The update could not be downloaded"), sub: res.message || "", ring: "err", main: t("Try again"), onMain: startUpdate, notes: false });
    }
}

async function pollProgress() {
    try {
        var j = await (await fetch("/update-progress")).json();
        if (j.state !== "downloading" && j.state !== "launched") return;
        var total = j.total || 0, pct = total ? Math.round(100 * j.received / total) : 0;
        var now = Date.now(), dt = (now - lastTime) / 1000;
        if (dt > 0.3) { speed = (j.received - lastBytes) / dt; lastBytes = j.received; lastTime = now; }
        $("meterFill").style.width = pct + "%"; mark("prog", pct);
        $("meterLeft").textContent = total ? fmtMB(j.received) + " / " + fmtMB(total) : fmtMB(j.received);
        $("meterRight").textContent = (speed > 0 ? (speed / 1048576).toFixed(1) + " MB/s  \u00b7  " : "") + (total ? pct + "%" : "");
    } catch (e) { /* the server is busy: try again on the next tick */ }
}

async function cancelUpdate() {
    $("cancelBtn").disabled = true;
    try { await fetch("/cancel-update", { method: "POST" }); } catch (e) {}
    $("cancelBtn").disabled = false;
}

/* ---- repair: reinstall every installed panel that is behind the bundled one ---- */
var PANELS = [["ae", "After Effects"], ["ppro", "Premiere Pro"], ["ps", "Photoshop"], ["vegas", "VEGAS Pro"]];

function stepList(rows) {
    var ul = $("steps"); ul.textContent = "";
    rows.forEach(function (r) {
        var li = document.createElement("li"); li.setAttribute("data-s", r.s); li.id = "step-" + r.id;
        var ic = document.createElement("span"); ic.className = "ic";
        var nm = document.createElement("span"); nm.className = "nm"; nm.textContent = r.name;
        var st = document.createElement("span"); st.className = "st"; st.textContent = r.text || "";
        li.appendChild(ic); li.appendChild(nm); li.appendChild(st); ul.appendChild(li);
    });
}
function setStep(id, s, text) { var li = $("step-" + id); if (!li) return; li.setAttribute("data-s", s); li.querySelector(".st").textContent = text || ""; }

async function repair() {
    if (busyRepair) return; busyRepair = true;
    show("repair", { title: t("Checking the panels"), steps: true, ring: "spin", notes: false, hideRepair: true, mainHidden: true });
    stepList(PANELS.map(function (p) { return { id: p[0], name: p[1], s: "skip", text: "" }; }));
    var failed = 0, fixed = 0;
    try {
        var data = await (await fetch("/data")).json();
        for (var i = 0; i < PANELS.length; i++) {
            var id = PANELS[i][0], st = (data.plugins || {})[id];
            if (!st || !st.installed) { setStep(id, "skip", t("not installed")); continue; }
            if (!st.needsUpdate) { setStep(id, "ok", t("In order")); continue; }
            setStep(id, "run", t("Repairing..."));
            await fetch("/install-plugin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plugin: id }) });
            var ok = false;
            for (var k = 0; k < 45 && !ok; k++) {       // the installer runs in its own window: wait for it (up to ~90 s)
                await sleep(2000);
                var d2 = await (await fetch("/data")).json();
                var s2 = (d2.plugins || {})[id];
                ok = !!(s2 && s2.installed && !s2.needsUpdate);
            }
            if (ok) { fixed++; setStep(id, "ok", t("Repaired")); } else { failed++; setStep(id, "fail", t("Not finished")); }
        }
    } catch (e) { failed++; }
    busyRepair = false;
    show("repair", {
        title: failed ? t("Some files could not be repaired") : (fixed ? t("Everything was repaired") : t("Everything is in order")),
        steps: true, ring: failed ? "err" : "ok", notes: false,
        main: failed ? t("Try again") : t("Close"), onMain: failed ? repair : closeWindow
    });
}

/* ---- header: language + menu ---- */
function menu(btn, box) {
    btn.addEventListener("click", function (e) { e.stopPropagation(); var open = box.hidden; closeMenus(); box.hidden = !open; });
}
function closeMenus() { $("langMenu").hidden = true; $("moreMenu").hidden = true; }
document.addEventListener("click", closeMenus);
document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeMenus(); });

(function header() {
    $("langBtn").textContent = String(I18N_LANG).split("-")[0].toUpperCase();
    var box = $("langMenu");
    var opts = [{ code: "auto", name: t("Automatic") }].concat(I18N_LANGS);
    opts.forEach(function (l) {
        var b = document.createElement("button"); b.type = "button"; b.textContent = l.name;
        b.setAttribute("aria-checked", l.code === I18N_PREF ? "true" : "false");
        b.addEventListener("click", async function () {
            await fetch("/set-language", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ language: l.code }) });
            location.reload();
        });
        box.appendChild(b);
    });
    menu($("langBtn"), box); menu($("moreBtn"), $("moreMenu"));
    $("mCheck").addEventListener("click", function () { check(true); });
    $("mNotes").addEventListener("click", function () { window.open((info && info.downloadUrl) || NOTES_URL, "_blank", "noopener"); });
    $("mCopy").addEventListener("click", function () {
        var text = "Spidx Uploader " + stripV(currentVersion) + (info && info.latestVersion ? " (latest: " + stripV(info.latestVersion) + ")" : "");
        try { navigator.clipboard.writeText(text); } catch (e) {}
    });
    $("repairBtn").addEventListener("click", repair);
})();

check(false);
