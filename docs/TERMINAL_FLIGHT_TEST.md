# Short hover and terminal landing

Direct route: aircraft Wi-Fi → Pi → Ethernet/tunnel → laptop; controller off.
Use a grounded aircraft, one SDK owner, clear flight/landing space, backend
running, and ≥40% battery. Keep the operator terminal focused and open.

## Reception first

```powershell
.\scripts\Start-HoverCheckout.ps1
```

Wait for `READY: reception only` and check real camera/telemetry with Replay
off. There is no flight driver; `TAKEOFF TEST` cannot launch. Test X input,
then Ctrl+C to stop. Mac: `.venv/bin/python scripts/mac.py pi --mode hover`.

## One flight attempt

```powershell
.\scripts\Start-HoverCheckout.ps1 -Execute
```

Mac: `.venv/bin/python scripts/mac.py pi --mode hover --execute`.

1. Wait for `READY: type TAKEOFF TEST`; type that phrase + Enter once.
2. The firmware controls takeoff to about 1 m; no horizontal move is requested.
3. Press **X** airborne to test controlled landing. Esc also needs no Enter;
   `LAND` + Enter, Ctrl+C and terminal closure request landing too.
4. Without input, the hover ends after at most three seconds. The takeoff
   watchdog is ten seconds. Confirm physical touchdown, stopped motors and
   `aircraft confirmed landed`; an unconfirmed result is an error.

Project guards: height ≤1.5 m, horizontal speed ≤0.3 m/s, sensor ages ≤1 s,
video age ≤1.5 s; starting requires landed, near-zero height/speed. Ground/
motor-start tilt limit is 20°; hover/flight limit is 10°. These are software
checks, not manufacturer capability claims. Radio/process loss can block landing.

A prior short hover/automatic landing was reported at about 0.96 m. Terminal
X landing still requires recorded physical evidence. Tests never replace it.
Each process permits one takeoff; it cannot leave a hover running for a second
SDK process to take over. Use [integrated QR checkout](QR_FLIGHT_CHECKOUT.md)
for takeoff and orbit on one connection.

If startup fails, check Ethernet/SSH, grounded aircraft power/charge, saved
Wi-Fi and the Pi tunnel. An unhealthy bound tunnel is not reused. `motor_ramping`
is an accepted startup transition; landing/emergency/unknown states remain aborts.
See [restart guide](RESTART_CURRENT_LAPTOP.md) and [verification](VERIFIED.md).
