#!/bin/bash
# Start one foreground, dashboard-disarmed QR + person-search receiver on this provisioned Pi.
set -eu
root=/home/pet/emberwatch/qr-dive
if ps -C python,python3,python3.11 -o args= | grep -qE '(qr_dive_response|anafi_bridge|fire_response|qr_auto_circle|qr_preset_demo|qr_takeoff_demo|hover_checkout)\.py'; then
    printf 'Another flight receiver is active. Stop it in its owner terminal and confirm landing first.\n' >&2
    exit 73
fi
if [ -n "${1:-}" ]; then
    sudo -n /usr/local/sbin/emberwatch-maintenance set-clock "$1" >/dev/null
fi
if [ "$(nmcli -g GENERAL.CONNECTION device show wlan0)" != 'ANAFI-H084882' ]; then
    sudo -n /usr/local/sbin/emberwatch-maintenance wifi-profile 64e43de0-e0ff-4ee0-a9cb-5d5cd824d732
fi
python3 - <<'PY'
import json
from pathlib import Path
from urllib.request import urlopen
with urlopen('http://192.168.42.1/api/v1/info/properties',timeout=5) as response:
    properties={item['key']:item['value'] for item in json.load(response)}
if properties.get('autopilot.flying.state')!='landed':
    raise SystemExit('Receiver handover requires the aircraft confirmed landed.')
target=Path('/home/pet/emberwatch/qr-dive/camera.local.json')
if not target.exists():
    for source in [Path('/home/pet/emberwatch/qr-demo/camera.local.json'),Path('/home/pet/emberwatch/mac-max/camera.local.json')]:
        if source.exists():target.write_bytes(source.read_bytes());target.chmod(0o600);break
calibration=json.loads(target.read_text())
if calibration.get('qr_pose_verified') is not True:raise SystemExit('Physically verified camera calibration is required.')
PY
systemctl --user stop emberwatch-bridge.service
if ps -C python,python3,python3.11 -o args= | grep -qE '(anafi_observer|anafi_bridge|fire_response|qr_dive_response)\.py'; then
    printf 'An aircraft receiver still owns the link; setup stopped.\n' >&2
    exit 73
fi
set -a
. /home/pet/emberwatch/bridge.env
set +a
cd "$root"
export PYOPENGL_PLATFORM=glx
exec /bin/bash /home/pet/emberwatch/sdk/olympe-8.5.0/products/olympe/linux/env/setenv \
    python -u "$root/qr_dive_response.py" --controller direct --ip 192.168.42.1 \
    --drone-id ANAFI-H084882 --backend http://127.0.0.1:8788 --camera-calibration camera.local.json \
    --out-dir "$root/anafi_out" --video-fps 30 --video-width 0 --no-window --no-person --no-yolo
