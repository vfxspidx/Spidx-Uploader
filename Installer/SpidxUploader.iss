; ============================================================================
;  Spidx Uploader — Inno Setup installer
;
;  Build:  install Inno Setup 6 (https://jrsoftware.org/isdl.php), then
;          right-click this file > Compile, or run:
;              "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" SpidxUploader.iss
;          The output lands in Installer\Output\SpidxUploaderSetup.exe
;
;  Expected layout when compiling (this file lives in Installer\):
;      Spidx Uploader\
;          App\                      (helper + engine)
;          UXP\<UxpCcxFile>          (Photoshop panel, PACKAGED -- the raw
;                                     UXP source is NOT shipped, only this
;                                     one .ccx file. See the note at the
;                                     bottom of this file for how to
;                                     produce it with UDT)
;          CEP-AE\                   (After Effects panel)
;          CEP-PPRO\                 (Premiere Pro panel)
;          VEGAS-Plugin\             (VEGAS Pro plugin: C# source + installer
;                                     scripts; built on the user's machine)
;          Spidx Uploader.vbs
;          README.txt
;          Installer\SpidxUploader.iss   <- this file
;
;  Installs per-user into %LOCALAPPDATA%\Programs — deliberately NOT
;  Program Files: the helper writes its own config, logs, queue, browser
;  profile and the incoming folder next to itself, and Program Files
;  would need elevation for every one of those writes.
; ============================================================================

#define AppName        "Spidx Uploader"
#define AppVersion     "2.7.2"
#define AppPublisher   "Spidx"
#define AppExeVbs      "Spidx Uploader.vbs"
#define CepExtIdAE     "com.spidx.uploader.ae"
#define CepExtIdPPro   "com.spidx.uploader.ppro"
; The packaged Photoshop plugin file, as produced by UDT's Package step.
; Ships as Spidx Uploader\UXP\<this file> -- see [Files] below.
#define UxpCcxFile     "com.spidx.workupload_PS.ccx"
; Must match the "id" field inside that .ccx's manifest.json exactly --
; UPIA's /remove command (used on uninstall) identifies the plugin by
; this id, not by file path. Confirmed from the manifest: com.spidx.workupload
#define UxpPluginId    "com.spidx.workupload"

[Setup]
AppId={{9F1C4E61-2B4A-4F4E-9E29-2C0E1C7B5A31}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=Output
OutputBaseFilename=SpidxUploaderSetup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\App\tray-icon.ico
SetupIconFile=..\App\tray-icon.ico
CloseApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "polish";  MessagesFile: "compiler:Languages\Polish.isl"

[Tasks]
Name: "desktopicon";  Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "autostart";    Description: "Start Spidx Uploader when I sign in to Windows"
Name: "aepanel";      Description: "Install the After Effects panel (close After Effects first)"
Name: "pprpanel";     Description: "Install the Premiere Pro panel (close Premiere Pro first)"
Name: "vegaspanel";   Description: "Install the VEGAS Pro plugin (close VEGAS first; it is built for your VEGAS version)"; Flags: unchecked
Name: "pspanel";      Description: "Install the Photoshop panel (requires Creative Cloud desktop app, close Photoshop first)"
Name: "launchafter";  Description: "Start Spidx Uploader when setup finishes"; Flags: unchecked

[Files]
; ---- helper / engine ----
Source: "..\App\*";    DestDir: "{app}\App";    Flags: ignoreversion recursesubdirs createallsubdirs; \
    Excludes: "node_modules\*,incoming\*,browser-profile\*,helper.log,helper-events.jsonl,queue.json,helper-state.json,license-cache.json,google-token.json,last-upload.json,device-id.json,.pending-license-code,.tray.pid,diagnostics\*,update-cache.json,plugin-updates-cache.json"
; ---- Photoshop (UXP) panel: ONLY the packaged .ccx ships -- the raw UXP
; source folder is intentionally left out of the installer entirely.
Source: "..\UXP\{#UxpCcxFile}"; DestDir: "{app}\UXP"; Flags: ignoreversion skipifsourcedoesntexist; Tasks: pspanel
; ---- After Effects (CEP) panel: kept in {app} for reference ... ----
Source: "..\CEP-AE\*"; DestDir: "{app}\CEP-AE"; Flags: ignoreversion recursesubdirs createallsubdirs
; ---- ... and installed straight into the CEP extensions folder ----
Source: "..\CEP-AE\CSXS\*";   DestDir: "{userappdata}\Adobe\CEP\extensions\{#CepExtIdAE}\CSXS";   Flags: ignoreversion recursesubdirs createallsubdirs; Tasks: aepanel
Source: "..\CEP-AE\client\*"; DestDir: "{userappdata}\Adobe\CEP\extensions\{#CepExtIdAE}\client"; Flags: ignoreversion recursesubdirs createallsubdirs; Tasks: aepanel
Source: "..\CEP-AE\host\*";   DestDir: "{userappdata}\Adobe\CEP\extensions\{#CepExtIdAE}\host";   Flags: ignoreversion recursesubdirs createallsubdirs; Tasks: aepanel
Source: "..\CEP-AE\icons\*";  DestDir: "{userappdata}\Adobe\CEP\extensions\{#CepExtIdAE}\icons";  Flags: ignoreversion recursesubdirs createallsubdirs; Tasks: aepanel
; ---- Premiere Pro (CEP) panel: same pattern as the AE panel above ----
Source: "..\CEP-PPRO\*";          DestDir: "{app}\CEP-PPRO"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\CEP-PPRO\CSXS\*";     DestDir: "{userappdata}\Adobe\CEP\extensions\{#CepExtIdPPro}\CSXS";     Flags: ignoreversion recursesubdirs createallsubdirs; Tasks: pprpanel
Source: "..\CEP-PPRO\client\*";   DestDir: "{userappdata}\Adobe\CEP\extensions\{#CepExtIdPPro}\client";   Flags: ignoreversion recursesubdirs createallsubdirs; Tasks: pprpanel
Source: "..\CEP-PPRO\host\*";     DestDir: "{userappdata}\Adobe\CEP\extensions\{#CepExtIdPPro}\host";     Flags: ignoreversion recursesubdirs createallsubdirs; Tasks: pprpanel
Source: "..\CEP-PPRO\icons\*";    DestDir: "{userappdata}\Adobe\CEP\extensions\{#CepExtIdPPro}\icons";    Flags: ignoreversion recursesubdirs createallsubdirs; Tasks: pprpanel
Source: "..\CEP-PPRO\presets\*";  DestDir: "{userappdata}\Adobe\CEP\extensions\{#CepExtIdPPro}\presets";  Flags: ignoreversion recursesubdirs createallsubdirs skipifsourcedoesntexist; Tasks: pprpanel
; ---- VEGAS Pro plugin: the C# source + install scripts ship in {app}; the
; "vegaspanel" task below (or the wizard / Dashboard) builds and installs the
; .dll against whatever VEGAS the user has, so there is no prebuilt binary. ----
Source: "..\VEGAS-Plugin\*"; DestDir: "{app}\VEGAS-Plugin"; Flags: ignoreversion recursesubdirs createallsubdirs
; ---- launchers + docs ----
Source: "..\{#AppExeVbs}";                DestDir: "{app}"; Flags: ignoreversion
Source: "..\Install Desktop Shortcut.vbs"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist
Source: "..\README.txt";                   DestDir: "{app}"; Flags: ignoreversion isreadme skipifsourcedoesntexist

[Dirs]
; The helper watches this; all three panels export into it. Created up
; front so the first-run wizard can show a path that already exists. If
; the user picks a different folder on the "Incoming folder" wizard page,
; CurStepChanged below creates that one too and this default is simply
; left empty on disk.
Name: "{app}\App\incoming"

[Registry]
; Unsigned CEP panels only load with PlayerDebugMode on. Per-user key, no
; elevation, and CSXS versions are enumerated because which one After
; Effects/Premiere Pro reads depends on its release. One shared set of
; keys covers both panels — PlayerDebugMode isn't per-extension. (The
; Photoshop panel doesn't need this: it's UXP, installed as a proper
; signed-format .ccx via UPIA below, not sideloaded like CEP.)
Root: HKCU; Subkey: "Software\Adobe\CSXS.8";  ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: uninsdeletevalue; Tasks: aepanel or pprpanel
Root: HKCU; Subkey: "Software\Adobe\CSXS.9";  ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: uninsdeletevalue; Tasks: aepanel or pprpanel
Root: HKCU; Subkey: "Software\Adobe\CSXS.10"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: uninsdeletevalue; Tasks: aepanel or pprpanel
Root: HKCU; Subkey: "Software\Adobe\CSXS.11"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: uninsdeletevalue; Tasks: aepanel or pprpanel
Root: HKCU; Subkey: "Software\Adobe\CSXS.12"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: uninsdeletevalue; Tasks: aepanel or pprpanel
Root: HKCU; Subkey: "Software\Adobe\CSXS.13"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: uninsdeletevalue; Tasks: aepanel or pprpanel

; "spidx://" deep link — lets the Discord bot's "Activate" button open this
; app directly with a license code pre-filled (see App\protocol-handler.js
; for what handles it). HKCU only: no elevation needed, matches
; PrivilegesRequired=lowest above, and it's a per-user association anyway.
; (App\protocol-register.js re-writes the same keys on every tray start, so
; a moved/copied install heals itself too.)
Root: HKCU; Subkey: "Software\Classes\spidx";                     ValueType: string; ValueName: "";              ValueData: "URL:Spidx Uploader Protocol"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\spidx";                     ValueType: string; ValueName: "URL Protocol";  ValueData: ""
Root: HKCU; Subkey: "Software\Classes\spidx\DefaultIcon";         ValueType: string; ValueName: "";              ValueData: "{app}\App\tray-icon.ico"
Root: HKCU; Subkey: "Software\Classes\spidx\shell\open\command"; ValueType: string; ValueName: "";              ValueData: """{app}\App\protocol-handler.bat"" ""%1"""

[Icons]
Name: "{group}\{#AppName}";             Filename: "{app}\{#AppExeVbs}"; IconFilename: "{app}\App\tray-icon.ico"
Name: "{group}\Spidx incoming folder";  Filename: "{code:GetIncomingFolder}"
Name: "{group}\Uninstall {#AppName}";   Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}";       Filename: "{app}\{#AppExeVbs}"; IconFilename: "{app}\App\tray-icon.ico"; Tasks: desktopicon
Name: "{userstartup}\{#AppName}";       Filename: "{app}\{#AppExeVbs}"; IconFilename: "{app}\App\tray-icon.ico"; Tasks: autostart

[Run]
; Install the Photoshop panel via Adobe's own silent installer (UPIA).
; Runs before start-tray.bat so the panel is already in place the first
; time the user opens Photoshop after setup.
Filename: "{code:GetUPIAPath}"; Parameters: "/install ""{app}\UXP\{#UxpCcxFile}"""; \
    StatusMsg: "Installing Photoshop panel..."; Flags: runhidden skipifdoesntexist; Tasks: pspanel

; Build + install the VEGAS Pro plugin (the .bat asks for admin rights itself and
; shows its own console so errors are visible).
Filename: "{app}\VEGAS-Plugin\Install VEGAS Plugin.bat"; WorkingDir: "{app}\VEGAS-Plugin"; \
    StatusMsg: "Installing the VEGAS Pro plugin..."; Flags: shellexec waituntilterminated skipifdoesntexist; Tasks: vegaspanel

; First launch runs the visible batch once: it installs the npm
; dependencies (playwright, sharp, systray) and then hands over to the
; tray app, which opens the first-run wizard in the browser.
Filename: "{app}\App\start-tray.bat"; WorkingDir: "{app}\App"; \
    Description: "Finish setup (installs dependencies, then opens the wizard)"; \
    Flags: postinstall shellexec skipifsilent; Tasks: launchafter

[UninstallRun]
; Mirror image of the [Run] entry above -- removes the Photoshop panel
; through UPIA. Uses the plugin id from manifest.json, not a file path.
Filename: "{code:GetUPIAPath}"; Parameters: "/remove {#UxpPluginId}"; \
    Flags: runhidden skipifdoesntexist; RunOnceId: "RemoveUxpPlugin"

; Remove the VEGAS plugin .dll too (no-op when it was never installed).
Filename: "{app}\VEGAS-Plugin\Uninstall VEGAS Plugin.bat"; Parameters: "/silent"; WorkingDir: "{app}\VEGAS-Plugin"; \
    Flags: shellexec runhidden skipifdoesntexist; RunOnceId: "RemoveVegasPlugin"

[UninstallDelete]
; Runtime files the installer never shipped, so Inno wouldn't remove them.
Type: filesandordirs; Name: "{app}\App\node_modules"
Type: filesandordirs; Name: "{app}\App\browser-profile"
Type: filesandordirs; Name: "{app}\App\diagnostics"
Type: files;          Name: "{app}\App\plugin-updates-cache.json"
Type: files;          Name: "{app}\App\update-cache.json"
Type: filesandordirs; Name: "{userappdata}\Adobe\CEP\extensions\{#CepExtIdAE}"
Type: filesandordirs; Name: "{userappdata}\Adobe\CEP\extensions\{#CepExtIdPPro}"
Type: files;          Name: "{app}\App\helper.log"
Type: files;          Name: "{app}\App\helper-events.jsonl"
Type: files;          Name: "{app}\App\queue.json"
Type: files;          Name: "{app}\App\helper-state.json"
Type: files;          Name: "{app}\App\.pending-license-code"
Type: files;          Name: "{app}\App\.tray.pid"

[Code]
var
  IncomingPage: TInputDirWizardPage;

// --------------------------------------------------------------------------
//  Incoming-folder picker
//
//  Adds one page to the wizard, right after task selection, so the user
//  can choose where AE/Premiere/Photoshop export frames into instead of
//  always getting {app}\App\incoming. The choice is written to
//  App\install-config.json -- a small "seed" file, deliberately NOT the
//  helper's real config.json. That way:
//    - a first install picks it up and uses it to create config.json
//    - a reinstall/update never clobbers a path the user already changed
//      later from the dashboard's own "Change incoming folder" button
//  On the helper side, this only needs one small addition: on startup,
//  if config.json doesn't exist yet but install-config.json does, read
//  incomingFolder from install-config.json to seed the real config, then
//  you can delete or ignore install-config.json afterwards.
// --------------------------------------------------------------------------
procedure InitializeWizard;
begin
  IncomingPage := CreateInputDirPage(wpSelectTasks,
    'Incoming folder', 'Where should exported frames go?',
    'After Effects, Premiere Pro and Photoshop will export into this folder, and ' +
    'Spidx Uploader watches it for new files. You can change this later from the ' +
    'dashboard at any time.',
    False, '');
  IncomingPage.Add('');
  // NOT ExpandConstant('{app}...') here -- {app} isn't resolved yet this
  // early (InitializeWizard runs before the "Select Destination Location"
  // page), so expanding it here always throws "An attempt was made to
  // expand the 'app' constant before it was initialized." Left blank; the
  // real default gets filled in by CurPageChanged below, once {app} is
  // actually known (i.e. once this page is about to be shown, which is
  // always after the user has gone past the directory-selection page).
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = IncomingPage.ID) and (IncomingPage.Values[0] = '') then
    IncomingPage.Values[0] := ExpandConstant('{app}\App\incoming');
end;

function GetIncomingFolder(Param: String): String;
begin
  if (IncomingPage <> nil) and (IncomingPage.Values[0] <> '') then
    Result := IncomingPage.Values[0]
  else
    Result := ExpandConstant('{app}\App\incoming');
end;

// --------------------------------------------------------------------------
//  Close a running copy before overwriting its files (update support).
//
//  This is a pure Node app with no bundled .exe, so Windows won't lock
//  App\*.js the way it would a loaded .exe/.dll — files copy over a
//  running process just fine. The problem is what happens AFTER: Node
//  already has the old code loaded in memory, so the running tray/server
//  processes keep executing the OLD version until someone manually quits
//  and reopens the app. That defeats the point of an auto-update.
//
//  tray.js writes its own PID to App\.tray.pid on every startup (see its
//  checkSingleInstance()). A real Win32 AppMutex would be the usual Inno
//  mechanism here, but creating one needs native code that a plain Node
//  app doesn't have — this PID file + taskkill does the same job for a
//  Node app specifically, and doubles as the single-instance guard that
//  stops a double-launch from opening two tray icons.
//
//  The /FI filter makes taskkill touch the PID ONLY if it really is a node.exe:
//  a stale PID file can name a recycled PID that now belongs to something else.
//
//  /T also kills the child server.js (spawned by tray.js) in the same
//  tree. Silently does nothing if the file's missing or the PID is
//  already dead (ResultCode is ignored on purpose) — a fresh install,
//  or the app just not running, are both completely normal.
// --------------------------------------------------------------------------
procedure CloseRunningCopy();
var
  PidPath, PidText: String;
  Pid, ResultCode: Integer;
begin
  PidPath := ExpandConstant('{app}\App\.tray.pid');
  if not FileExists(PidPath) then
    Exit;

  if not LoadStringFromFile(PidPath, PidText) then
    Exit;

  Pid := StrToIntDef(Trim(PidText), 0);
  if Pid <= 0 then
    Exit;

  Exec(ExpandConstant('{sys}\taskkill.exe'), '/FI "IMAGENAME eq node.exe" /PID ' + IntToStr(Pid) + ' /T /F',
       '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

  // Give Windows a moment to actually release everything before Files copy.
  Sleep(500);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  IncomingPath, SeedPath, JsonText, EscapedPath: String;
begin
  if CurStep = ssInstall then
    CloseRunningCopy();

  if CurStep = ssPostInstall then
  begin
    IncomingPath := GetIncomingFolder('');
    ForceDirectories(IncomingPath);

    SeedPath := ExpandConstant('{app}\App\install-config.json');
    EscapedPath := IncomingPath;
    StringChangeEx(EscapedPath, '\', '\\', True);
    JsonText := '{' + #13#10 +
                '  "incomingFolder": "' + EscapedPath + '"' + #13#10 +
                '}';
    SaveStringToFile(SeedPath, JsonText, False);
  end;
end;

// --------------------------------------------------------------------------
//  Node.js check. The helper is a Node app; without Node nothing runs, and
//  the old failure mode was a console window flashing an error the user
//  never got to read. Offer the download instead, but let them continue —
//  start-tray.bat can still install Node itself from a bundled
//  node-installer.msi if one was shipped alongside.
// --------------------------------------------------------------------------
function NodeInstalled(): Boolean;
begin
  Result := FileExists(ExpandConstant('{commonpf}\nodejs\node.exe'))
         or FileExists(ExpandConstant('{commonpf32}\nodejs\node.exe'))
         or FileExists(ExpandConstant('{localappdata}\Programs\nodejs\node.exe'));
end;

// --------------------------------------------------------------------------
//  UPIA (Unified Plugin Installer Agent) location. Ships as part of the
//  Creative Cloud desktop app, not as something this installer bundles.
//  Checked at both possible Common Files locations because Adobe's own
//  components are still 32-bit there on some machines even though
//  Photoshop itself is 64-bit.
// --------------------------------------------------------------------------
function GetUPIAPath(Param: String): String;
var
  P: String;
begin
  P := ExpandConstant('{commoncf64}\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe');
  if not FileExists(P) then
    P := ExpandConstant('{commoncf32}\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe');
  Result := P;
end;

function UPIAInstalled(): Boolean;
begin
  Result := FileExists(GetUPIAPath(''));
end;

function InitializeSetup(): Boolean;
var
  ErrorCode: Integer;
begin
  Result := True;
  if NodeInstalled() then
    Exit;

  if FileExists(ExpandConstant('{src}\App\node-installer.msi')) then
    Exit; // bundled installer present — start-tray.bat handles it

  if MsgBox('Node.js was not found on this computer.' + #13#10#13#10 +
            'Spidx Uploader needs it to run. Open the Node.js download page now?' + #13#10 +
            '(You can continue the installation either way and install Node.js afterwards.)',
            mbConfirmation, MB_YESNO) = IDYES then
    ShellExec('open', 'https://nodejs.org/en/download', '', '', SW_SHOW, ewNoWait, ErrorCode);
end;

// Warn up front if "Install the Photoshop panel" is ticked but UPIA isn't
// present, instead of letting [Run] fail silently (Flags: skipifdoesntexist
// just skips it with no explanation). Checked on the tasks-selection page.
function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = wpSelectTasks) and WizardIsTaskSelected('pspanel') and not UPIAInstalled() then
  begin
    if MsgBox('The Photoshop panel installs through Adobe''s own plugin installer (UPIA), ' +
              'which is part of the Creative Cloud desktop app -- and it wasn''t found on ' +
              'this computer.' + #13#10#13#10 +
              'Continue anyway? The Photoshop panel step will just be skipped; you can ' +
              'install it later once Creative Cloud desktop is installed by running this ' +
              'setup again.', mbConfirmation, MB_YESNO) = IDNO then
      Result := False;
  end;
end;

// After Effects / Premiere Pro both hold their CEP extensions open; copying
// over a running instance produces a half-updated panel that silently
// fails to load. Photoshop's UXP install via UPIA is more tolerant, but we
// still ask for it closed since it needs a restart to pick up the panel
// either way.
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if WizardIsTaskSelected('aepanel') and (FindWindowByClassName('AE_CApplication_Class') <> 0) then
  begin
    Result := 'After Effects is running. Close it and click Retry, or go back and untick the After Effects panel task.';
    Exit;
  end;
  if WizardIsTaskSelected('pprpanel') and (FindWindowByClassName('Premiere Pro') <> 0) then
  begin
    Result := 'Premiere Pro is running. Close it and click Retry, or go back and untick the Premiere Pro panel task.';
    Exit;
  end;
  if WizardIsTaskSelected('pspanel') and (FindWindowByClassName('Photoshop') <> 0) then
    Result := 'Photoshop is running. Close it and click Retry, or go back and untick the Photoshop panel task.';
end;

// ============================================================================
//  ONE-TIME step, done by YOU when building a release, not by the installer.
//  The installer never sees your UXP source -- only the packaged .ccx:
//
//  1. Open the UXP Developer Tool (UDT), "Add Plugin", point it at your
//     UXP project's manifest.json (wherever that lives on your machine --
//     it does NOT need to be under Spidx Uploader\ at all).
//  2. Open its ••• menu -> Package. UDT writes a .ccx file.
//  3. Copy/rename that file to Spidx Uploader\UXP\<UxpCcxFile> -- the
//     #define near the top of this file currently expects the filename
//     "com.spidx.workupload_PS.ccx" (that's what UDT already produced for
//     this project). If UDT names it differently, either rename the file
//     to match, or update #define UxpCcxFile to match the file.
//  4. Confirm the "id" inside that .ccx's manifest.json still matches
//     #define UxpPluginId above (currently "com.spidx.workupload") --
//     that's what /remove uses on uninstall, not the filename.
//
//  Re-package and drop in a fresh .ccx every time the plugin changes;
//  ISCC.exe only packages what's already sitting in the Spidx Uploader\
//  folder, it doesn't build the .ccx for you.
// ============================================================================
