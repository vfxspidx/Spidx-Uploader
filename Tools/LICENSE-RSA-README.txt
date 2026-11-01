Real license signatures (RSA) - how to switch, in this order
============================================================

Why: today the licence response is signed with a shared secret (HMAC) that is
written inside App\license.js - anyone who reads the file can sign "pro+spt" for
themselves. With RSA the server signs with a PRIVATE key that only the Apps Script
has; the app holds only the PUBLIC key, which can verify but never sign.

1. Generate the pair (on your computer):  Tools\Generate License Keys.bat
   -> Tools\keys\license-private-key.pem   (secret)
   -> Tools\keys\license-public-key.pem    (public)
   Never commit or zip the keys\ folder (it is in .gitignore).

2. Apps Script (the licence server) - FIRST, before the app asks for RSA:
   - Project Settings > Script properties > add  LICENSE_PRIVATE_KEY  =  the full
     contents of license-private-key.pem (including the BEGIN/END lines).
   - Add this helper and put its two results in the JSON you already return:

       function signLicense_(email, tier, timestamp, expiresAt) {
         // the signed text MUST be exactly: email|tier|timestamp|expiresAt
         // (use the same strings you put into the response; expiresAt = "" if you send none)
         var payload = [email, tier, String(timestamp), String(expiresAt)].join('|');
         var key = PropertiesService.getScriptProperties().getProperty('LICENSE_PRIVATE_KEY');
         return Utilities.base64Encode(Utilities.computeRsaSha256Signature(payload, key));
       }

       // where you build the response (keep your existing "signature" while you transition):
       var expiresAt = Date.now() + 7 * 24 * 3600 * 1000;       // optional: licence proof valid 7 days
       response.expiresAt = String(expiresAt);
       response.sig2 = signLicense_(email, tier, response.timestamp, response.expiresAt);

   - "tier" is the same string you already sign (e.g. "pro", "spt", "pro+spt").
   - Deploy a NEW VERSION of the web app.

3. Check it works while the app still accepts the old signature: run the app, open
   App\helper.log - it logs "[legacy signature]". Nothing is enforced yet.

4. Ship the PUBLIC key: copy Tools\keys\license-public-key.pem to
   App\license-public-key.pem (it is included in the installer).
   From then on the app REQUIRES RSA: log says "[rsa signature]", and a legacy-only or
   forged response is refused (the user falls back to free).

5. Rotate: because the old HMAC secret was in the app, treat it as public. After step 4
   you can stop sending "signature" from the server and delete LICENSE_SECRET (v3.0).

Rolling back: delete App\license-public-key.pem and the app accepts the legacy
signature again.


Complete licence server (3.0)
=============================
Tools\licence-server-Code.gs is the WHOLE Apps Script (it replaces Code.gs) and contains no secret:
  - RSA signature (sig2) AND a second RSA signature bound to the computer (sig3), valid 14 days offline
  - the free plan's monthly video renders, counted on the server (account AND computer)
  - the admin / shop actions (codes, refund, restore, bulk)
Script properties it reads:  ADMIN_KEY, LICENSE_PRIVATE_KEY, HMAC_SECRET (temporary, same value as LICENSE_SECRET in
App\license.js; delete it once every user has the app that ships the public key).
ORDER:  1) generate keys  2) set the properties  3) paste Code.gs and deploy a new version  4) copy
Tools\keys\license-public-key.pem to App\license-public-key.pem and ship the app. Never the other way round:
an app that has the public key REQUIRES sig2 and sig3 and treats everybody as free until the server sends them.

Checking that the server and the app agree
==========================================
Server: in Apps Script run diagnoseKeys (function dropdown > Run), then View > Logs. It prints no secret.
App (the fingerprint of LICENSE_SECRET, to compare with the server's HMAC_SECRET fingerprint):
  node -e "const s=require('fs').readFileSync('App/license.js','utf8').match(/LICENSE_SECRET = \"(.*?)\"/)[1];console.log(require('crypto').createHash('sha256').update(s).digest('hex').slice(0,8))"
In App\helper.log the check now says WHY it failed, e.g. "(the HMAC_SECRET property is missing on the server)".
