"""Start only the workspace-owned portable OBS, with private test credentials."""
from pathlib import Path
import argparse
import json
import secrets
import shutil
import subprocess

root = Path(__file__).resolve().parents[1]
obs = root / "runtime/obs"
binary = obs / "bin/64bit/obs64.exe"
parser = argparse.ArgumentParser()
parser.add_argument("--plugin", type=Path, required=True, help="Verified DLL built from the current source")
plugin = parser.parse_args().plugin.resolve()
assert binary.is_file() and plugin.is_file()
shutil.copyfile(plugin, obs / "obs-plugins/64bit/veil-guard.dll")
config_path = obs / "config/obs-studio/plugin_config/obs-websocket/config.json"
config = json.loads(config_path.read_text(encoding="utf-8"))
config.update(server_password=secrets.token_urlsafe(32), auth_required=True,
              server_enabled=True, server_port=4456, alerts_enabled=False)
config_path.write_text(json.dumps(config), encoding="utf-8")
startup = subprocess.STARTUPINFO()
startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
startup.wShowWindow = 0
process = subprocess.Popen([str(binary), "--portable", "--minimize-to-tray", "--disable-updater"],
                           cwd=binary.parent, startupinfo=startup,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
(root / "runtime/demo").mkdir(exist_ok=True)
(root / "runtime/demo/obs-process.json").write_text(json.dumps({"pid": process.pid}), encoding="utf-8")
