"use strict";

/* ========================================================================
 *  Rules for files that land in the incoming folder.
 *
 *  The VEGAS Pro plugin tags its files with ".vg" just before the extension
 *  ("spidx_1759.vg.png", "spidx_1759.vg.ps.png"). That marker lets the ENGINE
 *  (not just the panel) enforce "VEGAS is a Pro feature": a tagged file from a
 *  non-Pro licence is refused. The marker is stripped again before upload, so
 *  Drive / WorkUpload only ever see the clean name.
 *
 *  NOTE: an older VEGAS plugin that doesn't tag its files can't be told apart
 *  from the After Effects panel's plain ".png" - updating the plugin (the
 *  Dashboard's plugin update) replaces it with the tagging version.
 * ==================================================================== */

// ".vg" directly before ".ps"? + the extension - and nothing else, so a file such
// as "my.vgfile.png" is not mistaken for a tagged one.
const VEGAS_MARKER = /\.vg(?=(?:\.ps)?\.[^.\\/]+$)/i;

function parseIncomingName(name) {
    const vegas = VEGAS_MARKER.test(name);
    const cleanName = vegas ? name.replace(VEGAS_MARKER, "") : name;
    return { vegas, cleanName, source: vegas ? "vegas" : null };
}

// canUsePro: tierAllowsProFeatures(currentTier)
function decideIncoming(name, canUsePro) {
    const parsed = parseIncomingName(name);
    if (parsed.vegas && !canUsePro) {
        return { action: "reject", ...parsed, reason: "VEGAS Pro uploads need a Pro plan." };
    }
    return { action: "accept", ...parsed };
}

module.exports = { parseIncomingName, decideIncoming, VEGAS_MARKER };
