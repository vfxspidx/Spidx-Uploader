"use strict";

/* ========================================================================
 *  Spidx i18n  -  one tiny translation layer shared by the tray app, the
 *  Dashboard and the setup wizard.
 *
 *  KEY IDEA: the English text IS the key.
 *      t("Could not save.")                      -> "Nie udało się zapisać."
 *      t("Switched to {name}", { name: "A" })    -> "Przełączono na A"
 *  Locale files (App/locales/<code>.json) are flat { "English": "Translated" }
 *  maps. A missing key simply falls back to the English text, so an
 *  untranslated string can never break the UI - it just stays English.
 *
 *  Adding a language = drop a new App/locales/<code>.json file and add one
 *  line to LANGUAGES below. Nothing else in the code has to change.
 *
 *  Language choice: helper-config.json -> "language": "auto" | "en" | "pl" ...
 *  "auto" follows the Windows display language.
 *
 *  Pages (Dashboard / wizard) get a small client runtime from clientScript():
 *    - t(text, vars)         for strings built in the page's own JS
 *    - automatic translation of static HTML text nodes and of the
 *      attributes placeholder / title / aria-label / alt
 *    - data-i18n-html="English HTML"  for an element whose text contains inline
 *      markup (<b>, <code>, links...) - the whole innerHTML is swapped, so word
 *      order can differ per language
 *    - data-no-i18n on any element = leave this subtree alone
 *  A MutationObserver keeps text that the page inserts later translated too.
 * ==================================================================== */

const fs = require("fs");
const path = require("path");

const APP_DIR = __dirname;
const LOCALE_DIR = path.join(APP_DIR, "locales");
const CONFIG_FILE = path.join(APP_DIR, "helper-config.json");

// code -> name shown in the language picker (always in its own language).
const LANGUAGES = [
    { code: "en",    name: "English" },
    { code: "pl",    name: "Polski" },
    { code: "de",    name: "Deutsch" },
    { code: "fr",    name: "Français" },
    { code: "es",    name: "Español" },
    { code: "pt-BR", name: "Português (Brasil)" },
    { code: "it",    name: "Italiano" },
    { code: "tr",    name: "Türkçe" },
    { code: "ru",    name: "Русский" }
];
const CODES = new Set(LANGUAGES.map(l => l.code));

const dictCache = new Map();

function normKey(s) {
    return String(s).replace(/\s+/g, " ").trim();
}

function loadDict(code) {
    if (code === "en" || !CODES.has(code)) return {};
    if (dictCache.has(code)) return dictCache.get(code);
    let dict = {};
    try {
        dict = JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, code + ".json"), "utf8"));
    } catch { dict = {}; }
    dictCache.set(code, dict);
    return dict;
}

// Best-effort guess from the OS display language.
function systemLanguage() {
    let loc = "";
    try { loc = Intl.DateTimeFormat().resolvedOptions().locale || ""; } catch {}
    if (!loc) loc = process.env.LC_ALL || process.env.LANG || "";
    loc = String(loc).replace("_", "-").toLowerCase();
    if (loc.startsWith("pt")) return "pt-BR";
    const base = loc.split(/[-.]/)[0];
    return CODES.has(base) ? base : "en";
}

function configuredLanguage() {
    let pref = "auto";
    try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
        if (cfg && typeof cfg.language === "string") pref = cfg.language;
    } catch {}
    return pref;
}

// The language actually in use right now ("en", "pl", ...).
function currentLanguage() {
    const pref = configuredLanguage();
    if (pref === "auto" || !CODES.has(pref)) return systemLanguage();
    return pref;
}

function fill(text, vars) {
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null) ? m : String(vars[k]));
}

// Translate an English string. `lang` is optional (defaults to the configured one).
function t(text, vars, lang) {
    const code = lang || currentLanguage();
    const dict = loadDict(code);
    const hit = dict[normKey(text)];
    return fill(typeof hit === "string" && hit ? hit : text, vars);
}

function languageList() { return LANGUAGES.slice(); }

function isValidPreference(v) { return v === "auto" || CODES.has(v); }

/* ---------------- client runtime (for Dashboard / wizard pages) -------- */

function jsonForScript(obj) {
    return JSON.stringify(obj)
        .replace(/</g, "\\u003c")
        .split(String.fromCharCode(0x2028)).join("\\u2028")
        .split(String.fromCharCode(0x2029)).join("\\u2029");
}

// Returns the BODY of a <script> element (no tags). Defines, globally:
//   t(text, vars)   I18N_LANG   applyI18n(root)
function clientScript() {
    const lang = currentLanguage();
    const dict = loadDict(lang);
    return `
var I18N_LANG = ${jsonForScript(lang)};
var I18N_DICT = ${jsonForScript(dict)};
var I18N_PREF = ${jsonForScript(configuredLanguage())};
var I18N_LANGS = ${jsonForScript(LANGUAGES)};
function i18nNorm(s) { return String(s).replace(/\\s+/g, " ").trim(); }
function t(text, vars) {
    var hit = I18N_DICT[i18nNorm(text)];
    var out = (typeof hit === "string" && hit) ? hit : text;
    if (vars) out = out.replace(/\\{(\\w+)\\}/g, function (m, k) { return (vars[k] === undefined || vars[k] === null) ? m : String(vars[k]); });
    return out;
}
(function () {
    if (I18N_LANG === "en") { window.applyI18n = function () {}; return; }
    var ATTRS = ["placeholder", "title", "aria-label", "alt"];
    var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, CODE: 1, PRE: 1 };
    function skipped(el) {
        for (; el && el.nodeType === 1; el = el.parentNode) {
            if (SKIP[el.tagName] || el.hasAttribute("data-no-i18n")) return true;
        }
        return false;
    }
    function lookup(s) {
        var hit = I18N_DICT[i18nNorm(s)];
        return (typeof hit === "string" && hit) ? hit : null;
    }
    function doText(node) {
        var raw = node.nodeValue;
        if (!raw || !/[A-Za-z]/.test(raw)) return;
        var hit = lookup(raw);
        if (hit === null) return;
        var lead = raw.match(/^\\s*/)[0], trail = raw.match(/\\s*$/)[0];
        var next = lead + hit + trail;
        if (next !== raw) node.nodeValue = next;
    }
    function doElement(el) {
        if (el.nodeType !== 1 || skipped(el)) return;
        var html = el.getAttribute("data-i18n-html");
        if (html !== null) {
            var h = lookup(html);
            if (h !== null && el.innerHTML !== h) el.innerHTML = h;
        }
        for (var i = 0; i < ATTRS.length; i++) {
            var v = el.getAttribute(ATTRS[i]);
            if (v) { var a = lookup(v); if (a !== null && a !== v) el.setAttribute(ATTRS[i], a); }
        }
    }
    function walk(root) {
        if (!root) return;
        if (root.nodeType === 3) { if (!skipped(root.parentNode)) doText(root); return; }
        if (root.nodeType !== 1) return;
        if (skipped(root)) return;
        doElement(root);
        if (root.hasAttribute("data-i18n-html")) return;
        for (var c = root.firstChild; c; c = c.nextSibling) walk(c);
    }
    window.applyI18n = function (root) { walk(root || document.body); };
    function start() {
        document.documentElement.setAttribute("lang", I18N_LANG);
        var tt = lookup(document.title); if (tt !== null) document.title = tt;
        walk(document.body);
        new MutationObserver(function (muts) {
            for (var i = 0; i < muts.length; i++) {
                var m = muts[i];
                if (m.type === "childList") { for (var j = 0; j < m.addedNodes.length; j++) walk(m.addedNodes[j]); }
                else if (m.type === "characterData") { if (!skipped(m.target.parentNode)) doText(m.target); }
                else if (m.type === "attributes") { doElement(m.target); }
            }
        }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    }
    if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
})();
`;
}

module.exports = {
    dictFor: code => Object.assign({}, loadDict(code)),
    t, currentLanguage, configuredLanguage, languageList, isValidPreference,
    clientScript, normKey, LANGUAGES, LOCALE_DIR
};
