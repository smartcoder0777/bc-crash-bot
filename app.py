"""Flask + Socket.IO dashboard server for BC Crash bot."""

from __future__ import annotations

import json
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory
from flask_socketio import SocketIO

from bot import CrashBot
from strategy import StrategyConfig, StrategyEngine

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "config.json"

app = Flask(__name__, static_folder="static", static_url_path="/static")
app.config["SECRET_KEY"] = "bc-bot-local"
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet")


def load_config() -> dict:
    with CONFIG_PATH.open(encoding="utf-8") as f:
        return json.load(f)


def save_config(data: dict) -> None:
    with CONFIG_PATH.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


full_config = load_config()
engine = StrategyEngine(StrategyConfig.from_dict(full_config))


def emit_status(s: dict | None = None) -> None:
    data = s or bot.status()
    data["config"] = {
        **engine.config.to_dict(),
        "site_url": full_config.get("site_url", ""),
        "headless": full_config.get("headless", False),
    }
    socketio.emit("status", data)


bot = CrashBot(engine, full_config, on_status=lambda s: emit_status(s))


@app.get("/")
def index():
    return send_from_directory(ROOT / "static", "index.html")


@app.get("/api/status")
def api_status():
    data = bot.status()
    data["config"] = {
        **engine.config.to_dict(),
        "site_url": full_config.get("site_url", ""),
        "headless": full_config.get("headless", False),
    }
    return jsonify(data)


@app.get("/api/config")
def api_get_config():
    return jsonify(
        {
            **engine.config.to_dict(),
            "site_url": full_config.get("site_url", ""),
            "headless": full_config.get("headless", False),
        }
    )


@app.post("/api/config")
def api_set_config():
    global full_config
    data = request.get_json(force=True) or {}
    # Keep non-strategy keys (selectors, url, headless)
    strategy_keys = set(StrategyConfig().to_dict().keys())
    for k, v in data.items():
        if k in strategy_keys:
            try:
                data[k] = float(v) if k not in {
                    "losses_before_rest",
                    "rest_rounds",
                    "recovery_attempts",
                } else int(float(v))
            except (TypeError, ValueError):
                return jsonify({"ok": False, "error": f"Invalid value for {k}"}), 400

    merged = {**full_config, **{k: data[k] for k in data if k in strategy_keys or k in full_config}}
    # Also allow updating site_url / headless from dashboard if sent
    for extra in ("site_url", "headless"):
        if extra in data:
            merged[extra] = data[extra]

    engine.update_config(merged)
    bot.config = merged
    full_config = merged
    save_config(merged)
    emit_status()
    return jsonify({"ok": True, "config": {
        **engine.config.to_dict(),
        "site_url": full_config.get("site_url", ""),
    }})


@app.post("/api/start")
def api_start():
    bot.start()
    return jsonify({"ok": True, "message": "Bot starting — browser will open"})


@app.post("/api/stop")
def api_stop():
    bot.stop()
    return jsonify({"ok": True})


@app.post("/api/reset")
def api_reset():
    engine.reset()
    emit_status()
    return jsonify({"ok": True, "status": bot.status()})


@socketio.on("connect")
def on_connect():
    emit_status()


@socketio.on("request_status")
def on_request_status():
    emit_status()


if __name__ == "__main__":
    print("Dashboard: http://127.0.0.1:5050")
    socketio.run(app, host="127.0.0.1", port=5050, debug=False)
