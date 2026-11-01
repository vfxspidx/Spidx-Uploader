Thumbnail Pack content - how it is delivered (3.0)
===================================================

What it is
----------
The ready-made After Effects templates (.aep), animation presets (.ffx) and Premiere Pro MOGRT templates are NOT in
the installer, the panels or the repository. They live in a PRIVATE Google Drive folder. The licence server hands
them to an account only if the sheet says it has the Pack (role "spt", or a dev / tester rank) AND the request comes
from one of that account's registered computers. The helper downloads them into
    %APPDATA%\Spidx Uploader\pack\
and the panels read them there. If the account loses the Pack, the next sync deletes them again (the user's OWN
templates, added in Dashboard > Templates, are never touched). Every file is checked against a sha256 in a signed
manifest before it is written, and only the three allowed sub-folders can be written to.

Honest limit: a paying customer's computer holds plain files, so a determined customer can still copy them. What
this stops is the content being freely downloadable from the public installer or the GitHub release.

One-time setup
--------------
1. Make a Drive folder (for example "Spidx Pack") in the Google account that OWNS the licence script.
   Keep it PRIVATE: do not share it and do not turn on "anyone with the link". The script reads it as its owner.
2. Put your content into  Tools\pack-source  (it is already filled with the current files):
       ae\templates\*.aep + templates.json      ae\presets\*.ffx + spt.json      ppro\mogrts\*.mogrt + mogrts.json + thumbs\*
   Tools\pack-source and Tools\pack-upload are the paid content: they are in .gitignore and are not in the installer.
3. Run   node Tools\make-pack-manifest.js
   It writes Tools\pack-upload: every file under a unique flat name, plus pack.json (file list, sizes, sha256).
4. Upload EVERYTHING in Tools\pack-upload to the Drive folder.
5. In the Apps Script: Project Settings > Script properties > add  PACK_FOLDER_ID  = the folder's id
   (the last part of its URL).  Deploy a new version of the script.  Run  diagnoseKeys  and read View > Logs:
   it must say "PACK_FOLDER_ID: ok, pack.json version 1 lists N file(s)".
6. On a computer whose account has the Pack: start the helper. App\helper.log shows
   "Thumbnail Pack: version 1, N file(s) downloaded". Dashboard > Templates shows the content.

Updating the content
--------------------
Change the files in Tools\pack-source, raise the number in Tools\pack-source\pack-version.txt, run the tool again
and replace the files in the Drive folder (pack.json last). Every helper picks the change up within 6 hours, or at
once with Dashboard > Templates > Sync now.

Adding a text template for After Effects: put the .aep in pack-source\ae\templates and add a line to
pack-source\ae\templates\templates.json  { "file", "comp", "name", "textLayer" }.
Adding a MOGRT: put it in pack-source\ppro\mogrts and run  Tools\pack-source\ppro\Update MOGRT list.bat  (it reads the
preview out of the file and updates mogrts.json), then run the manifest tool.
