"""
AquaNav Cloud Ground Station Server
===================================
Ultra-lightweight Flask backend designed for Render free tier (< 120 MB RAM)
and custom domains (.in, .com, .tech, .me).

Zero heavy ML/CV imports (no torch, ultralytics, cv2, or serial).
All AI object detection runs client-side in the user's browser via TensorFlow.js
and COCO-SSD (lite_mobilenet_v2).
"""

from __future__ import annotations

import collections
import csv
from datetime import datetime, timezone
import io
import logging
import math
import os
from pathlib import Path
import threading
import time
from typing import Any, Dict, Optional

from flask import Flask, Response, jsonify, request, send_from_directory
from flask_cors import CORS

# ------------------------------------------------------------------------------
# LOGGING & PATHS
# ------------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("AquaNav.Cloud")

BASE_DIR = Path(__file__).resolve().parent
WEB_UI_DIR = BASE_DIR / "web_ui"
TEST_SAMPLES_DIR = BASE_DIR / "test_samples"

# ------------------------------------------------------------------------------
# REVIEW GALLERY CATALOG (Matches Clean Marine Sample Assets)
# ------------------------------------------------------------------------------
REVIEW_SAMPLES = [
    {
        "id": "you_le_single_plastic_bottle.jpg",
        "title": "Single Plastic Bottle (you-le)",
        "scenario": "Scenario 1: Angled floating bottle in clear ocean water",
        "badge": "PLASTIC BOTTLE",
        "cat": "A",
        "color": "#FF3B30",
    },
    {
        "id": "pexels_dylannhendricks_dense_bottle_cluster.jpg",
        "title": "Dense Bottle Cluster (dylannhendricks)",
        "scenario": "Scenario 1: Massive floating plastic bottle cluster",
        "badge": "DENSE CLUSTER",
        "cat": "A",
        "color": "#FF3B30",
    },
    {
        "id": "pexels_cagrikanmaz_floating_cups.jpg",
        "title": "Floating Cups & Mucilage (cagrikanmaz)",
        "scenario": "Scenario 1 & 2: White/orange cups & dark surface mucilage",
        "badge": "CUPS & SLICK",
        "cat": "A",
        "color": "#FF3B30",
    },
    {
        "id": "pexels_brotmanphotography_rainbow_sheen.jpg",
        "title": "Rainbow Sheen Oil (brotmanphotography)",
        "scenario": "Scenario 2 (Sig A): Thin iridescent chromatic rainbow sheen",
        "badge": "RAINBOW SHEEN",
        "cat": "B",
        "color": "#AF52DE",
    },
    {
        "id": "pexels_chris_f_emulsified_oil.jpg",
        "title": "Emulsified Cyan Oil (chris-f)",
        "scenario": "Scenario 2 (Sig B): Light-cyan emulsified fluid slick in rocks",
        "badge": "CHEMICAL SLICK",
        "cat": "B",
        "color": "#AF52DE",
    },
    {
        "id": "pexels_tomfisk_swirling_oil_ribbons.jpg",
        "title": "Swirling Tan Oil (tomfisk)",
        "scenario": "Scenario 2 (Sig C): Tan/grey-brown surface ribbons on water",
        "badge": "SURFACE SLICK",
        "cat": "B",
        "color": "#AF52DE",
    },
    {
        "id": "glady_water_algae_scum.jpg",
        "title": "Algal Chemical Scum (glady-water)",
        "scenario": "Scenario 2 (Sig D): Filamentous yellow-green scum bloom",
        "badge": "ALGAE SCUM",
        "cat": "C",
        "color": "#34C759",
    },
]

# ------------------------------------------------------------------------------
# THREAD-SAFE IN-MEMORY STATE (BOUNDED FOR <120MB RAM)
# ------------------------------------------------------------------------------
_state_lock = threading.Lock()
_start_time = time.time()

ESP32_OFFLINE_TIMEOUT_SEC = 8.0
PROXIMITY_HAZARD_CM = 25.0
MAX_FRAME_BYTES = 2 * 1024 * 1024  # 2 MB cap per JPEG frame

_state: Dict[str, Any] = {
    "current_motor_state": "S",
    "siren_active": False,
    "autonomous_mode": False,
    "last_esp32_telemetry_at": 0.0,
    "esp32_telemetry": {
        "distance_cm": 120.0,
        "water_leak": False,
        "lat": 12.9716,
        "lon": 77.5946,
        "battery_v": 12.2,
    },
    "failsafe_active": False,
    "failsafe_reason": "",
    "last_sim_log_at": 0.0,
}

_telemetry_history: collections.deque = collections.deque(maxlen=2000)
_latest_frame_bytes: Optional[bytes] = None
_latest_frame_ts: float = 0.0

# ------------------------------------------------------------------------------
# FLASK APP & CROSS-DOMAIN CORS
# ------------------------------------------------------------------------------
app = Flask(__name__, static_folder=str(WEB_UI_DIR))
CORS(app, resources={r"/api/*": {"origins": "*"}})


@app.after_request
def add_cors_and_pna_headers(response: Response) -> Response:
    """Allow cross-domain API & asset access from any custom domain (.in, .com, .tech, .me)."""
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-Requested-With"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response


def _generate_simulated_telemetry(now: float) -> Dict[str, Any]:
    """Produces smooth realistic marine sensor readings when no ESP32 is online."""
    t = now - _start_time
    dist = 102.0 + 28.0 * math.sin(t * 0.45) + 6.0 * math.cos(t * 1.1)
    lat = 12.971600 + 0.00012 * math.sin(t * 0.08)
    lon = 77.594600 + 0.00012 * math.cos(t * 0.08)
    battery = 12.25 - 0.05 * ((t % 600.0) / 600.0)
    return {
        "distance_cm": round(dist, 1),
        "water_leak": False,
        "lat": round(lat, 6),
        "lon": round(lon, 6),
        "battery_v": round(battery, 2),
    }


def _evaluate_failsafe(distance_cm: float, water_leak: bool) -> tuple[bool, str]:
    """Checks hardware safety bounds for water leak or close obstacle."""
    if water_leak:
        return True, "HULL WATER LEAK DETECTED! Motors halted & siren armed."
    if 2.0 < distance_cm < PROXIMITY_HAZARD_CM:
        return True, f"Bow ultrasonic obstacle at {distance_cm:.1f} cm (< {PROXIMITY_HAZARD_CM:.0f} cm)."
    return False, ""


# ------------------------------------------------------------------------------
# STATIC DASHBOARD ROUTES
# ------------------------------------------------------------------------------
@app.route("/", methods=["GET"])
def index():
    """Serves the AquaNav Ground Station dashboard."""
    return send_from_directory(str(WEB_UI_DIR), "index.html")


@app.route("/health", methods=["GET"])
def health():
    """Health check endpoint for Render / load balancers."""
    return jsonify({"status": "ok"}), 200


@app.route("/<path:filename>", methods=["GET"])
def serve_static_asset(filename: str):
    """Serves CSS, JS, and static web assets from web_ui/."""
    return send_from_directory(str(WEB_UI_DIR), filename)


# ------------------------------------------------------------------------------
# TELEMETRY & COMMAND ROUTES (ESP32-S3 <-> CLOUD <-> WEB DASHBOARD)
# ------------------------------------------------------------------------------
@app.route("/api/telemetry", methods=["GET", "POST", "OPTIONS"])
def handle_telemetry():
    """
    POST: Receives JSON telemetry from ESP32-S3 and returns steering commands in 1 round-trip.
    GET : Returns latest live ESP32 telemetry (or simulated fallback when offline).
    """
    if request.method == "OPTIONS":
        return jsonify({"status": "ok"}), 200

    now = time.time()

    if request.method == "POST":
        data = request.get_json(force=True, silent=True) or {}

        with _state_lock:
            prev = _state["esp32_telemetry"]
            try:
                distance_cm = float(data.get("distance_cm", prev["distance_cm"]))
            except (TypeError, ValueError):
                distance_cm = float(prev["distance_cm"])

            water_leak = bool(data.get("water_leak", False))

            try:
                lat = float(data.get("lat", prev["lat"]))
            except (TypeError, ValueError):
                lat = float(prev["lat"])

            try:
                lon = float(data.get("lon", prev["lon"]))
            except (TypeError, ValueError):
                lon = float(prev["lon"])

            try:
                battery_v = float(data.get("battery_v", prev["battery_v"]))
            except (TypeError, ValueError):
                battery_v = float(prev["battery_v"])

            _state["esp32_telemetry"] = {
                "distance_cm": round(distance_cm, 2),
                "water_leak": water_leak,
                "lat": round(lat, 6),
                "lon": round(lon, 6),
                "battery_v": round(battery_v, 2),
            }
            _state["last_esp32_telemetry_at"] = now

            failsafe_active, failsafe_reason = _evaluate_failsafe(distance_cm, water_leak)
            _state["failsafe_active"] = failsafe_active
            _state["failsafe_reason"] = failsafe_reason

            if water_leak:
                _state["current_motor_state"] = "S"
                _state["siren_active"] = True
            elif failsafe_active and _state["current_motor_state"] == "F":
                _state["current_motor_state"] = "S"

            _telemetry_history.append({
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "source": "esp32",
                "distance_cm": _state["esp32_telemetry"]["distance_cm"],
                "water_leak": water_leak,
                "lat": _state["esp32_telemetry"]["lat"],
                "lon": _state["esp32_telemetry"]["lon"],
                "battery_v": _state["esp32_telemetry"]["battery_v"],
                "command": _state["current_motor_state"],
                "siren": _state["siren_active"],
                "auto": _state["autonomous_mode"],
            })

            return jsonify({
                "command": _state["current_motor_state"],
                "siren": _state["siren_active"],
                "auto": _state["autonomous_mode"],
            }), 200

    # GET /api/telemetry
    with _state_lock:
        esp32_online = (now - _state["last_esp32_telemetry_at"]) < ESP32_OFFLINE_TIMEOUT_SEC
        if esp32_online:
            tele = dict(_state["esp32_telemetry"])
            failsafe_active = _state["failsafe_active"]
            failsafe_reason = _state["failsafe_reason"]
        else:
            tele = _generate_simulated_telemetry(now)
            failsafe_active, failsafe_reason = _evaluate_failsafe(
                tele["distance_cm"], tele["water_leak"]
            )
            if now - _state["last_sim_log_at"] >= 1.0:
                _state["last_sim_log_at"] = now
                _telemetry_history.append({
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "source": "simulated",
                    "distance_cm": tele["distance_cm"],
                    "water_leak": tele["water_leak"],
                    "lat": tele["lat"],
                    "lon": tele["lon"],
                    "battery_v": tele["battery_v"],
                    "command": _state["current_motor_state"],
                    "siren": _state["siren_active"],
                    "auto": _state["autonomous_mode"],
                })

        frame_available = _latest_frame_bytes is not None
        frame_age_ms = round((now - _latest_frame_ts) * 1000.0, 1) if frame_available else None

        payload = {
            "status": "ok",
            "esp32_online": esp32_online,
            "simulated": not esp32_online,
            "distance_cm": tele["distance_cm"],
            "water_leak": tele["water_leak"],
            "lat": tele["lat"],
            "lon": tele["lon"],
            "battery_v": tele["battery_v"],
            "command": _state["current_motor_state"],
            "last_command": _state["current_motor_state"],
            "siren": _state["siren_active"],
            "auto": _state["autonomous_mode"],
            "autonomous_mode": _state["autonomous_mode"],
            "failsafe_active": failsafe_active,
            "failsafe_reason": failsafe_reason,
            "record_count": len(_telemetry_history),
            "frame_available": frame_available,
            "frame_age_ms": frame_age_ms,
            "timestamp": now,
        }
    return jsonify(payload), 200


@app.route("/api/command", methods=["POST", "OPTIONS"])
def handle_command():
    """Updates navigation state (F, B, L, R, S, siren, autonomous mode) from web dashboard."""
    if request.method == "OPTIONS":
        return jsonify({"status": "ok"}), 200

    data = request.get_json(force=True, silent=True) or {}
    raw_cmd = data.get("cmd") if "cmd" in data else data.get("command")

    with _state_lock:
        if raw_cmd is not None:
            cmd = str(raw_cmd).strip().upper()
            if cmd in {"F", "B", "L", "R", "S"}:
                _state["current_motor_state"] = cmd
            elif cmd in {"A", "SIREN_ON"}:
                _state["siren_active"] = True
            elif cmd in {"C", "SIREN_OFF"}:
                _state["siren_active"] = False
            elif cmd == "SIREN_TOGGLE":
                _state["siren_active"] = not _state["siren_active"]

        if "siren" in data:
            _state["siren_active"] = bool(data["siren"])

        if "auto" in data:
            _state["autonomous_mode"] = bool(data["auto"])
        elif "autonomous" in data:
            _state["autonomous_mode"] = bool(data["autonomous"])

        resp = {
            "status": "ok",
            "command": _state["current_motor_state"],
            "siren": _state["siren_active"],
            "auto": _state["autonomous_mode"],
        }
    return jsonify(resp), 200


# ------------------------------------------------------------------------------
# ESP32-S3-CAM IN-MEMORY JPEG FRAME RELAY
# ------------------------------------------------------------------------------
@app.route("/api/esp32/frame", methods=["POST", "OPTIONS"])
def upload_esp32_frame():
    """Receives a JPEG frame uploaded by the ESP32-S3-CAM and buffers it in RAM."""
    global _latest_frame_bytes, _latest_frame_ts

    if request.method == "OPTIONS":
        return jsonify({"status": "ok"}), 200

    frame_bytes = b""
    if "frame" in request.files or "image" in request.files:
        file_obj = request.files.get("frame") or request.files.get("image")
        if file_obj:
            frame_bytes = file_obj.read(MAX_FRAME_BYTES + 1)
    else:
        frame_bytes = request.get_data(cache=False)

    if not frame_bytes:
        return jsonify({"status": "error", "message": "Empty frame payload"}), 400
    if len(frame_bytes) > MAX_FRAME_BYTES:
        return jsonify({"status": "error", "message": "Frame exceeds 2MB limit"}), 413
    if not frame_bytes.startswith(b"\xff\xd8"):
        return jsonify({"status": "error", "message": "Invalid JPEG payload"}), 400

    with _state_lock:
        _latest_frame_bytes = frame_bytes
        _latest_frame_ts = time.time()

    return jsonify({"status": "ok", "bytes": len(frame_bytes)}), 200


@app.route("/api/esp32/latest.jpg", methods=["GET", "OPTIONS"])
def get_latest_esp32_frame():
    """Serves the latest buffered ESP32-S3 JPEG frame with Cache-Control: no-store."""
    if request.method == "OPTIONS":
        return Response(status=204)

    with _state_lock:
        frame_bytes = _latest_frame_bytes
        frame_ts = _latest_frame_ts

    if not frame_bytes:
        resp = Response(status=204)
        resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["X-ESP32-Frame"] = "none"
        return resp

    age_ms = round((time.time() - frame_ts) * 1000.0, 1)
    resp = Response(frame_bytes, status=200, mimetype="image/jpeg")
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    resp.headers["Expires"] = "0"
    resp.headers["X-ESP32-Frame"] = "live"
    resp.headers["X-Frame-Age-Ms"] = str(age_ms)
    return resp


# ------------------------------------------------------------------------------
# REVIEW GALLERY & CSV EXPORT ROUTES
# ------------------------------------------------------------------------------
@app.route("/api/samples", methods=["GET"])
def get_review_samples():
    """Returns catalog of marine contamination review gallery scenarios."""
    return jsonify({
        "status": "ok",
        "samples": REVIEW_SAMPLES,
        "count": len(REVIEW_SAMPLES),
    }), 200


@app.route("/api/samples/<filename>", methods=["GET"])
def serve_sample_image(filename: str):
    """Serves static marine review gallery images from test_samples/."""
    safe_name = Path(filename).name
    return send_from_directory(str(TEST_SAMPLES_DIR), safe_name)


@app.route("/api/export", methods=["GET", "POST", "OPTIONS"])
def export_telemetry_csv():
    """Exports buffered session telemetry logs as a downloadable CSV file."""
    if request.method == "OPTIONS":
        return jsonify({"status": "ok"}), 200

    with _state_lock:
        rows = list(_telemetry_history)

    output = io.StringIO()
    fieldnames = [
        "timestamp",
        "source",
        "distance_cm",
        "water_leak",
        "lat",
        "lon",
        "battery_v",
        "command",
        "siren",
        "auto",
    ]
    writer = csv.DictWriter(output, fieldnames=fieldnames)
    writer.writeheader()
    for row in rows:
        writer.writerow(row)

    csv_data = output.getvalue()
    filename = f"aquanav_telemetry_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}.csv"
    resp = Response(csv_data, status=200, mimetype="text/csv")
    resp.headers["Content-Disposition"] = f'attachment; filename="{filename}"'
    resp.headers["X-Record-Count"] = str(len(rows))
    return resp


# ------------------------------------------------------------------------------
# ENTRYPOINT (Local Development & Gunicorn)
# ------------------------------------------------------------------------------
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    logger.info(f"Starting AquaNav Cloud Ground Station on 0.0.0.0:{port}")
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)

