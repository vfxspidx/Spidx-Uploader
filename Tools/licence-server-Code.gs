// ============================================================================
// Spidx Uploader - licence server (Google Apps Script web app), version 3.0
// This file contains NO secret. Never paste a key into it.
//
// SCRIPT PROPERTIES (Project Settings > Script properties):
//   ADMIN_KEY           long random value; must match ADMIN_KEY in the Discord bot / the shop.
//   LICENSE_PRIVATE_KEY the whole contents of Tools\keys\license-private-key.pem (BEGIN/END lines included).
//                       Made by Tools\Generate License Keys.bat. This is what makes a licence unforgeable.
//   PACK_FOLDER_ID      the id of the PRIVATE Drive folder with the Thumbnail Pack files (see Tools\\PACK-README.txt).
//   HMAC_SECRET         TEMPORARY. The same value that is still written in App\license.js (LICENSE_SECRET).
//                       Only needed while apps WITHOUT App\license-public-key.pem are out there. Once every
//                       user has the 3.0 app that ships the public key, DELETE this property: the old
//                       "signature" field stops being sent and the old shared secret is worthless.
//
// WHAT THE SERVER ENFORCES (so that nothing important is decided on the user's computer):
//   * Your plan (rank + roles) comes only from the sheet, for the Google account Google itself vouches for.
//   * A signed proof "you are pro+spt" is valid for LICENSE_PROOF_VALID_MS_ (14 days) and is bound to the
//     COMPUTER it was issued to (sig3): copying a licence file to another PC does not work.
//   * A paid rank only counts on a registered device (2 per account), so sharing an account is limited.
//   * The free plan's monthly video renders are COUNTED HERE (account AND computer), answers are signed.
//   * Refund / chargeback switches a code off and removes what it gave (adminRefundCode).
//
// SHEETS: "Arkusz1" (email | rank | trialEndsAt | addons), "Licenses" (or "Coupons"), "Redemptions",
//         "Devices", and "RenderLog" (created automatically).
// DEPLOY: Deploy > Manage deployments > pencil > Version: New version > Deploy (the /exec address stays).
// ============================================================================

const EXPECTED_CLIENT_ID = "198171519048-mhu4sj61m0fcgbualami37kblelmd95b.apps.googleusercontent.com";
const FREE_RENDERS_PER_MONTH_ = 15;
const LICENSE_PROOF_VALID_MS_ = 14 * 24 * 60 * 60 * 1000;   // how long a signed proof works offline

function getAdminKey() {
  return PropertiesService.getScriptProperties().getProperty("ADMIN_KEY") || "";
}

// Script properties are easy to paste with stray quotes, spaces or line breaks. This removes the harmless ones.
function cleanProp_(raw) {
  return String(raw || "").replace(/^[\s"'`]+|[\s"'`]+$/g, "");
}

// Legacy shared secret, read from a PROPERTY (never from this file). Empty = no legacy signature is sent.
function getHmacSecret_() {
  return cleanProp_(PropertiesService.getScriptProperties().getProperty("HMAC_SECRET"));
}

// A PEM private key however it was pasted: with or without the BEGIN/END lines, on one line, with "\n" typed
// literally, with Windows line ends or surrounded by quotes. Returns a proper PKCS#8 PEM ("" if nothing usable).
function normalizePem_(raw) {
  let t = String(raw || "").replace(/\\n/g, "\n").replace(/\r/g, "");
  if (/-----BEGIN (?:RSA )?PUBLIC KEY-----/.test(t) || /-----BEGIN CERTIFICATE-----/.test(t)) return "";   // not a private key
  const rsaOnly = /-----BEGIN RSA PRIVATE KEY-----/.test(t);                                                   // PKCS#1 keeps its own label
  const body = t.replace(/-----BEGIN [A-Z ]+-----/g, "").replace(/-----END [A-Z ]+-----/g, "").replace(/[^A-Za-z0-9+\/=]/g, "");
  if (body.length < 200) return "";
  const label = rsaOnly ? "RSA PRIVATE KEY" : "PRIVATE KEY";
  return "-----BEGIN " + label + "-----\n" + body.match(/.{1,64}/g).join("\n") + "\n-----END " + label + "-----\n";
}

function isValidAdminKey(key) {
  const expected = getAdminKey();
  // No key configured -> admin actions are refused outright, not silently open.
  return expected !== "" && String(key || "").trim() === expected.trim();
}

// ---------------------------------------------------------------------------
// Tiers: a RANK and ROLES. Rank order is highest first.
// ---------------------------------------------------------------------------
const RANKS_ = ["dev", "tester", "pro"];
const ROLES_ = ["spt"];

// "Pro + SPT", " pro,spt ", "spt|pro" -> { rank: "pro", roles: ["spt"] }.
function parseTier_(raw) {
  const words = String(raw || "").toLowerCase().split(/[+,|\s]+/);
  let rank = null;
  const roles = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (RANKS_.indexOf(w) !== -1 && (rank === null || RANKS_.indexOf(w) < RANKS_.indexOf(rank))) rank = w;
    if (ROLES_.indexOf(w) !== -1 && roles.indexOf(w) === -1) roles.push(w);
  }
  return { rank: rank, roles: roles };
}

function unionRoles_(a, b) {
  const out = (a || []).slice();
  (b || []).forEach(function (r) { if (out.indexOf(r) === -1) out.push(r); });
  return out;
}

// -> "pro+spt" | "pro" | "spt" | "free"
function composeTier_(rank, roles) {
  const parts = (rank ? [rank] : []).concat(roles || []);
  return parts.length ? parts.join("+") : "free";
}

function displayTier_(raw) {
  const p = parseTier_(raw);
  return (p.rank || p.roles.length) ? composeTier_(p.rank, p.roles) : String(raw || "").trim().toLowerCase();
}

function daysLeft_(date) {
  if (!date) return null;
  const d = new Date(date);
  if (isNaN(d.getTime())) return null;
  const ms = d.getTime() - Date.now();
  return ms > 0 ? Math.ceil(ms / (24 * 60 * 60 * 1000)) : null;
}

// Verifies a Google ID token via Google's tokeninfo endpoint and returns the verified email from it.
// NEVER trust an "email" the client sends, only what Google vouches for in a token it signed.
function verifyGoogleIdToken(idToken) {
  if (!idToken) {
    throw new Error("Missing idToken.");
  }

  const response = UrlFetchApp.fetch(
    "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken),
    { muteHttpExceptions: true }
  );

  if (response.getResponseCode() !== 200) {
    throw new Error("Invalid or expired Google ID token.");
  }

  const payload = JSON.parse(response.getContentText());

  if (payload.aud !== EXPECTED_CLIENT_ID) {
    throw new Error("Token was not issued for this app.");
  }
  if (payload.email_verified !== "true" && payload.email_verified !== true) {
    throw new Error("Email not verified by Google.");
  }
  if (!payload.email) {
    throw new Error("Token did not include an email.");
  }

  return String(payload.email).trim().toLowerCase();
}

// "Licenses" is the current name - falls back to the old "Coupons" tab.
function getLicensesSheet(ss) {
  return ss.getSheetByName("Licenses") || ss.getSheetByName("Coupons");
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

// RSA, PKCS#1 v1.5 + SHA-256: what Node's crypto.verify("RSA-SHA256") checks in the app.
function signRsa_(payload) {
  const key = normalizePem_(PropertiesService.getScriptProperties().getProperty("LICENSE_PRIVATE_KEY"));
  if (!key) return "";   // not configured yet: the response simply has no RSA signature
  return Utilities.base64Encode(Utilities.computeRsaSha256Signature(payload, key));
}

// The signed text MUST be exactly: email|tier|timestamp|expiresAt
function signLicense_(email, tier, timestamp, expiresAt) {
  return signRsa_([email, tier, String(timestamp), String(expiresAt)].join("|"));
}

// The same text plus the computer's id: a proof that only counts on the machine it was issued to.
function signLicenseDevice_(email, tier, timestamp, expiresAt, deviceId) {
  return signRsa_([email, tier, String(timestamp), String(expiresAt), deviceId].join("|"));
}

function hmacHex_(payload, secret) {
  return Utilities.computeHmacSha256Signature(payload, secret)
    .map(function (b) { return (b < 0 ? b + 256 : b).toString(16).padStart(2, "0"); }).join("");
}

// ---------------------------------------------------------------------------
// GET: the tier check (the app calls this at start and then periodically)
// ---------------------------------------------------------------------------
function doGet(e) {
  const params = (e && e.parameter) || {};
  const deviceId = (params.deviceId || "").trim().slice(0, 80);
  const deviceName = (params.deviceName || "").trim().slice(0, 60);

  let email;
  try {
    email = verifyGoogleIdToken(params.idToken || "");
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: "invalid_token", message: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Arkusz1");
  const data = sheet.getDataRange().getValues();

  let rank = null;      // dev / tester / pro, or null = free
  let roles = [];       // e.g. ["spt"]; they never expire
  let trialDaysRemaining = null;

  for (let i = 1; i < data.length; i++) {
    const rowEmail = String(data[i][0]).trim().toLowerCase();
    if (rowEmail !== email) continue;

    // Column B = rank (older rows may still hold "pro+spt" here), column D = add-on roles.
    const parsed = parseTier_(data[i][1]);
    rank = parsed.rank;
    roles = unionRoles_(parsed.roles, parseTier_(data[i][3]).roles);

    // Column C (trialEndsAt) is optional - blank means the RANK never expires (lifetime). A date means the
    // rank falls back to "free" once that day has passed. An unparseable date fails safe to "free".
    // Roles are not affected.
    const trialEndsAtRaw = data[i][2];
    if (trialEndsAtRaw && rank) {
      const trialEndsAt = new Date(trialEndsAtRaw);
      if (isNaN(trialEndsAt.getTime())) {
        rank = null;
      } else {
        const msRemaining = trialEndsAt.getTime() - Date.now();
        if (msRemaining <= 0) {
          rank = null;
        } else {
          trialDaysRemaining = Math.ceil(msRemaining / (24 * 60 * 60 * 1000));
        }
      }
    }
    break;
  }

  let tier = composeTier_(rank, roles);
  let deviceLimitReached = false;

  if (tier !== "free" && deviceId) {
    const devicesSheet = ss.getSheetByName("Devices");
    if (devicesSheet) {
      const deviceData = devicesSheet.getDataRange().getValues();
      const seenDevices = [];
      let alreadyRegistered = false;

      for (let i = 1; i < deviceData.length; i++) {
        const rowEmail = String(deviceData[i][0]).trim().toLowerCase();
        const rowDevice = String(deviceData[i][1]).trim();
        if (rowEmail === email) {
          seenDevices.push(rowDevice);
          if (rowDevice === deviceId) {
            alreadyRegistered = true;
            // Hostname can change (renamed PC, reinstalled OS) - keep the label current.
            if (deviceName && String(deviceData[i][3] || "").trim() !== deviceName) {
              devicesSheet.getRange(i + 1, 4).setValue(deviceName);
            }
          }
        }
      }

      if (!alreadyRegistered) {
        if (seenDevices.length < 2) {
          devicesSheet.appendRow([email, deviceId, new Date(), deviceName]);
        } else {
          deviceLimitReached = true;
          tier = "free";
        }
      }
    }
  }

  const timestamp = Date.now();
  const expiresAt = String(timestamp + LICENSE_PROOF_VALID_MS_);
  const secret = getHmacSecret_();
  const legacySignature = secret ? hmacHex_(email + "|" + tier + "|" + timestamp, secret) : "";

  return ContentService
    .createTextOutput(JSON.stringify({
      email: email,
      tier: tier,
      timestamp: timestamp,
      signature: legacySignature,                                   // legacy HMAC: dropped when HMAC_SECRET is deleted
      expiresAt: expiresAt,                                         // the proof works offline until then
      sig2: signLicense_(email, tier, timestamp, expiresAt),        // RSA: cannot be forged without the private key
      sig3: deviceId ? signLicenseDevice_(email, tier, timestamp, expiresAt, deviceId) : "",   // RSA, bound to this computer
      deviceLimitReached: deviceLimitReached,
      trialDaysRemaining: trialDaysRemaining
    }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================================
// POST side - a Web App has exactly one doGet and one doPost per deployment, both at the SAME url.
// doPost dispatches on body.action:
//
//   admin* actions         -> the Discord bot / the shop (ADMIN_KEY, no Google identity)
//   "listDevices"          -> list the CALLER's own registered devices
//   "removeDevice"         -> remove one of the CALLER's own devices
//   "renderPermit"         -> free plan: may this video render be counted? (idempotent per key)
//   "renderUsage"          -> free plan: how many renders used this month?
//   "packManifest"/"packFile" -> Thumbnail Pack content (templates, presets, MOGRT): ONLY for accounts that have it
//   (absent, or "redeem")  -> redeem a license code
//
// User actions only ever match rows for the caller's verified email.
//
// Sheets: "Licenses": code | tier | durationDays | maxUses | usesSoFar | active | note
//         "Redemptions": email | code | redeemedAt
//         "Devices": email | deviceId | addedAt | deviceName
//         "Arkusz1": email | tier (rank) | trialEndsAt | addons
// durationDays: BLANK = lifetime. A number = expires that many days after redemption.
// A code that carries ONLY roles (e.g. "spt") is always lifetime.
// maxUses: 1 = private single-use code; N>1 = public code good for N redemptions in total.
// ============================================================================
function doPost(e) {
  let body = {};
  try {
    body = (e && e.postData && e.postData.contents) ? JSON.parse(e.postData.contents) : {};
  } catch (err) {
    return jsonResponse({ ok: false, message: "Malformed request body." });
  }

  // Admin actions are checked FIRST and use ADMIN_KEY instead of a Google ID token.
  if (body.action === "adminCreateCode" || body.action === "adminCodeInfo" || body.action === "adminRevokeCode" || body.action === "adminListCodes"
      || body.action === "adminRefundCode" || body.action === "adminRestoreCode" || body.action === "adminBulkCreateCodes") {
    if (!isValidAdminKey(body.adminKey)) {
      return jsonResponse({ ok: false, message: "Invalid admin key." });
    }
    if (body.action === "adminCreateCode") return adminCreateCode(body);
    if (body.action === "adminCodeInfo") return adminCodeInfo(body.code);
    if (body.action === "adminListCodes") return adminListCodes(body);
    if (body.action === "adminRefundCode") return adminRefundCode(body.code, body.reason);
    if (body.action === "adminRestoreCode") return adminRestoreCode(body.code);
    if (body.action === "adminBulkCreateCodes") return adminBulkCreateCodes(body);
    return adminRevokeCode(body.code);
  }

  // Every other action is a real user, verified via their Google ID token.
  let email;
  try {
    email = verifyGoogleIdToken(body.idToken || "");
  } catch (err) {
    return jsonResponse({ ok: false, message: err.message });
  }

  if (body.action === "listDevices") return listDevices(email);
  if (body.action === "removeDevice") return removeDevice(email, body.deviceId);
  if (body.action === "renderPermit") return renderCheck_(email, body, true);
  if (body.action === "renderUsage") return renderCheck_(email, body, false);
  if (body.action === "packManifest") return packManifest_(email, body);
  if (body.action === "packFile") return packFile_(email, body);

  return redeemLicenseCode(email, body.code);
}

function redeemLicenseCode(email, rawCode) {
  const code = String(rawCode || "").trim().toUpperCase();
  if (!code) {
    return jsonResponse({ ok: false, message: "No code entered." });
  }

  // LockService serializes concurrent doPost calls across ALL users - without it, two people redeeming the
  // same near-exhausted code in the same second could both read usesSoFar before either write finishes.
  const lock = LockService.getScriptLock();
  const gotLock = lock.tryLock(10000);
  if (!gotLock) {
    return jsonResponse({ ok: false, message: "Server is busy, please try again in a moment." });
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const licensesSheet = getLicensesSheet(ss);
    const redemptionsSheet = ss.getSheetByName("Redemptions");
    if (!licensesSheet || !redemptionsSheet) {
      return jsonResponse({ ok: false, message: "License system isn't set up (missing sheet tabs)." });
    }

    const licenseData = licensesSheet.getDataRange().getValues();
    let licenseRowIndex = -1; // 1-based sheet row
    let tier = null;
    let durationDays = null;  // null = lifetime
    let maxUses = 0;
    let usesSoFar = 0;

    for (let i = 1; i < licenseData.length; i++) {
      const rowCode = String(licenseData[i][0]).trim().toUpperCase();
      if (rowCode !== code) continue;

      licenseRowIndex = i + 1;
      tier = String(licenseData[i][1]).trim().toLowerCase();

      const durationRaw = licenseData[i][2];
      durationDays = (durationRaw === "" || durationRaw === null) ? null : (Number(durationRaw) || 0);

      maxUses = Number(licenseData[i][3]) || 0;
      usesSoFar = Number(licenseData[i][4]) || 0;
      const active = licenseData[i][5];
      if (active !== true && String(active).trim().toUpperCase() !== "TRUE") {
        return jsonResponse({ ok: false, message: "This code is no longer active." });
      }
      break;
    }

    if (licenseRowIndex === -1) {
      return jsonResponse({ ok: false, message: "Invalid code." });
    }
    if (usesSoFar >= maxUses) {
      return jsonResponse({ ok: false, message: "This code has already been fully redeemed." });
    }

    const codeTier = parseTier_(tier);
    if (!codeTier.rank && codeTier.roles.length === 0) {
      return jsonResponse({ ok: false, message: "This code has an unknown tier. Please contact support." });
    }

    // One redemption per (email, code) ever.
    const redemptionData = redemptionsSheet.getDataRange().getValues();
    for (let i = 1; i < redemptionData.length; i++) {
      const rowEmail = String(redemptionData[i][0]).trim().toLowerCase();
      const rowCode = String(redemptionData[i][1]).trim().toUpperCase();
      if (rowEmail === email && rowCode === code) {
        return jsonResponse({ ok: false, message: "You've already redeemed this code." });
      }
    }

    // All checks passed - commit the three writes together, still inside the lock.
    // Only a code that carries a RANK can set an expiry; roles are permanent.
    const trialEndsAt = (durationDays === null || !codeTier.rank) ? null : new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);
    const merged = upsertMainSheetRow(ss, email, codeTier, trialEndsAt);
    licensesSheet.getRange(licenseRowIndex, 5).setValue(usesSoFar + 1); // column E = usesSoFar
    redemptionsSheet.appendRow([email, code, new Date()]);

    // tier = what this person has NOW (e.g. "pro+spt"), not just what the code carried.
    return jsonResponse({
      ok: true,
      tier: merged.tier,
      trialDaysRemaining: merged.trialDaysRemaining // null = no expiry (lifetime), same convention doGet uses
    });
  } finally {
    lock.releaseLock();
  }
}

// Creates a new row in Licenses (or Coupons) and returns the generated code.
// tier: "pro" | "tester" | "dev" | "spt" | "pro+spt". A code with only roles is always lifetime.
// durationDays: number, or null/absent for a lifetime code. maxUses: how many people may redeem it (default 1).
// note: free text for your own reference, written to column G.
function adminCreateCode(body) {
  const parsedTier = parseTier_(body.tier);
  if (!parsedTier.rank && parsedTier.roles.length === 0) {
    return jsonResponse({ ok: false, message: "Unknown tier \"" + String(body.tier || "") + "\". Use pro, tester, dev, spt, or a combination like pro+spt." });
  }
  const tier = composeTier_(parsedTier.rank, parsedTier.roles);

  let durationDays = (body.durationDays === null || body.durationDays === undefined || body.durationDays === "")
    ? null
    : Number(body.durationDays);
  if (durationDays !== null && (!Number.isFinite(durationDays) || durationDays < 1)) {
    return jsonResponse({ ok: false, message: "durationDays must be a positive number, or omitted for lifetime." });
  }
  if (!parsedTier.rank) durationDays = null; // roles never expire

  const maxUses = Number(body.maxUses) || 1;
  if (maxUses < 1) {
    return jsonResponse({ ok: false, message: "maxUses must be at least 1." });
  }

  const lock = LockService.getScriptLock();
  const gotLock = lock.tryLock(10000);
  if (!gotLock) {
    return jsonResponse({ ok: false, message: "Server is busy, please try again in a moment." });
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const licensesSheet = getLicensesSheet(ss);
    if (!licensesSheet) {
      return jsonResponse({ ok: false, message: "License system isn't set up (missing sheet tab)." });
    }

    const code = generateUniqueCode(licensesSheet);
    // code | tier | durationDays | maxUses | usesSoFar | active | note
    licensesSheet.appendRow([code, tier, durationDays === null ? "" : durationDays, maxUses, 0, true, String(body.note || "")]);

    return jsonResponse({ ok: true, code: code, tier: tier, durationDays: durationDays, maxUses: maxUses });
  } finally {
    lock.releaseLock();
  }
}

// XXXX-XXXX-XXXX, excluding easily-confused characters (0/O, 1/I).
function generateUniqueCode(licensesSheet) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const existing = new Set(
    licensesSheet.getDataRange().getValues().slice(1).map(row => String(row[0]).trim().toUpperCase())
  );

  for (let attempt = 0; attempt < 50; attempt++) {
    const groups = [];
    for (let g = 0; g < 3; g++) {
      let group = "";
      for (let c = 0; c < 4; c++) {
        group += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
      }
      groups.push(group);
    }
    const code = groups.join("-");
    if (!existing.has(code)) return code;
  }
  throw new Error("Could not generate a unique code, please try again.");
}

// Lists codes, newest first. body.activeOnly (default true) skips revoked codes. body.limit caps the rows (max 25).
function adminListCodes(body) {
  const activeOnly = body.activeOnly !== false;
  const limit = Math.min(25, Math.max(1, Number(body.limit) || 25));

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const licensesSheet = getLicensesSheet(ss);
  if (!licensesSheet) {
    return jsonResponse({ ok: false, message: "License system isn't set up (missing sheet tab)." });
  }

  const data = licensesSheet.getDataRange().getValues();
  const codes = [];
  for (let i = data.length - 1; i >= 1; i--) { // newest (bottom of sheet) first
    const active = (data[i][5] === true || String(data[i][5]).trim().toUpperCase() === "TRUE");
    if (activeOnly && !active) continue;

    const durationRaw = data[i][2];
    codes.push({
      code: String(data[i][0]).trim().toUpperCase(),
      tier: displayTier_(data[i][1]),
      durationDays: (durationRaw === "" || durationRaw === null || durationRaw === undefined) ? null : Number(durationRaw),
      maxUses: Number(data[i][3]) || 0,
      usesSoFar: Number(data[i][4]) || 0,
      active: active
    });
    if (codes.length >= limit) break;
  }

  return jsonResponse({ ok: true, codes: codes });
}

function adminCodeInfo(rawCode) {
  const code = String(rawCode || "").trim().toUpperCase();
  if (!code) {
    return jsonResponse({ ok: false, message: "No code given." });
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const licensesSheet = getLicensesSheet(ss);
  if (!licensesSheet) {
    return jsonResponse({ ok: false, message: "License system isn't set up (missing sheet tab)." });
  }

  const data = licensesSheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toUpperCase() !== code) continue;
    const durationRaw = data[i][2];
    const active = data[i][5];
    return jsonResponse({
      ok: true,
      code: code,
      tier: displayTier_(data[i][1]),
      durationDays: (durationRaw === "" || durationRaw === null || durationRaw === undefined) ? null : Number(durationRaw),
      maxUses: Number(data[i][3]) || 0,
      usesSoFar: Number(data[i][4]) || 0,
      active: (active === true || String(active).trim().toUpperCase() === "TRUE")
    });
  }

  return jsonResponse({ ok: false, message: "Code not found." });
}

// Sets active = false. Does NOT touch anyone who already redeemed it (use adminRefundCode for that).
function adminRevokeCode(rawCode) {
  const code = String(rawCode || "").trim().toUpperCase();
  if (!code) {
    return jsonResponse({ ok: false, message: "No code given." });
  }

  const lock = LockService.getScriptLock();
  const gotLock = lock.tryLock(10000);
  if (!gotLock) {
    return jsonResponse({ ok: false, message: "Server is busy, please try again in a moment." });
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const licensesSheet = getLicensesSheet(ss);
    if (!licensesSheet) {
      return jsonResponse({ ok: false, message: "License system isn't set up (missing sheet tab)." });
    }

    const data = licensesSheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim().toUpperCase() !== code) continue;
      licensesSheet.getRange(i + 1, 6).setValue(false); // column F = active
      return jsonResponse({ ok: true, code: code });
    }

    return jsonResponse({ ok: false, message: "Code not found." });
  } finally {
    lock.releaseLock();
  }
}

// Returns the caller's own registered devices (never anyone else's).
function listDevices(email) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const devicesSheet = ss.getSheetByName("Devices");
  if (!devicesSheet) {
    return jsonResponse({ ok: true, devices: [] });
  }

  const deviceData = devicesSheet.getDataRange().getValues();
  const devices = [];
  for (let i = 1; i < deviceData.length; i++) {
    const rowEmail = String(deviceData[i][0]).trim().toLowerCase();
    if (rowEmail !== email) continue;
    devices.push({
      deviceId: String(deviceData[i][1]).trim(),
      addedAt: deviceData[i][2] || null,
      name: String(deviceData[i][3] || "").trim() || null
    });
  }
  return jsonResponse({ ok: true, devices: devices });
}

// Frees one of the caller's own device slots - only ever matches rows for the caller's verified email.
function removeDevice(email, deviceId) {
  const id = String(deviceId || "").trim();
  if (!id) {
    return jsonResponse({ ok: false, message: "No device specified." });
  }

  const lock = LockService.getScriptLock();
  const gotLock = lock.tryLock(10000);
  if (!gotLock) {
    return jsonResponse({ ok: false, message: "Server is busy, please try again in a moment." });
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const devicesSheet = ss.getSheetByName("Devices");
    if (!devicesSheet) {
      return jsonResponse({ ok: false, message: "Device tracking isn't set up (missing \"Devices\" tab)." });
    }

    const deviceData = devicesSheet.getDataRange().getValues();
    for (let i = deviceData.length - 1; i >= 1; i--) {
      const rowEmail = String(deviceData[i][0]).trim().toLowerCase();
      const rowDevice = String(deviceData[i][1]).trim();
      if (rowEmail === email && rowDevice === id) {
        devicesSheet.deleteRow(i + 1); // sheet rows are 1-based
        return jsonResponse({ ok: true });
      }
    }

    return jsonResponse({ ok: false, message: "That device wasn't found on your account." });
  } finally {
    lock.releaseLock();
  }
}

// Updates the matching row in "Arkusz1" for this email, or appends a new one.
//   B = rank, C = trialEndsAt (of the rank), D = add-on roles.
// A code that carries a rank REPLACES the rank and sets the expiry (null = lifetime). Roles are only ever ADDED.
// A code that carries only roles leaves the rank and its expiry untouched. Returns what the person has now.
function upsertMainSheetRow(ss, email, codeTier, trialEndsAt) {
  const sheet = ss.getSheetByName("Arkusz1");
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    const rowEmail = String(data[i][0]).trim().toLowerCase();
    if (rowEmail !== email) continue;

    const old = parseTier_(data[i][1]);                       // older rows may hold "pro+spt" in B
    const rank = codeTier.rank || old.rank;
    const roles = unionRoles_(unionRoles_(old.roles, parseTier_(data[i][3]).roles), codeTier.roles);

    let trialEnd = data[i][2] ? new Date(data[i][2]) : null;  // unchanged unless the code carries a rank
    sheet.getRange(i + 1, 2).setValue(rank || "free");         // column B = rank
    if (codeTier.rank) {
      trialEnd = trialEndsAt;
      if (trialEndsAt === null) sheet.getRange(i + 1, 3).clearContent();
      else sheet.getRange(i + 1, 3).setValue(trialEndsAt);     // column C = trialEndsAt
    }
    sheet.getRange(i + 1, 4).setValue(roles.join("+"));        // column D = add-on roles

    const expired = trialEnd && !isNaN(new Date(trialEnd).getTime()) && new Date(trialEnd).getTime() <= Date.now();
    const effectiveRank = expired ? null : rank;
    return { tier: composeTier_(effectiveRank, roles), trialDaysRemaining: effectiveRank ? daysLeft_(trialEnd) : null };
  }

  sheet.appendRow([email, codeTier.rank || "free", (codeTier.rank && trialEndsAt) ? trialEndsAt : "", codeTier.roles.join("+")]);
  return { tier: composeTier_(codeTier.rank, codeTier.roles), trialDaysRemaining: codeTier.rank ? daysLeft_(trialEndsAt) : null };
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================================
// Shop actions: refund / dispute handling and a pool of codes
//   adminRefundCode      : after a refund or chargeback. The code is switched off and everybody who redeemed it loses
//                          the RANK it gave (pro -> free, trialEndsAt cleared); roles the code carried (spt) too.
//   adminRestoreCode     : when a dispute is WON. The code is switched on again and the rank comes back (a timed
//                          code counts from the day it was redeemed).
//   adminBulkCreateCodes : { count, tier, durationDays, maxUses, note } -> { ok, codes: [...] }
// The shop sends the ADMIN_KEY of this script, so it has the same power as the Discord bot: keep that key private.
// ============================================================================
function findRedemptions_(ss, code) {
  const sh = ss.getSheetByName("Redemptions");
  const out = [];
  if (!sh) return out;
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1]).trim().toUpperCase() === code) out.push({ email: String(data[i][0]).trim().toLowerCase(), at: data[i][2] });
  }
  return out;
}

function findLicenseRow_(sheet, code) {
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toUpperCase() === code) return { row: i + 1, values: data[i] };
  }
  return null;
}

function adminRefundCode(rawCode, reason) {
  const code = String(rawCode || "").trim().toUpperCase();
  if (!code) return jsonResponse({ ok: false, message: "No code given." });
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return jsonResponse({ ok: false, message: "Server is busy, please try again in a moment." });
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const licenses = getLicensesSheet(ss);
    if (!licenses) return jsonResponse({ ok: false, message: "License system isn't set up (missing sheet tab)." });
    const lic = findLicenseRow_(licenses, code);
    if (!lic) return jsonResponse({ ok: false, message: "Code not found." });

    licenses.getRange(lic.row, 6).setValue(false);                                        // F = active -> nobody can redeem it any more
    const note = String(lic.values[6] || "");
    licenses.getRange(lic.row, 7).setValue((note ? note + " | " : "") + "REFUNDED " + Utilities.formatDate(new Date(), "UTC", "yyyy-MM-dd") + (reason ? " (" + String(reason).slice(0, 40) + ")" : ""));

    const codeTier = parseTier_(lic.values[1]);
    const arkusz = ss.getSheetByName("Arkusz1"), data = arkusz.getDataRange().getValues();
    const redeemed = findRedemptions_(ss, code);
    let downgraded = 0;
    redeemed.forEach(function (r) {
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][0]).trim().toLowerCase() !== r.email) continue;
        const now = parseTier_(data[i][1]);
        const roles = unionRoles_(now.roles, parseTier_(data[i][3]).roles).filter(function (x) { return codeTier.roles.indexOf(x) === -1; });
        let rank = now.rank;
        if (codeTier.rank && rank === codeTier.rank) { rank = null; arkusz.getRange(i + 1, 3).clearContent(); }   // the rank this code gave is taken away
        arkusz.getRange(i + 1, 2).setValue(rank || "free");
        arkusz.getRange(i + 1, 4).setValue(roles.join("+"));
        downgraded++;
        break;
      }
    });
    return jsonResponse({ ok: true, code: code, redeemedBy: redeemed.length, downgraded: downgraded });
  } finally {
    lock.releaseLock();
  }
}

function adminRestoreCode(rawCode) {
  const code = String(rawCode || "").trim().toUpperCase();
  if (!code) return jsonResponse({ ok: false, message: "No code given." });
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return jsonResponse({ ok: false, message: "Server is busy, please try again in a moment." });
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const licenses = getLicensesSheet(ss);
    if (!licenses) return jsonResponse({ ok: false, message: "License system isn't set up (missing sheet tab)." });
    const lic = findLicenseRow_(licenses, code);
    if (!lic) return jsonResponse({ ok: false, message: "Code not found." });

    licenses.getRange(lic.row, 6).setValue(true);
    const codeTier = parseTier_(lic.values[1]);
    const durRaw = lic.values[2], durationDays = (durRaw === "" || durRaw === null) ? null : Number(durRaw);
    let restored = 0;
    findRedemptions_(ss, code).forEach(function (r) {
      const endsAt = (durationDays === null || !codeTier.rank) ? null : new Date(new Date(r.at).getTime() + durationDays * 24 * 60 * 60 * 1000);
      if (endsAt && endsAt.getTime() <= Date.now()) return;                                // a timed code that has run out stays out
      upsertMainSheetRow(ss, r.email, codeTier, endsAt);
      restored++;
    });
    return jsonResponse({ ok: true, code: code, restored: restored });
  } finally {
    lock.releaseLock();
  }
}

// Many codes at once, for the shop's pool. The same format as adminCreateCode (XXXX-XXXX-XXXX), written in one go.
function adminBulkCreateCodes(body) {
  const parsedTier = parseTier_(body.tier || "pro");
  if (!parsedTier.rank && parsedTier.roles.length === 0) return jsonResponse({ ok: false, message: "Unknown tier." });
  const tier = composeTier_(parsedTier.rank, parsedTier.roles);
  const count = Math.floor(Number(body.count) || 0);
  if (count < 1 || count > 200) return jsonResponse({ ok: false, message: "count must be between 1 and 200." });
  let durationDays = (body.durationDays === null || body.durationDays === undefined || body.durationDays === "") ? null : Number(body.durationDays);
  if (durationDays !== null && (!Number.isFinite(durationDays) || durationDays < 1)) return jsonResponse({ ok: false, message: "durationDays must be a positive number, or omitted for lifetime." });
  if (!parsedTier.rank) durationDays = null;
  const maxUses = Number(body.maxUses) || 1;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return jsonResponse({ ok: false, message: "Server is busy, please try again in a moment." });
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const licenses = getLicensesSheet(ss);
    if (!licenses) return jsonResponse({ ok: false, message: "License system isn't set up (missing sheet tab)." });
    const existing = new Set(licenses.getDataRange().getValues().slice(1).map(function (row) { return String(row[0]).trim().toUpperCase(); }));
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", codes = [];
    while (codes.length < count) {
      let c = "";
      for (let g = 0; g < 3; g++) { if (g) c += "-"; for (let k = 0; k < 4; k++) c += alphabet.charAt(Math.floor(Math.random() * alphabet.length)); }
      if (!existing.has(c)) { existing.add(c); codes.push(c); }
    }
    const note = String(body.note || "shop");
    const rows = codes.map(function (c) { return [c, tier, durationDays === null ? "" : durationDays, maxUses, 0, true, note]; });
    licenses.getRange(licenses.getLastRow() + 1, 1, rows.length, 7).setValues(rows);
    return jsonResponse({ ok: true, count: codes.length, tier: tier, codes: codes });
  } finally {
    lock.releaseLock();
  }
}

// ============================================================================
// Free plan: monthly video renders, counted HERE
// ============================================================================
function renderMonth_() {
  return Utilities.formatDate(new Date(), "UTC", "yyyy-MM");
}

// Unlimited renders? Same rules as doGet: a rank that ran out is "free", and a paid rank only counts on a
// REGISTERED device (the device limit already runs a 3rd computer as free).
function rendersUnlimited_(ss, email, deviceId) {
  const sheet = ss.getSheetByName("Arkusz1");
  const data = sheet.getDataRange().getValues();
  let rank = null;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() !== email) continue;
    rank = parseTier_(data[i][1]).rank;
    const endsRaw = data[i][2];
    if (endsRaw && rank) {
      const ends = new Date(endsRaw);
      if (isNaN(ends.getTime()) || ends.getTime() <= Date.now()) rank = null;
    }
    break;
  }
  if (!rank) return false;

  const devices = ss.getSheetByName("Devices");
  if (!devices || !deviceId) return true;
  const d = devices.getDataRange().getValues();
  for (let i = 1; i < d.length; i++) {
    if (String(d[i][0]).trim().toLowerCase() === email && String(d[i][1]).trim() === deviceId) return true;
  }
  return false;
}

function getRenderLog_(ss) {
  let sh = ss.getSheetByName("RenderLog");
  if (!sh) {
    sh = ss.insertSheet("RenderLog");
    sh.appendRow(["month", "email", "deviceId", "key", "at"]);
  }
  return sh;
}

// The text that gets signed for a render answer. The app builds the same text.
function renderPayload_(email, deviceId, month, key, allowed, used, limit, timestamp) {
  return ["render", email, deviceId, month, key, allowed ? 1 : 0, used, limit === null ? "" : limit, timestamp].join("|");
}

function renderAnswer_(email, deviceId, month, key, allowed, used, limit) {
  const timestamp = Date.now();
  const payload = renderPayload_(email, deviceId, month, key, allowed, used, limit, timestamp);
  const secret = getHmacSecret_();
  return jsonResponse({
    ok: true, allowed: allowed, used: used, limit: limit, month: month, key: key,
    timestamp: timestamp,
    signature: secret ? hmacHex_(payload, secret) : "",   // legacy, goes away with HMAC_SECRET
    sig2: signRsa_(payload)
  });
}

// commit = true  -> "may I count this render?" (idempotent per key)
// commit = false -> "how many have I used?" (no write)
// The limit is decided HERE from the sheet; the client never says what its plan is.
function renderCheck_(email, body, commit) {
  const deviceId = String(body.deviceId || "").trim().slice(0, 80);
  const key = String(body.key || "").trim().slice(0, 120);
  if (!deviceId || (commit && !key)) return jsonResponse({ ok: false, message: "Missing deviceId or key." });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return jsonResponse({ ok: false, message: "Server is busy, please try again in a moment." });
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const month = renderMonth_();
    if (rendersUnlimited_(ss, email, deviceId)) {
      return renderAnswer_(email, deviceId, month, key, true, 0, null);   // Pro / tester / dev: nothing is logged
    }

    const log = getRenderLog_(ss);
    const rows = log.getDataRange().getValues();
    let usedAccount = 0, usedDevice = 0, seen = false;
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][0]) !== month) continue;
      const sameEmail = String(rows[i][1]).trim().toLowerCase() === email;
      const sameDevice = String(rows[i][2]).trim() === deviceId;
      if (sameEmail) usedAccount++;
      if (sameDevice) usedDevice++;
      if (sameEmail && key && String(rows[i][3]) === key) seen = true;
    }

    // The cap applies to the account AND to the computer, so a second Google account on the same PC does not reset it.
    let allowed;
    if (!commit) {
      allowed = Math.max(usedAccount, usedDevice) < FREE_RENDERS_PER_MONTH_;
    } else if (seen) {
      allowed = true;                                   // the same render asked twice: not counted twice
    } else if (usedAccount >= FREE_RENDERS_PER_MONTH_ || usedDevice >= FREE_RENDERS_PER_MONTH_) {
      allowed = false;
    } else {
      log.appendRow([month, email, deviceId, key, new Date()]);
      usedAccount++; usedDevice++;
      allowed = true;
    }
    return renderAnswer_(email, deviceId, month, key, allowed, Math.max(usedAccount, usedDevice), FREE_RENDERS_PER_MONTH_);
  } finally {
    lock.releaseLock();
  }
}


// ============================================================================
// Thumbnail Pack content: delivered ONLY to accounts that have it
//
// The templates (.aep), animation presets (.ffx) and MOGRT files are NOT in the installer. They live in a PRIVATE
// Google Drive folder (script property PACK_FOLDER_ID) together with a pack.json that lists them (made by
// Tools\make-pack-manifest.js). An account gets the manifest and the files only when the sheet says it has the
// "spt" role (or a dev / tester rank) AND the request comes from one of its registered computers. The manifest is
// signed; every file is checked against its sha256 in the (signed) manifest by the app.
// ============================================================================
function packEntitled_(ss, email, deviceId) {
  const data = ss.getSheetByName("Arkusz1").getDataRange().getValues();
  let rank = null, roles = [];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() !== email) continue;
    const parsed = parseTier_(data[i][1]);
    rank = parsed.rank;
    roles = unionRoles_(parsed.roles, parseTier_(data[i][3]).roles);
    const endsRaw = data[i][2];
    if (endsRaw && rank) {                                  // a timed rank that ran out is no rank (roles never expire)
      const ends = new Date(endsRaw);
      if (isNaN(ends.getTime()) || ends.getTime() <= Date.now()) rank = null;
    }
    break;
  }
  const has = roles.indexOf("spt") !== -1 || rank === "dev" || rank === "tester";
  if (!has) return false;
  const devices = ss.getSheetByName("Devices");              // only a registered computer of that account
  if (!devices || !deviceId) return false;
  const d = devices.getDataRange().getValues();
  for (let i = 1; i < d.length; i++) {
    if (String(d[i][0]).trim().toLowerCase() === email && String(d[i][1]).trim() === deviceId) return true;
  }
  return false;
}

function packIndex_() {
  const folderId = cleanProp_(PropertiesService.getScriptProperties().getProperty("PACK_FOLDER_ID"));
  if (!folderId) throw new Error("PACK_FOLDER_ID is not set.");
  const folder = DriveApp.getFolderById(folderId);
  const files = folder.getFilesByName("pack.json");
  if (!files.hasNext()) throw new Error("pack.json is missing in the pack folder.");
  const idx = JSON.parse(files.next().getBlob().getDataAsString());
  if (!idx || !Array.isArray(idx.items)) throw new Error("pack.json has no items.");
  return { folder: folder, version: Number(idx.version) || 1, items: idx.items };
}

// The text that gets signed for a pack answer. The app builds the same text (license.js, packPayload).
function packPayload_(email, deviceId, entitled, version, itemsJson, timestamp) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, itemsJson, Utilities.Charset.UTF_8)
    .map(function (b) { return (b < 0 ? b + 256 : b).toString(16).padStart(2, "0"); }).join("");
  return ["pack", email, deviceId, entitled ? 1 : 0, version, digest, timestamp].join("|");
}

function packManifest_(email, body) {
  const deviceId = String(body.deviceId || "").trim().slice(0, 80);
  if (!deviceId) return jsonResponse({ ok: false, message: "Missing deviceId." });
  let entitled = false, version = 0, itemsJson = "[]";
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    entitled = packEntitled_(ss, email, deviceId);
    if (entitled) {
      const idx = packIndex_();
      version = idx.version;
      // only the fields the app needs, so nothing else in pack.json is ever sent
      itemsJson = JSON.stringify(idx.items.map(function (it) {
        return { path: String(it.path), file: String(it.file), sha256: String(it.sha256), size: Number(it.size) || 0 };
      }));
    }
  } catch (err) {
    return jsonResponse({ ok: false, message: "Pack is not available: " + err.message });
  }
  const timestamp = Date.now();
  const payload = packPayload_(email, deviceId, entitled, version, itemsJson, timestamp);
  const secret = getHmacSecret_();
  return jsonResponse({
    ok: true, entitled: entitled, version: version, itemsJson: itemsJson, timestamp: timestamp,
    signature: secret ? hmacHex_(payload, secret) : "", sig2: signRsa_(payload)
  });
}

// One file of the pack. It must be listed in pack.json (nothing else in the folder can be fetched).
function packFile_(email, body) {
  const deviceId = String(body.deviceId || "").trim().slice(0, 80);
  const name = String(body.file || "").trim();
  if (!deviceId || !name) return jsonResponse({ ok: false, message: "Missing deviceId or file." });
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!packEntitled_(ss, email, deviceId)) return jsonResponse({ ok: false, message: "This account does not have the Thumbnail Pack." });
    const idx = packIndex_();
    let listed = false;
    for (let i = 0; i < idx.items.length; i++) if (String(idx.items[i].file) === name) { listed = true; break; }
    if (!listed) return jsonResponse({ ok: false, message: "Not a pack file." });
    const files = idx.folder.getFilesByName(name);
    if (!files.hasNext()) return jsonResponse({ ok: false, message: "File missing in the pack folder." });
    const bytes = files.next().getBlob().getBytes();
    if (bytes.length > 25 * 1024 * 1024) return jsonResponse({ ok: false, message: "File too large." });
    return jsonResponse({ ok: true, file: name, size: bytes.length, data: Utilities.base64Encode(bytes) });
  } catch (err) {
    return jsonResponse({ ok: false, message: "Pack is not available: " + err.message });
  }
}

// OPTIONAL: Triggers (clock icon) > Add trigger > cleanupRenderLog > Time-driven > Month timer.
// Deletes rows of past months so the RenderLog sheet stays small.
function cleanupRenderLog() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("RenderLog");
  if (!sh) return;
  const month = renderMonth_(), rows = sh.getDataRange().getValues();
  for (let i = rows.length - 1; i >= 1; i--) if (String(rows[i][0]) !== month) sh.deleteRow(i + 1);
}

// SELF-CHECK: run it from the function dropdown, then open View > Logs. It prints NO secret - only whether each
// property is present and a short fingerprint you can compare with the app's own (see Tools\LICENSE-RSA-README.txt).
function diagnoseKeys() {
  const props = PropertiesService.getScriptProperties();
  const fp = function (text) {
    return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text)
      .map(function (b) { return (b < 0 ? b + 256 : b).toString(16).padStart(2, "0"); }).join("").slice(0, 8);
  };
  const admin = cleanProp_(props.getProperty("ADMIN_KEY"));
  const privRaw = props.getProperty("LICENSE_PRIVATE_KEY") || "";
  const hmacRaw = props.getProperty("HMAC_SECRET") || "", hmac = cleanProp_(hmacRaw);

  Logger.log("ADMIN_KEY: " + (admin ? "set (" + admin.length + " characters)" : "MISSING - admin actions are refused"));

  if (!privRaw) {
    Logger.log("LICENSE_PRIVATE_KEY: MISSING - no RSA signature is sent (apps with the public key will treat everybody as free)");
  } else if (/PUBLIC KEY/.test(privRaw)) {
    Logger.log("LICENSE_PRIVATE_KEY: this is the PUBLIC key. Paste the contents of license-PRIVATE-key.pem instead.");
  } else {
    const pem = normalizePem_(privRaw);
    Logger.log("LICENSE_PRIVATE_KEY: set, " + privRaw.length + " characters, " + (privRaw.split("\n").length) + " line(s)." + (pem ? "" : " It does not look like a private key (too short?)."));
    if (pem) {
      try { signRsa_("selftest"); Logger.log("LICENSE_PRIVATE_KEY: signing works."); }
      catch (err) { Logger.log("LICENSE_PRIVATE_KEY: signing FAILED - " + err.message + ". Paste the WHOLE contents of license-private-key.pem."); }
    }
  }

  if (!hmac) {
    Logger.log("HMAC_SECRET: MISSING - apps without the public key will refuse every licence answer");
  } else if (!/^[0-9a-fA-F]{64}$/.test(hmac)) {
    Logger.log("HMAC_SECRET: WRONG FORMAT. It must be exactly 64 characters, only 0-9 and a-f (copy it from App\\license.js, line 22, the text between the quotes). Yours has " + hmac.length + " characters"
      + (/BEGIN|PRIVATE|PUBLIC/.test(hmac) || hmac.length > 200 ? " and looks like a KEY file was pasted here by mistake." : "."));
  } else {
    Logger.log("HMAC_SECRET: set, " + hmac.length + " characters after removing stray quotes/spaces (should be 64), fingerprint " + fp(hmac)
      + (hmac !== hmacRaw ? ". Note: the stored value had extra quotes or spaces; they are ignored, but you can re-enter it cleanly." : ""));
  }
  Logger.log("Compare the HMAC_SECRET fingerprint with the app's (command in Tools\\LICENSE-RSA-README.txt). They must be the same.");

  try {
    const idx = packIndex_();
    Logger.log("PACK_FOLDER_ID: ok, pack.json version " + idx.version + " lists " + idx.items.length + " file(s).");
  } catch (err) {
    Logger.log("PACK_FOLDER_ID: " + err.message + " (needed only for the Thumbnail Pack content - see Tools\\PACK-README.txt)");
  }
}

// TEMPORARY - run once from the function dropdown (Run) to force the "Authorization required" prompt for
// UrlFetchApp. It WILL throw after you approve - expected. Safe to delete afterwards.
function testAuth() {
  UrlFetchApp.fetch("https://oauth2.googleapis.com/tokeninfo?id_token=test");
}
