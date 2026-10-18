Task / owner: Windows duplicate detector recovery / Codex

Branch / commit: existing dirty `codex/qr-dive-combined` on a8b9737; prior edits preserved.

Changed files and behavior: `fire_monitor.py` now opens the singleton lock
without truncation, acquires the OS lock before writing the initial byte,
and reports duplicate/unwritable lock errors without a raw traceback.
The laptop deliverable launcher verifies the combined backend before starting
inference and reuses an existing detector from the same checkout instead of
starting a second one. An explicitly invoked manual reset helper is provided
in outputs; it checks BOSCO is OFF and targets only the local backend on 8787
and this project's QR detector processes, with no Pi or flight commands.

Checks run: 17 fire-monitor tests passed, including a real separate-process
Windows byte-lock collision and successful acquisition after the owner exits.
PowerShell source parsing passed. The default parallel Node run passed 222/223,
with the existing real-clock fleet replay timing assertion failing under load.
The complete Node suite passed 223/223 with `--test-concurrency=1`.

Hardware/cloud evidence: no aircraft/Pi actions. Read-only local status showed
BOSCO disabled, no receiver, and an old backend lacking `/api/dive` (404).
Two QR detector processes were running (old and combined checkouts).

Open issue / next step: automatic approval review rejected stopping/restarting
the local processes with “blocked by policy.” No process was stopped or started
by that rejected call. The user must perform the manual local recovery and
restart the prepared dashboard/detector before receiver setup. The reset helper
was syntax-checked, not executed.
