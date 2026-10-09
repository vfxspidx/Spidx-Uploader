Templates for the panel's MOGRT tab. Three ship here already:
    IGN.mogrt         -> "Eliminated (Bold)"   - "ELIMINATED [nick]", bold red
    IGN_Clean.mogrt   -> "Eliminated (Clean)"  - same, muted gray/red
    190_Damage.mogrt  -> "Damage Counter"      - damage number popup

mogrts.json controls what the tab shows: "file" = exact file name in this folder,
"name" / "description" = display text, "category" = the group it appears under,
"thumb" / "preview" = the still picture and animated preview (thumbs\<file>.png / .mp4,
taken from inside the .mogrt by "Update MOGRT list.bat"),
"textParam" = which text field of the template receives the nick: its name exactly as
Essential Graphics shows it (or its position among the text fields, e.g. "2").

To add or replace a template:
  1. Drop the .mogrt file in this folder.
  2. Run "Update MOGRT list.bat" (one folder up). It extracts the preview picture
     and adds an entry to mogrts.json (existing names / categories are kept).
  3. Optionally edit mogrts.json: friendlier "name", a "description", a "category".
  4. Reinstall the panel (Install PPRO Panel.bat, or Dashboard > Plugins).

How to export a new .mogrt from Premiere Pro:
  1. Build the graphic as a Graphics/Essential Graphics layer on a sequence.
  2. Right-click the clip on the timeline -> Export as Motion Graphics Template...
  3. Destination: Local Templates Folder (the location doesn't matter - copy the
     exported file into this mogrts\ folder afterward).
