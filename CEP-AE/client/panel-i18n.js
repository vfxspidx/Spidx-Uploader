/* Panel translations. The helper (Spider Engine 3) writes the dictionary of the language chosen in the Dashboard to
 * <incoming>\.panel-i18n.json: { "language": "pl", "strings": { "<English text>": "<translation>" } }.
 * The panel reads it (index.js, applyEngineStatus) and this file translates every text node / title / placeholder whose
 * text matches a key exactly - the same approach as the Dashboard. Anything without a translation stays English.
 * (Same file in CEP-AE\client and CEP-PPRO\client.) */
(function () {
    var DICT = {}, LANG = "en", started = false;
    var ATTRS = ["placeholder", "title", "aria-label", "alt"];
    var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, CODE: 1, PRE: 1, INPUT: 0 };

    function norm(s) { return String(s).replace(/\s+/g, " ").replace(/^\s+|\s+$/g, ""); }
    function lookup(s) {
        var hit = DICT[norm(s)];
        return (typeof hit === "string" && hit) ? hit : null;
    }
    function skipped(el) {
        for (; el && el.nodeType === 1; el = el.parentNode) {
            if (SKIP[el.tagName] || el.hasAttribute("data-no-i18n")) return true;
        }
        return false;
    }
    function doText(node) {
        var raw = node.nodeValue;
        if (!raw || !/[A-Za-z]/.test(raw)) return;
        var hit = lookup(raw);
        if (hit === null) return;
        var lead = raw.match(/^\s*/)[0], trail = raw.match(/\s*$/)[0];
        var next = lead + hit + trail;
        if (next !== raw) node.nodeValue = next;
    }
    function doElement(el) {
        if (el.nodeType !== 1 || skipped(el)) return;
        for (var i = 0; i < ATTRS.length; i++) {
            var v = el.getAttribute(ATTRS[i]);
            if (v) { var a = lookup(v); if (a !== null && a !== v) el.setAttribute(ATTRS[i], a); }
        }
    }
    function walk(root) {
        if (!root) return;
        if (root.nodeType === 3) { if (!skipped(root.parentNode)) doText(root); return; }
        if (root.nodeType !== 1 || skipped(root)) return;
        doElement(root);
        for (var c = root.firstChild; c; c = c.nextSibling) walk(c);
    }
    function start() {
        if (started || !document.body) return;
        started = true;
        new MutationObserver(function (muts) {
            if (LANG === "en") return;
            for (var i = 0; i < muts.length; i++) {
                var m = muts[i];
                if (m.type === "childList") { for (var j = 0; j < m.addedNodes.length; j++) walk(m.addedNodes[j]); }
                else if (m.type === "characterData") { if (!skipped(m.target.parentNode)) doText(m.target); }
                else if (m.type === "attributes") { doElement(m.target); }
            }
        }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    }

    window.PanelI18n = {
        language: function () { return LANG; },
        // lang "en" (or no dictionary) = leave the English text alone
        set: function (lang, dict) {
            var wasTranslated = LANG !== "en";
            LANG = lang || "en";
            DICT = dict || {};
            if (LANG === "en") { if (wasTranslated) location.reload(); return; }   // back to English: reload to restore the original texts
            start();
            walk(document.body);
        }
    };
})();
