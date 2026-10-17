# ANAFI SDK build notes for this Pi 4B

Recorded 17 October 2026 on aarch64 Debian 13 Trixie, Pi 4 Model B Rev 1.5, approximately 4 GB RAM. These are machine-specific integration notes, not a general compatibility certification. Consult `PI_OBSERVER_CONTEXT.md` for the grounded receiver checks and `VERIFIED.md` for separate team service checks.

## Source and runtime

The source is the official Parrot Olympe 8.5.0 release archive:

- [Official archive](https://github.com/Parrot-Developers/olympe/releases/download/v8.5.0/parrot-olympe-src-8.5.0.tar.gz)
- SHA-256: `4bff18eb6c7fc162661d4b8bdf7032923b6cdc08d35055b9b24d684e060e7585`
- Extracted at `/home/pet/emberwatch/sdk/olympe-8.5.0`.
- The original product configuration selects Python 3.9.5. The local `products/olympe/product_config.json` selects 3.11.16, provided by the archive's pyenv definitions and within its advertised Python 3.11 support. The system Python 3.13 remains separate.
- The original product configuration is retained as `product_config.emberwatch-original.json`. The original global configuration is retained beside `products/olympe/linux/config/global.config`.

Native prerequisites follow Parrot's [source-build instructions](https://developer.parrot.com/docs/olympe/installation_procedures/installation_build_from_source.html). On this newer distribution, `libncurses-dev` replaces the unavailable development package name `libncurses5-dev`. The archive supplies its ARM libclang binary; a complete LLVM build was unnecessary.

## Build driver and configuration

Alchemy initially rejected the ARM configuration as out of date. Running `./build.sh -p olympe-linux -A config-update` generated the native configuration successfully.

The host's Python 3.13 lacks `distutils`, used by the SDK's vendored packaging module. After the isolated Python build completes, the build driver must also run under that 3.11 runtime. PyYAML 6.0.3 was installed there for the driver's documentation extension.

The current wrapper at `/home/pet/emberwatch/scripts/build-sdk.sh` sets the isolated runtime's library path and runs:

```sh
runtime=/home/pet/emberwatch/sdk/olympe-8.5.0/out/olympe-linux/pyenv_root/versions/3.11.16
export LD_LIBRARY_PATH="$runtime/lib:${LD_LIBRARY_PATH:-}"
export MAKE_OPTS=-j4
export MAKEFLAGS=-j4
"$runtime/bin/python3.11" build/dragon_build/build.py -p olympe-linux -t build -j4
```

Run from the SDK root. Four jobs were selected after checking RAM, temperature and voltage/thermal throttling. The build service requests a memory limit, but the Pi kernel lacks the memory cgroup controller; observed memory headroom, rather than that setting, was checked. The service is a user service and is not enabled to rebuild automatically at boot.

## Bundled compiler compatibility

The provided ARM libclang loads as **11.0.1** and requires `libtinfo.so.5`. Debian 13's available library has a different ABI. An actual ABI-5 library was extracted into a user-owned compatibility directory using Debian's official Bookworm package:

- [Debian package archive](https://deb.debian.org/debian/pool/main/n/ncurses/)
- Package: `libtinfo5_6.4-4_arm64.deb`
- SHA-256: `81f30fd9b111ad70c237066580a312fdef9ebb7cb26162ba26b54d1edca766d1`
- The Bookworm `InRelease` signature was checked with the installed Debian archive keyring. The ARM package index hash was checked against that signed release; the package hash and size were checked against the index.
- Extracted under `/home/pet/emberwatch/sdk-compat/ncurses5`. The SDK's `staging-host/usr/lib/libtinfo.so.5` points to that extracted library. System libraries were preserved.
- The actual bundled libclang load test passed afterward. Provenance is recorded in `/home/pet/emberwatch/logs/sdk-tinfo-compat.json`.

The SDK's `packages/ctypeslib/ctypeslib/codegen/cindex.py` parsed the trailing Git commit in libclang's version string as a release number. In its `Config.clang_version` property, immediately after `version = lib.clang_getClangVersion()`, the local correction reads the numeric compiler release first:

```python
numeric_version = re.search(
    r"\b(?:clang|LLVM) version\s+([0-9]+\.[0-9]+(?:\.[0-9]+)?)", version
)
if numeric_version:
    return packaging.version.parse(numeric_version.group(1))
```

The existing fallback remains below this block. Original source and staged copies have `.emberwatch-original` backups. The installed compiler returned `11.0.1` through the corrected function, and logging bindings subsequently generated successfully. All adjustments are recorded in `/home/pet/emberwatch/logs/sdk-source-adjustments.json`.

## Runtime graphics import

The Pi's user session exports Wayland variables. PyOpenGL consequently selected its EGL platform, but Olympe imports GLX renderer functions even when no renderer is requested. Both `finish-sdk-software.sh` and `run-bridge.sh` now export `PYOPENGL_PLATFORM=glx` before entering the SDK environment. No display window or renderer is created. Actual SDK imports then passed.

## Completion and reception results

The wrapper calls `/home/pet/emberwatch/scripts/finish-sdk-software.sh` after a successful native build. It checks Olympe and classic ANAFI message imports, installs the cached OpenCV 5.0.0.93 ARM wheel, runs `bridge/check_environment.py --camera`, and tests I420/NV12-to-JPEG conversion using synthetic pixels. Results go to `software-readiness.json` and `camera-software-test.json` in the Pi logs directory.

No synthetic pixels are posted as live evidence. Require actual aircraft telemetry and decoded frames as separate acceptance checks. An active build process or a configured Wi-Fi connection alone does not establish SDK success.

The native build completed at 15:20 UTC and the corrected software checks passed at 15:23 UTC on 17 October 2026. At 15:25 UTC, the grounded ANAFI Extended delivered telemetry and fully decoded 640 × 360 JPEGs through the Pi to the laptop backend and browser. The bridge registers Olympe 8.5's `StreamInfoDefault` with raw callbacks through `play_multiple_stream`; this handles the classic aircraft's advertised `DefaultVideo` and unnamed decoded-media metadata. The generic `play()` default `Front camera` name failed on this aircraft. The bridge suppresses SDK INFO event logging to avoid logging settings credentials.

The tested aircraft reports firmware 1.8.2 / HW_03. These results establish this grounded reception path only. They do not verify flight, controller coexistence, range, link-loss recovery or compatibility with other firmware and variants.
