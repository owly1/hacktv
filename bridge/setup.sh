#!/usr/bin/env bash
# One-time bridge setup on Ubuntu/WSL. Needs internet, so run it before
# switching to the drone's Wi-Fi:  bash bridge/setup.sh
set -euo pipefail
VENV="${VENV:-$HOME/anafi-env}"
MODEL_DIR="$HOME/emberwatch-models"
HERE="$(cd "$(dirname "$0")" && pwd)"

[ -d "$VENV" ] || python3 -m venv "$VENV"
source "$VENV/bin/activate"
pip install -q --upgrade pip
# CPU-only PyTorch keeps the install ~1 GB instead of ~5 GB of CUDA libraries.
pip install -q torch torchvision --index-url https://download.pytorch.org/whl/cpu
pip install -q -r "$HERE/requirements.txt"

# YOLOv8n fire/smoke detector fine-tuned on D-Fire (classes: smoke, fire).
mkdir -p "$MODEL_DIR"
[ -s "$MODEL_DIR/fire-smoke-yolov8n.pt" ] || curl -fsSL -o "$MODEL_DIR/fire-smoke-yolov8n.pt" \
  https://huggingface.co/rabahdev/fire-smoke-yolov8n/resolve/main/best.pt
python -c "from ultralytics import YOLO; print('fire model classes:', YOLO('$MODEL_DIR/fire-smoke-yolov8n.pt').names)"

# COCO YOLOv8n for the person search (class "person"). Visible-light; use a
# thermal-trained model with --person-model for a thermal stream.
[ -s "$MODEL_DIR/yolov8n.pt" ] || curl -fsSL -o "$MODEL_DIR/yolov8n.pt" \
  https://github.com/ultralytics/assets/releases/download/v8.2.0/yolov8n.pt

python "$HERE/make_test_marker.py"
echo "Bridge ready. Models: $MODEL_DIR/fire-smoke-yolov8n.pt, $MODEL_DIR/yolov8n.pt"
