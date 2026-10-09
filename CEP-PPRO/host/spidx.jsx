/* ========================================================================
 *  Spidx Uploader — Premiere Pro host layer (ExtendScript)
 *
 *  Port of the After Effects host script (CEP-AE/host/spidx.jsx). Both
 *  panels talk to the SAME Spider Engine the same way: by dropping files
 *  into App\incoming and reading/writing the small dot-files in it. No
 *  network, no IPC, no second engine — server.js does not know or care
 *  which host application produced the PNG.
 *
 *  The one thing that had to change completely is the export itself.
 *  After Effects has CompItem.saveFrameToPng(), a single scripting call
 *  that grabs one frame. Premiere Pro's DOM has nothing like that —
 *  Sequence has no "export current frame" method. The documented way to
 *  get a single frame out of a sequence via scripting is:
 *
 *    1. Set the sequence's in/out points to the current player position
 *       (out = in, so the "work area" is exactly one frame wide).
 *    2. Call Sequence.exportAsMediaDirect(path, presetPath, workAreaType)
 *       with workAreaType = app.encoder.ENCODE_IN_TO_OUT and an export
 *       preset (.epr) that outputs a PNG.
 *
 *  That preset file is the catch: .epr files are binary-ish XML tied to
 *  Media Encoder's installed format list, so one can't just be
 *  hand-written the way an AE saveFrameToPng() call needs zero setup.
 *  It has to be generated once from Premiere's own Export Media dialog
 *  and dropped next to this script (see spidxPresetPath() below and the
 *  install notes in ../PRESET-SETUP.txt). Everything downstream of that
 *  — staging file, rename-on-completion, retry-on-lock — is identical to
 *  the AE version.
 *
 *  Every function here returns a JSON *string* — CEP's evalScript can
 *  only hand back strings, and ExtendScript has no JSON object.
 * ==================================================================== */

var SPIDX_PART_EXT = ".pngpart";

function spidxEscape(value) {
    var s = String(value);
    var out = "";
    for (var i = 0; i < s.length; i++) {
        var c = s.charAt(i);
        if (c === '"' || c === "\\") out += "\\" + c;
        else if (c === "\n") out += "\\n";
        else if (c === "\r") out += "\\r";
        else if (c === "\t") out += "\\t";
        else out += c;
    }
    return out;
}

function spidxFail(message) {
    return '{"ok":false,"message":"' + spidxEscape(message) + '"}';
}

function spidxActiveSequence() {
    return app.project ? app.project.activeSequence : null;
}

// Same problem as spidxResolveFolder() in the AE host: CEP and
// ExtendScript disagree about what a path string looks like, and
// ExtendScript's Folder()/File() silently resolve the URI-ish
// "/C/Users/..." form relative to the drive root instead of erroring.
function spidxResolveFolder(raw) {
    var input = String(raw || "");
    var candidates = [];

    function push(value) {
        if (value && candidates.join("\u0000").indexOf(value) === -1) candidates.push(value);
    }

    push(input);
    push(input.replace(/\\/g, "/"));
    push(input.replace(/^\/([A-Za-z])\//, "$1:/"));
    push(input.replace(/^file:\/\/\//, ""));
    try { push(decodeURI(input)); } catch (e) {}

    for (var i = 0; i < candidates.length; i++) {
        var folder = new Folder(candidates[i]);
        if (folder.exists) return folder;
    }

    throw new Error("The incoming folder could not be found from Premiere Pro. Tried: " + candidates.join(" | "));
}

// Sorts Folder objects named like version numbers ("9.0", "14.0", "25.0")
// newest-first. Plain string comparison is wrong here: "9.0" > "25.0".
function spidxSortVersionFoldersDesc(folders) {
    function num(name) {
        var n = parseFloat(String(name).replace(/[^0-9.]/g, ""));
        return isNaN(n) ? -1 : n;
    }
    folders.sort(function (a, b) {
        var x = num(a.name), y = num(b.name);
        if (x !== y) return y - x;
        return b.name > a.name ? 1 : (b.name < a.name ? -1 : 0);
    });
    return folders;
}

function spidxStamp() {
    return "spidx_" + (new Date()).getTime();
}

// Used to require copying the .epr into two places (Media Encoder's own
// Presets folder AND this extension's presets/ folder) — now it's just
// wherever Premiere's "Save Preset..." already put it. The extension's
// own presets/ folder is still checked first so installs set up under
// the old two-copy instructions keep working with no extra step.
function spidxPresetPath() {
    var thisFile = new File($.fileName);
    var bundled = new File(thisFile.parent.parent.fsName + "/presets/pngframe.epr");
    if (bundled.exists) return bundled;

    // Media Encoder's Presets folder embeds a version number in its path
    // (e.g. ".../Adobe Media Encoder/25.0/Presets/") that changes every
    // release, so every version folder under the root gets checked
    // instead of hardcoding one.
    var root = new Folder("~/AppData/Roaming/Adobe/Adobe Media Encoder");
    if (root.exists) {
        var versionFolders = root.getFiles(function (f) { return f instanceof Folder; });
        spidxSortVersionFoldersDesc(versionFolders);
        for (var i = 0; i < versionFolders.length; i++) {
            var candidate = new File(versionFolders[i].fsName + "/Presets/pngframe.epr");
            if (candidate.exists) return candidate;
        }
    }

    return bundled; // still missing everywhere — caller reports exactly this path as "not found"
}

/* ---------------------------------------------------------------------- *
 *  Motion Graphics Templates — the panel's "MOGRT" tab
 * ---------------------------------------------------------------------- */

// Where this panel lives on disk. Computed ONCE here, at load time, when
// $.fileName is certainly the path of THIS file - inside a function that is
// later called through evalScript(), $.fileName is not guaranteed to still be
// it. The panel also passes its own folder (CSInterface's "extension" path)
// into every MOGRT call below, and that wins when it is given.
var SPIDX_EXT_ROOT = null;
try { SPIDX_EXT_ROOT = new File($.fileName).parent.parent.fsName; } catch (e) { SPIDX_EXT_ROOT = null; }

// The panel folder that actually contains mogrts/ (first candidate that does),
// or the first candidate when none does so the error can say where it looked.
function spidxBundleRoot(extPath) {
    var candidates = [];
    if (extPath) candidates.push(String(extPath).replace(/[\\\/]+$/, ""));
    if (SPIDX_EXT_ROOT) candidates.push(SPIDX_EXT_ROOT);
    try { candidates.push(new File($.fileName).parent.parent.fsName); } catch (e) {}

    for (var i = 0; i < candidates.length; i++) {
        if (new Folder(candidates[i] + "/mogrts").exists) return candidates[i];
    }
    return candidates.length ? candidates[0] : null;
}

// Reads mogrts/mogrts.json, bundled next to this panel (same
// $.fileName-relative trick spidxPresetPath() above uses for presets/).
// Passed straight through as raw JSON text rather than parsed - it's a
// hand-edited file shipped with the panel, and ExtendScript has no
// reliable JSON object. Because it's hand-edited, a stray BOM or a
// missing bracket would otherwise surface as the unreadable "Unexpected
// response from Premiere Pro", so the shape is sanity-checked here.
function spidxListMogrts(extPath) {
    try {
        var root = spidxBundleRoot(extPath);
        var jsonFile = new File(String(root) + "/mogrts/mogrts.json");
        if (!jsonFile.exists) return '{"ok":true,"items":[],"missing":true,"root":"' + spidxEscape(String(root)) + '"}';

        jsonFile.open("r");
        jsonFile.encoding = "UTF-8";
        var text = jsonFile.read();
        jsonFile.close();

        text = String(text).replace(/^\uFEFF/, "").replace(/^\s+|\s+$/g, "");
        if (text === "") return '{"ok":true,"items":[]}';
        if (text.charAt(0) !== "[" || text.charAt(text.length - 1) !== "]") {
            return spidxFail("mogrts/mogrts.json must be a JSON list: [ { \"file\": \"...\", \"name\": \"...\" }, ... ]");
        }

        return '{"ok":true,"items":' + text + '}';
    } catch (err) {
        return spidxFail(err.toString());
    }
}

// A file name coming from the panel must be a plain "something.mogrt" -
// never a path.
function spidxSafeMogrtName(fileName) {
    var name = String(fileName || "");
    if (!name || name.indexOf("/") !== -1 || name.indexOf("\\") !== -1 || name.indexOf("..") !== -1) return null;
    if (!/\.mogrt$/i.test(name)) return null;
    return name;
}

function spidxBundledMogrt(fileName, extPath) {
    return new File(String(spidxBundleRoot(extPath)) + "/mogrts/" + fileName);
}

// Picks the video track a new graphic should land on. importMGT() OVERWRITES
// whatever is on the target track at that time, so this never uses V1 (your
// footage) and never a track that already has a clip in the next few
// seconds - it returns the first free track above V1, or -1.
var SPIDX_MOGRT_CLEARANCE_SECONDS = 6;

function spidxFreeVideoTrackIndex(seq, startSeconds) {
    var tracks = seq.videoTracks;
    var endSeconds = startSeconds + SPIDX_MOGRT_CLEARANCE_SECONDS;

    for (var t = 1; t < tracks.numTracks; t++) {
        var track = tracks[t];
        var free = true;
        try {
            if (track.isLocked && track.isLocked()) free = false;
        } catch (e) {}

        if (free) {
            for (var c = 0; c < track.clips.numItems; c++) {
                var clip = track.clips[c];
                var clipStart = Number(clip.start.seconds);
                var clipEnd = Number(clip.end.seconds);
                if (clipStart < endSeconds && clipEnd > startSeconds) { free = false; break; }
            }
        }
        if (free) return t;
    }
    return -1;
}

// Inserts a bundled .mogrt straight onto the timeline at the playhead
// (no install step needed), then - if a nick is given and the user's tier
// allows it - writes it into the graphic's text property, like the
// Properties tab does for an existing clip.
function spidxInsertMogrt(fileName, nick, allowText, extPath, textParam) {
    try {
        var seq = spidxActiveSequence();
        if (!seq) return spidxFail("No sequence is active - open a sequence in the Timeline panel, then try again.");

        var name = spidxSafeMogrtName(fileName);
        if (!name) return spidxFail("Invalid template name: " + fileName);
        var source = spidxBundledMogrt(name, extPath);
        if (!source.exists) return spidxFail("Bundled file not found: " + source.fsName + " - reinstall the Premiere Pro panel (an older Windows installer skipped the mogrts folder).");

        var pos = seq.getPlayerPosition();
        var trackIndex = spidxFreeVideoTrackIndex(seq, Number(pos.seconds));
        if (trackIndex < 0) {
            return spidxFail("No free video track above V1 at the playhead - add an empty video track (right-click a track header > Add Track) or move the playhead, then try again. (Spidx never inserts onto V1 or over existing clips.)");
        }

        var item = seq.importMGT(source.fsName, pos.ticks, trackIndex, 0);
        if (!item) return spidxFail("Premiere Pro could not insert the template - it may need a newer Premiere version.");

        try { item.setSelected(true, true); } catch (e) {}

        var textApplied = false;
        var textNote = "";
        var wantText = String(nick || "").length > 0;
        if (wantText) {
            if (String(allowText) !== "true") {
                textNote = "Nick fill is a Pro feature.";
            } else {
                try {
                    var component = item.getMGTComponent();
                    var param = component ? spidxPickTextParam(component, textParam) : null;
                    if (param) {
                        spidxWriteParamText(param, String(nick));
                        textApplied = true;
                    } else {
                        textNote = "This template has no text property Spidx can fill.";
                    }
                } catch (e) {
                    textNote = "Inserted, but the nick could not be written: " + e.toString();
                }
            }
        }

        return '{"ok":true,"track":"V' + (trackIndex + 1) + '","textApplied":' + (textApplied ? "true" : "false")
            + ',"note":"' + spidxEscape(textNote) + '"}';
    } catch (err) {
        return spidxFail(err.toString());
    }
}

/* ---------------------------------------------------------------------- *
 *  Context — what the panel shows before you click anything
 * ---------------------------------------------------------------------- */
function spidxContext() {
    try {
        var seq = spidxActiveSequence();
        var projectName = app.project && app.project.name ? app.project.name : "Untitled project";

        if (!seq) {
            return '{"ok":true,"hasComp":false,"project":"' + spidxEscape(projectName) + '"}';
        }

        var posTicks = seq.getPlayerPosition(); // Time object, .ticks / .seconds
        var fps = spidxSequenceFps(seq);
        var frame = fps ? Math.round(Number(posTicks.seconds) * fps) : 0;

        return '{"ok":true,"hasComp":true'
            + ',"comp":"' + spidxEscape(seq.name) + '"'
            + ',"width":' + (seq.frameSizeHorizontal || 0)
            + ',"height":' + (seq.frameSizeVertical || 0)
            + ',"time":' + Number(posTicks.seconds)
            + ',"frame":' + frame
            + ',"duration":' + (seq.end ? Number(seq.end) : 0)
            + ',"project":"' + spidxEscape(projectName) + '"}';
    } catch (err) {
        return spidxFail(err.toString());
    }
}

// videoFrameRate isn't exposed directly on Sequence in every Premiere
// build; settings.videoFrameRate (a Time object, ticks-per-frame) is the
// stable way to derive it across versions.
function spidxSequenceFps(seq) {
    try {
        var settings = seq.getSettings();
        var tpf = Number(settings.videoFrameRate.ticks);
        if (tpf > 0) return 254016000000 / tpf; // ticks-per-second / ticks-per-frame
    } catch (e) {}
    return null;
}

/* ---------------------------------------------------------------------- *
 *  Current frame -> PNG in incoming
 *
 *  Unlike AE's one-call saveFrameToPng, this is: pin in/out to the
 *  current frame, kick off an async export, then poll for the file the
 *  same way the AE side polls for saveFrameToPng's bytes to flush.
 * ---------------------------------------------------------------------- */
function spidxSaveFrame(incomingPath, viaPhotoshop, presetOverride) {
    var partFile = null;
    var savedIn = null, savedOut = null;

    try {
        var seq = spidxActiveSequence();
        if (!seq) return spidxFail("No sequence is active — open a sequence in the Timeline panel, then try again.");

        // A manually-picked path (the panel's "Change preset (.epr)"
        // link) always wins over auto-detection — that's the whole
        // point of letting the user point at it themselves.
        var preset = (presetOverride && String(presetOverride).length) ? new File(presetOverride) : spidxPresetPath();
        if (!preset.exists) {
            return spidxFail(
                "PNG export preset not found at " + preset.fsName + ". " +
                "Run Premiere's Export Media dialog once, set Format to PNG, click " +
                "\"Save Preset...\", name it pngframe.epr and save it into the panel's " +
                "presets folder — see PRESET-SETUP.txt. This is a one-time setup step."
            );
        }

        var folder = spidxResolveFolder(incomingPath);
        var baseName = spidxStamp();
        var suffix = viaPhotoshop ? ".ps.png" : ".png";

        // Remember the sequence's current in/out so this doesn't
        // permanently change what the user had marked in the timeline.
        savedIn = seq.getInPoint();
        savedOut = seq.getOutPoint();

        var pos = seq.getPlayerPosition();
        // in == out is NOT a reliable "one frame" work area — Adobe's own
        // official PProPanel sample deliberately avoids it too (see
        // exportCurrentFrameAsPNG() in Adobe-CEP/Samples), because a
        // zero-length range is ambiguous to the export engine. This is
        // the most likely cause of two things reported together: the
        // wrong/stale frame coming out, and the export taking far longer
        // than one frame should — a work area Premiere can't pin down to
        // exactly one frame can fall back to re-rendering a much bigger
        // range instead of just grabbing the current frame.
        var fps = spidxSequenceFps(seq);
        var oneFrame = fps ? (1 / fps) : (1 / 30); // 30fps fallback only if fps truly can't be read
        seq.setInPoint(pos.seconds);
        seq.setOutPoint(pos.seconds + oneFrame);

        var wantedPath = folder.fsName + "/" + baseName + SPIDX_PART_EXT;
        partFile = new File(wantedPath);

        // exportAsMediaDirect returns before the file is necessarily
        // finished writing — it queues the export and returns
        // immediately — so this polls for it exactly like the AE side
        // polls for saveFrameToPng's bytes to flush.
        var queued = seq.exportAsMediaDirect(partFile.fsName, preset.fsName, app.encoder.ENCODE_IN_TO_OUT);
        if (!queued) {
            return spidxFail("Premiere Pro rejected the export request. Check that pngframe.epr is a valid PNG preset.");
        }

        // Premiere does not always honor the exact output path we asked
        // for: depending on how the .epr was saved, a PNG preset can be
        // an "Export As Sequence" preset, in which case Premiere inserts
        // its own frame-number before the extension (e.g.
        // "spidx_123" + "00000000" + ".pngpart"), or it can force its own
        // real extension onto the name regardless of what we passed
        // (".pngpart" -> ".png"). Either way the exact wantedPath never
        // appears and the old code waited the full timeout for nothing.
        // So on top of watching wantedPath, also watch the incoming
        // folder for ANY new file whose name starts with baseName and
        // treat whichever shows up first as the real export.
        function spidxFindByBaseName() {
            try {
                var matches = folder.getFiles(function (f) {
                    return (f instanceof File) && f.name.indexOf(baseName) === 0;
                });
                for (var m = 0; m < matches.length; m++) {
                    if (matches[m].length > 0) return matches[m];
                }
            } catch (e) {}
            return null;
        }

        var found = null;
        for (var waited = 0; waited < 30000 && !found; waited += 200) {
            if (partFile.exists && partFile.length > 0) { found = partFile; break; }
            found = spidxFindByBaseName();
            if (found) break;
            $.sleep(200);
        }

        if (!found) {
            return spidxFail("Premiere Pro did not write the frame to: " + partFile.fsName
                + " (folder exists: " + folder.exists + ") — exports can take longer on a slow disk; try Upload again. "
                + "If this keeps happening, re-check pngframe.epr in PRESET-SETUP.txt: it must be a plain PNG preset "
                + "with \"Export As Sequence\" UNCHECKED.");
        }
        partFile = found;
        if (partFile.length === 0) {
            try { partFile.remove(); } catch (e) {}
            return spidxFail("Premiere Pro wrote an empty frame — check that pngframe.epr still points at a PNG format.");
        }

        var finalFile = new File(folder.fsName + "/" + baseName + suffix);
        if (finalFile.exists) { try { finalFile.remove(); } catch (e) {} }

        var size = partFile.length;
        var renamed = false;
        for (var attempt = 0; attempt < 8 && !renamed; attempt++) {
            if (attempt > 0) $.sleep(150);
            renamed = partFile.rename(baseName + suffix);
        }
        if (!renamed) {
            return spidxFail("Could not rename the finished frame to " + baseName + suffix
                + " (another process — often antivirus real-time scanning — may still have it locked; try Upload again).");
        }

        return '{"ok":true,"name":"' + spidxEscape(baseName + suffix) + '","size":' + size
            + ',"comp":"' + spidxEscape(seq.name) + '"}';
    } catch (err) {
        if (partFile) { try { if (partFile.exists) partFile.remove(); } catch (e) {} }
        return spidxFail(err.toString());
    } finally {
        // Always restore the user's original in/out points, export
        // success or not.
        try {
            var seq2 = spidxActiveSequence();
            if (seq2 && savedIn !== null && savedOut !== null) {
                seq2.setInPoint(savedIn.seconds);
                seq2.setOutPoint(savedOut.seconds);
            }
        } catch (e) {}
    }
}

/* ========================================================================
 *  Properties tab — reading/writing Essential Graphics (MOGRT) text
 *  properties on the selected clip
 *
 *  Premiere's DOM does have a route into a Graphics/MOGRT clip's
 *  Essential Graphics properties: TrackItem.getMGTComponent() returns a
 *  Component whose .properties collection can be read and written with
 *  ComponentParam.getValue()/.setValue(). It's the Premiere equivalent
 *  of the AE panel reaching into a text layer's Source Text property —
 *  just a different-shaped API, so it gets its own tab instead of being
 *  folded into "Leaderboard".
 *
 *  Two real rough edges, both confirmed by Adobe's own scripting forum,
 *  not guessed:
 *   1. This is designed around .mogrts authored in After Effects — a
 *      .mogrt built entirely inside Premiere's Essential Graphics panel
 *      is not guaranteed to expose the same component tree.
 *   2. A text parameter's value comes back as a PLAIN STRING on some
 *      Premiere builds (~13.1.5/14.0) and as a JSON string like
 *      {"textEditValue":"...","fontTextRunLength":[n],...} on others
 *      (14.1+). Both are handled below — see spidxSetGraphicText().
 *      fontTextRunLength has to be updated to match the new text's
 *      length or the JSON branch silently fails to render.
 *
 *  Given that inconsistency, treat this as best-effort per-project
 *  rather than guaranteed to work on every .mogrt/every Premiere build.
 * ==================================================================== */

function spidxSelectedGraphicsClip() {
    var seq = spidxActiveSequence();
    if (!seq) return null;

    var selection = null;
    try { selection = seq.getSelection(); } catch (e) { selection = null; }
    if (!selection || !selection.length) return null;

    for (var i = 0; i < selection.length; i++) {
        var item = selection[i];
        if (typeof item.getMGTComponent !== "function") continue;
        var component = null;
        try { component = item.getMGTComponent(); } catch (e) { component = null; }
        if (component) return { clip: item, component: component };
    }
    return null;
}

// Text params, checkbox params and slider params all come back from
// getValue() as strings with no type tag, so this tells them apart by
// shape: numbers and true/false are almost certainly sliders/checkboxes,
// a {"textEditValue":...} JSON blob is definitely text, and anything
// else non-numeric is treated as a plain-string text field (the
// pre-14.1 Premiere shape).
// NOTE: no JSON.parse here on purpose - ExtendScript has no JSON object
// in many versions, and a ReferenceError inside this check made every
// text property look "not text" (so the Properties tab found nothing).
function spidxIsTextEditJson(rawValue) {
    var trimmed = String(rawValue).replace(/^\s+|\s+$/g, "");
    return trimmed.charAt(0) === "{" && /"textEditValue"\s*:/.test(trimmed);
}

function spidxParamLooksLikeText(rawValue) {
    if (rawValue == null) return false;
    var trimmed = String(rawValue).replace(/^\s+|\s+$/g, "");
    if (trimmed === "") return false;
    if (trimmed === "true" || trimmed === "false") return false;
    if (!isNaN(Number(trimmed))) return false;
    if (trimmed.charAt(0) === "{") return spidxIsTextEditJson(trimmed);
    return true;
}

// Escapes text for use inside a JSON string literal.
function spidxJsonQuote(text) {
    var s = String(text);
    var out = '"';
    for (var i = 0; i < s.length; i++) {
        var c = s.charAt(i);
        var code = s.charCodeAt(i);
        if (c === '"') out += '\\"';
        else if (c === "\\") out += "\\\\";
        else if (c === "\n") out += "\\n";
        else if (c === "\r") out += "\\r";
        else if (c === "\t") out += "\\t";
        else if (code < 32) out += "\\u" + ("0000" + code.toString(16)).slice(-4);
        else out += c;
    }
    return out + '"';
}

// Rewrites "textEditValue" and "fontTextRunLength" inside the JSON blob
// by text replacement (no JSON.parse/stringify - see above). The
// function-style replacement keeps "$" characters in the nick literal.
function spidxReplaceTextEditJson(rawJson, text) {
    var out = String(rawJson).replace(/("textEditValue"\s*:\s*)"(?:[^"\\]|\\[\s\S])*"/, function (m, head) {
        return head + spidxJsonQuote(text);
    });
    out = out.replace(/("fontTextRunLength"\s*:\s*)\[[^\]]*\]/, function (m, head) {
        return head + "[" + String(text).length + "]";
    });
    return out;
}

// Writes text into one Essential Graphics text parameter, handling both
// shapes getValue() comes back in (plain string vs. the JSON blob).
function spidxWriteParamText(param, text) {
    var raw = null;
    try { raw = param.getValue(); } catch (e) { raw = null; }

    if (raw != null && spidxIsTextEditJson(raw)) {
        param.setValue(spidxReplaceTextEditJson(raw, text), true);
    } else {
        param.setValue(String(text), true);
    }
}

// The text a text parameter currently shows (unwraps the {"textEditValue":..}
// blob when that is what getValue() returned).
function spidxPlainText(rawValue) {
    var s = String(rawValue);
    var m = s.match(/"textEditValue"\s*:\s*"((?:[^"\\]|\\[\s\S])*)"/);
    return m ? m[1] : s;
}

// Which text parameter of a freshly inserted graphic receives the nick.
//   1. "hint" - set per template in mogrts.json ("textParam": either the
//      parameter's name exactly as Essential Graphics shows it, or its
//      1-based position among the template's TEXT parameters). This is the
//      reliable way: template authors name controls anything they like (one of
//      ours is literally named after its sample nick, "big vicobuca").
//   2. a parameter named like a nick (nick / name / player / gamertag),
//   3. with several text parameters: the LAST one (a fixed label such as
//      "ELIMINATED" comes first, the changing name after it),
//   4. otherwise the only/first one.
// Before this, step 3 did not exist, so a template whose name field wasn't
// named like a nick got the nick written over its fixed "ELIMINATED" label.
function spidxPickTextParam(component, hint) {
    var props = component.properties;
    var list = [];   // text-like parameters
    var all = [];    // every parameter (by name)
    for (var i = 0; i < props.numItems; i++) {
        var param = props[i];
        var raw = null;
        try { raw = param.getValue(); } catch (e) { raw = null; }
        all.push({ param: param, name: String(param.displayName) });
        if (!spidxParamLooksLikeText(raw)) continue;
        list.push({ param: param, name: String(param.displayName), text: spidxPlainText(raw) });
    }

    var wanted = (hint === undefined || hint === null) ? "" : String(hint).replace(/^\s+|\s+$/g, "");
    if (wanted !== "") {
        if (/^\d+$/.test(wanted)) {
            var index = parseInt(wanted, 10) - 1;
            if (index >= 0 && index < list.length) return list[index].param;
        } else {
            // A NAME hint is trusted even for a field whose content is a number:
            // getValue() gives a text field showing "190" (our damage counter) and
            // a slider at 190 the same plain string, so the author's hint decides.
            var lowered = wanted.toLowerCase();
            var k;
            for (k = 0; k < all.length; k++) if (all[k].name.toLowerCase() === lowered) return all[k].param;
            for (k = 0; k < all.length; k++) if (all[k].name.toLowerCase().indexOf(lowered) !== -1) return all[k].param;
        }
        // a hint that matches nothing falls through to the automatic choice
    }
    if (!list.length) return null;

    for (var n = 0; n < list.length; n++) {
        if (/nick|name|player|gamertag/i.test(list[n].name)) return list[n].param;
    }
    return list[list.length - 1].param;
}

// Returns the selected clip's text-like Essential Graphics properties,
// for the Properties tab's dropdown.
function spidxListGraphicTextProperties() {
    try {
        var found = spidxSelectedGraphicsClip();
        if (!found) return '{"ok":true,"hasClip":false}';

        var props = found.component.properties;
        var names = [];
        for (var i = 0; i < props.numItems; i++) {
            var param = props[i];
            var raw = null;
            try { raw = param.getValue(); } catch (e) { raw = null; }
            if (spidxParamLooksLikeText(raw)) names.push(spidxEscape(param.displayName));
        }

        var clipName = "";
        try { clipName = found.clip.name; } catch (e) {}

        return '{"ok":true,"hasClip":true,"clip":"' + spidxEscape(clipName) + '"'
            + ',"properties":["' + names.join('","') + '"]}';
    } catch (err) {
        return spidxFail(err.toString());
    }
}

// Writes `text` into the named text property of the selected clip's
// Essential Graphics component. Called from the Properties tab's
// "Apply to selected clip" button with a nick picked from Leaderboard
// (or typed by hand).
function spidxSetGraphicText(displayName, text) {
    try {
        var found = spidxSelectedGraphicsClip();
        if (!found) return spidxFail("Select a Graphics (MOGRT) clip on the timeline first.");

        var param = found.component.properties.getParamForDisplayName(String(displayName));
        if (!param) return spidxFail("Property \"" + displayName + "\" was not found on the selected clip — the selection may have changed. Click Refresh.");

        spidxWriteParamText(param, text);
        return '{"ok":true}';
    } catch (err) {
        return spidxFail(err.toString());
    }
}
