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
