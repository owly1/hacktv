# Provisioned Pi SDK build notes

Recorded 17 October 2026: Pi 4B Rev 1.5, aarch64 Debian 13, about 4 GB RAM.
These explain the existing deployment; they are not a universal install guide.

## Source and runtime

| Item | Recorded value |
|---|---|
| Olympe | Official 8.5.0 source release |
| Archive SHA-256 | `4bff18eb6c7fc162661d4b8bdf7032923b6cdc08d35055b9b24d684e060e7585` |
| Root | `/home/pet/emberwatch/sdk/olympe-8.5.0` |
| Isolated Python | 3.11.16, selected in `products/olympe/product_config.json` |
| Build helper | `/home/pet/emberwatch/scripts/build-sdk.sh` |

System Python 3.13 is unchanged. Original product/global config files have
adjacent backups. Native ARM configuration required
`./build.sh -p olympe-linux -A config-update`. Use `libncurses-dev` on this
distribution. The build driver uses the isolated Python (vendored packaging
needs `distutils`) with PyYAML 6.0.3 for its documentation extension.

From the SDK root, the existing helper runs:

```sh
runtime=/home/pet/emberwatch/sdk/olympe-8.5.0/out/olympe-linux/pyenv_root/versions/3.11.16
export LD_LIBRARY_PATH="$runtime/lib:${LD_LIBRARY_PATH:-}"
export MAKE_OPTS=-j4
export MAKEFLAGS=-j4
"$runtime/bin/python3.11" build/dragon_build/build.py -p olympe-linux -t build -j4
```

Four jobs were checked against actual memory/temperature headroom. The kernel
lacks the memory cgroup controller; a service's memory limit was not proof
of enforcement. The user build service is not enabled at boot.

## Compatibility fixes

1. Bundled ARM libclang 11.0.1 requires ABI-5 `libtinfo.so.5`. The signed
   Debian Bookworm `libtinfo5_6.4-4_arm64.deb` was verified and extracted under
   `/home/pet/emberwatch/sdk-compat/ncurses5`; staging points there without
   replacing system libraries. Package SHA-256:
   `81f30fd9b111ad70c237066580a312fdef9ebb7cb26162ba26b54d1edca766d1`.
2. In `packages/ctypeslib/ctypeslib/codegen/cindex.py`, `Config.clang_version`
   parses the numeric `clang|LLVM version` first rather than the trailing Git
   hash. Existing fallback remains; source/staged originals are backed up.
3. Set `PYOPENGL_PLATFORM=glx` before SDK import: the Wayland session selected
   EGL while Olympe imports GLX symbols even with no renderer window.

Provenance: Pi logs `sdk-tinfo-compat.json` and `sdk-source-adjustments.json`.
`finish-sdk-software.sh` checks imports and synthetic I420/NV12-to-JPEG
conversion; it does not post synthetic pixels as live evidence.

Build/import checks passed around 15:20–15:23 UTC; grounded reception followed
at 15:25 UTC. See [observer context](PI_OBSERVER_CONTEXT.md). These checks do
not establish flight or compatibility with another aircraft/firmware.

References: [Olympe source release](https://github.com/Parrot-Developers/olympe/releases/download/v8.5.0/parrot-olympe-src-8.5.0.tar.gz),
[source build](https://developer.parrot.com/docs/olympe/installation_procedures/installation_build_from_source.html),
[Debian package archive](https://deb.debian.org/debian/pool/main/n/ncurses/).
