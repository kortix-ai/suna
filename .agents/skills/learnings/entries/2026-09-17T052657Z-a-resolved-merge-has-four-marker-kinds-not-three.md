---
recorded: 2026-09-17T05:26:57Z
incident_date: 2026-09-17
commit: e6adb2d2b6
---
# A resolved merge has four marker kinds, not three

**Incident (main core lane red 2026-09-17 00:29–~01:10Z):** the #7321 merge
`549ea2ac01` resolved a conflict in this file by deleting the `<<<<<<<`,
`=======` and `>>>>>>>` lines and left the diff3 base line
`
