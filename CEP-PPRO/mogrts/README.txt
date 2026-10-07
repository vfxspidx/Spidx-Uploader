Three templates ship here already:
    IGN.mogrt         -> "Eliminated (Bold)"   - "ELIMINATED [nick]", bold red
    IGN_Clean.mogrt    -> "Eliminated (Clean)"  - same, muted gray/red
    190_Damage.mogrt   -> "Damage Counter"      - damage number popup

mogrts.json in this folder controls what the MOGRT tab shows - "file"
must be the exact filename sitting in this folder, "name" and
"description" are just display text, shown as-is in the panel.

To add a 4th (or replace one): drop the .mogrt file in this folder and
add/edit an entry in mogrts.json. Nothing else in the panel needs to
change - the tab reads this list fresh every time it's opened.

How to export a new .mogrt from Premiere Pro:
  1. Build the graphic as a Graphics/Essential Graphics layer on a
     sequence.
  2. Right-click the clip on the timeline -> Export as Motion Graphics
     Template...
  3. Destination: Local Templates Folder (the exact export location
     doesn't matter - copy the exported file into this mogrts/ folder
     afterward).
  4. Add an entry for it in mogrts.json.
