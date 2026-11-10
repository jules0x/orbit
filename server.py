#!/usr/bin/env python3
"""
DDev & Disk Orbit - Local Web Dashboard Server
Zero-dependency Python 3 HTTP server with JSON API, live scanner, and direct action execution.
"""

import os
import sys
import re
import json
import time
import shutil
import shlex
import subprocess
import urllib.parse
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from threading import Thread

# Import scanner functions
from scanner import full_audit, format_bytes, SITES_DIR, DOWNLOADS_DIR, HOME, COLIMA_DIR

PORT = 7890
DATA_CACHE = None
CACHE_TIME = 0
CACHE_TTL = 300  # 5 minutes
IS_SCANNING = False

def update_scan_cache(force=False):
    global DATA_CACHE, CACHE_TIME, IS_SCANNING
    if IS_SCANNING:
        return
    if not force and DATA_CACHE and (time.time() - CACHE_TIME < CACHE_TTL):
        return
    
    IS_SCANNING = True
    try:
        data = full_audit()
        DATA_CACHE = data
        CACHE_TIME = time.time()
        print(f"[{time.strftime('%H:%M:%S')}] Audit cache updated successfully.", flush=True)
    except Exception as e:
        sys.stderr.write(f"Scan error: {e}\n")
    finally:
        IS_SCANNING = False

def safe_trash_path(target_path):
    if not target_path:
        return False, "Empty path", 0
    exp_path = os.path.expanduser(target_path)
    if not os.path.exists(exp_path):
        return False, f"Path does not exist: {target_path}", 0
    real_path = os.path.realpath(exp_path)
    if not real_path.startswith(HOME) or real_path == HOME:
        return False, "Cannot trash system or root directory", 0
    
    trash_dir = os.path.join(HOME, ".Trash")
    os.makedirs(trash_dir, exist_ok=True)
    basename = os.path.basename(real_path)
    
    size = 0
    try:
        if os.path.isfile(real_path) or os.path.islink(real_path):
            size = os.path.getsize(real_path)
        elif os.path.isdir(real_path):
            for dirpath, _, filenames in os.walk(real_path):
                for f in filenames:
                    fp = os.path.join(dirpath, f)
                    if not os.path.islink(fp):
                        try:
                            size += os.path.getsize(fp)
                        except Exception:
                            pass
    except Exception:
        pass

    dest = os.path.join(trash_dir, basename)
    counter = 1
    name, ext = os.path.splitext(basename)
    while os.path.exists(dest):
        dest = os.path.join(trash_dir, f"{name}_{counter}{ext}")
        counter += 1
    
    try:
        shutil.move(real_path, dest)
        return True, None, size
    except Exception as e:
        return False, str(e), 0

def update_colima_config(cpu=None, memory=None, disk=None):
    colima_dir = os.path.join(HOME, ".colima", "default")
    yaml_file = os.path.join(colima_dir, "colima.yaml")
    if not os.path.isfile(yaml_file):
        return False, f"Colima configuration file not found at {yaml_file}"

    try:
        with open(yaml_file, "r") as f:
            lines = f.readlines()

        new_lines = []
        cpu_updated = False
        memory_updated = False
        disk_updated = False

        for line in lines:
            stripped = line.strip()
            if stripped.startswith("cpu:") and cpu is not None:
                new_lines.append(f"cpu: {int(cpu)}\n")
                cpu_updated = True
            elif stripped.startswith("memory:") and memory is not None:
                new_lines.append(f"memory: {int(memory)}\n")
                memory_updated = True
            elif stripped.startswith("disk:") and disk is not None:
                new_lines.append(f"disk: {int(disk)}\n")
                disk_updated = True
            else:
                new_lines.append(line)

        if cpu is not None and not cpu_updated:
            new_lines.append(f"cpu: {int(cpu)}\n")
        if memory is not None and not memory_updated:
            new_lines.append(f"memory: {int(memory)}\n")
        if disk is not None and not disk_updated:
            new_lines.append(f"disk: {int(disk)}\n")

        with open(yaml_file, "w") as f:
            f.writelines(new_lines)

        return True, None
    except Exception as e:
        return False, str(e)

class OrbitHTTPHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Quiet log
        pass

    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/status":
            self.send_json(200, {
                "is_scanning": IS_SCANNING,
                "has_cache": DATA_CACHE is not None,
                "cache_age_seconds": round(time.time() - CACHE_TIME) if CACHE_TIME else None
            })
            return

        if path == "/api/data":
            if DATA_CACHE is None:
                if not IS_SCANNING:
                    Thread(target=update_scan_cache, args=(False,), daemon=True).start()
                self.send_json(202, {"status": "scanning", "message": "Audit in progress..."})
                return
            self.send_json(200, DATA_CACHE)
            return

        if path == "/api/project_logo":
            params = urllib.parse.parse_qs(parsed.query)
            proj_name = params.get("name", [""])[0]
            if DATA_CACHE and "projects" in DATA_CACHE and proj_name in DATA_CACHE["projects"]:
                pdata = DATA_CACHE["projects"][proj_name]
                branding = pdata.get("branding", {})
                logo_path = branding.get("logo_path")
                if logo_path and os.path.isfile(logo_path):
                    content_type = "image/png"
                    fl = logo_path.lower()
                    if fl.endswith(".svg"):
                        content_type = "image/svg+xml"
                    elif fl.endswith(".ico"):
                        content_type = "image/x-icon"
                    elif fl.endswith(".webp"):
                        content_type = "image/webp"
                    elif fl.endswith((".jpg", ".jpeg")):
                        content_type = "image/jpeg"

                    try:
                        with open(logo_path, "rb") as f:
                            content = f.read()
                        self.send_response(200)
                        self.send_header("Content-Type", content_type)
                        self.send_header("Content-Length", str(len(content)))
                        self.send_header("Cache-Control", "public, max-age=3600")
                        self.end_headers()
                        self.wfile.write(content)
                        return
                    except Exception as e:
                        self.send_error(500, f"Error reading logo: {e}")
                        return

            self.send_error(404, "Logo not found")
            return

        # Static files
        static_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
        req_path = path.lstrip("/")
        if not req_path or req_path == "":
            req_path = "index.html"

        file_path = os.path.join(static_dir, req_path)
        if os.path.isfile(file_path):
            content_type = "text/html"
            if file_path.endswith(".css"):
                content_type = "text/css"
            elif file_path.endswith(".js"):
                content_type = "application/javascript"
            elif file_path.endswith(".json"):
                content_type = "application/json"
            elif file_path.endswith(".svg"):
                content_type = "image/svg+xml"
            elif file_path.endswith(".ico"):
                content_type = "image/x-icon"
            elif file_path.endswith(".png"):
                content_type = "image/png"

            try:
                with open(file_path, "rb") as f:
                    content = f.read()
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(content)))
                if any(file_path.endswith(ext) for ext in [".ico", ".png", ".svg", ".css", ".js"]):
                    self.send_header("Cache-Control", "public, max-age=86400")
                self.end_headers()
                self.wfile.write(content)
            except Exception as e:
                self.send_error(500, f"Error reading file: {e}")
        else:
            self.send_error(404, "File not found")

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        content_len = int(self.headers.get("Content-Length", 0))
        post_body = self.rfile.read(content_len) if content_len > 0 else b"{}"
        try:
            req_json = json.loads(post_body.decode("utf-8")) if post_body else {}
        except Exception:
            req_json = {}

        try:
            self._handle_post(path, req_json)
        except Exception as err:
            import traceback
            traceback.print_exc()
            self.send_json(500, {"success": False, "error": f"Server internal error: {err}"})

    def _handle_post(self, path, req_json):
        if path == "/api/refresh":
            Thread(target=update_scan_cache, args=(True,), daemon=True).start()
            self.send_json(200, {"status": "started", "message": "Refreshing disk audit..."})
            return

        if path == "/api/action/reveal":
            target_path = req_json.get("path")
            if target_path and os.path.exists(os.path.expanduser(target_path)):
                try:
                    exp = os.path.expanduser(target_path)
                    if os.path.isdir(exp):
                        subprocess.run(["open", exp], check=False)
                    else:
                        subprocess.run(["open", "-R", exp], check=False)
                    self.send_json(200, {"success": True, "message": "Revealed in Finder"})
                except Exception as e:
                    self.send_json(500, {"error": str(e)})
            else:
                self.send_json(404, {"error": "Path not found"})
            return

        if path == "/api/action/trash":
            target_path = req_json.get("path")
            ok, err, size = safe_trash_path(target_path)
            if not ok:
                self.send_json(400 if "root" in (err or "") else 404, {"error": err})
                return

            global DATA_CACHE
            if DATA_CACHE:
                DATA_CACHE["db_dumps"]["dumps"] = [d for d in DATA_CACHE["db_dumps"]["dumps"] if d["path"] != target_path]
                DATA_CACHE["giant_files"] = [g for g in DATA_CACHE["giant_files"] if g["path"] != target_path]
                dumps = DATA_CACHE["db_dumps"]["dumps"]
                DATA_CACHE["db_dumps"]["total_dumps"] = len(dumps)
                total_dumps_size = sum(d["size"] for d in dumps)
                DATA_CACHE["db_dumps"]["total_dumps_size"] = total_dumps_size
                DATA_CACHE["db_dumps"]["total_dumps_size_str"] = format_bytes(total_dumps_size)

            self.send_json(200, {
                "success": True,
                "message": f"Moved to Trash ({format_bytes(size)} freed)",
                "size": size,
                "freed_bytes": size,
                "freed_str": format_bytes(size)
            })
            return

        if path == "/api/action/trash_batch":
            paths = req_json.get("paths", [])
            if not isinstance(paths, list) or not paths:
                self.send_json(400, {"error": "No paths provided"})
                return
            
            trashed = []
            failed = []
            total_freed = 0
            for p in paths:
                ok, err, size = safe_trash_path(p)
                if ok:
                    trashed.append(p)
                    total_freed += size
                else:
                    failed.append({"path": p, "error": err})
            
            if DATA_CACHE and trashed:
                trashed_set = set(trashed)
                DATA_CACHE["db_dumps"]["dumps"] = [d for d in DATA_CACHE["db_dumps"]["dumps"] if d["path"] not in trashed_set]
                DATA_CACHE["giant_files"] = [g for g in DATA_CACHE["giant_files"] if g["path"] not in trashed_set]
                dumps = DATA_CACHE["db_dumps"]["dumps"]
                DATA_CACHE["db_dumps"]["total_dumps"] = len(dumps)
                total_dumps_size = sum(d["size"] for d in dumps)
                DATA_CACHE["db_dumps"]["total_dumps_size"] = total_dumps_size
                DATA_CACHE["db_dumps"]["total_dumps_size_str"] = format_bytes(total_dumps_size)

            self.send_json(200, {
                "success": True,
                "count": len(trashed),
                "freed_bytes": total_freed,
                "freed_str": format_bytes(total_freed),
                "trashed": trashed,
                "failed": failed
            })
            return

        if path == "/api/action/exec":
            action = req_json.get("action")
            target = req_json.get("target", "").strip()

            env = dict(os.environ)
            extra_paths = [
                "/opt/homebrew/bin",
                "/usr/local/bin",
                "/usr/bin",
                "/bin",
                os.path.expanduser("~/.local/bin"),
                os.path.expanduser("~/.fnm/current/bin")
            ]
            path_parts = env.get("PATH", "").split(":")
            for ep in reversed(extra_paths):
                if ep not in path_parts and os.path.exists(ep):
                    path_parts.insert(0, ep)
            env["PATH"] = ":".join(path_parts)

            cmd = None
            if action == "colima_fstrim":
                cmd = ["colima", "ssh", "--", "sudo", "fstrim", "-av"]
            elif action == "colima_start":
                cmd = ["colima", "start"]
            elif action == "colima_stop":
                cmd = ["colima", "stop"]
            elif action == "colima_restart":
                cmd = ["colima", "restart"]
            elif action == "colima_set_resources":
                cpu = req_json.get("cpu")
                memory = req_json.get("memory")
                disk = req_json.get("disk")
                restart = req_json.get("restart", False)

                if cpu is not None:
                    try:
                        cpu = max(1, min(32, int(cpu)))
                    except Exception:
                        cpu = None
                if memory is not None:
                    try:
                        memory = max(2, min(64, int(memory)))
                    except Exception:
                        memory = None
                if disk is not None:
                    try:
                        disk = max(30, min(500, int(disk)))
                    except Exception:
                        disk = None

                ok, err = update_colima_config(cpu=cpu, memory=memory, disk=disk)
                if not ok:
                    self.send_json(500, {"error": err})
                    return

                if restart:
                    p_stat = subprocess.run(["colima", "status"], env=env, capture_output=True, text=True)
                    is_running = ("running" in p_stat.stdout.lower() or "running" in p_stat.stderr.lower())
                    restart_cmd = ["colima", "restart"] if is_running else ["colima", "start"]
                    t0 = time.time()
                    proc = subprocess.run(restart_cmd, env=env, capture_output=True, text=True, timeout=180)
                    Thread(target=update_scan_cache, args=(True,), daemon=True).start()
                    self.send_json(200, {
                        "success": proc.returncode == 0,
                        "exit_code": proc.returncode,
                        "stdout": proc.stdout or f"Colima settings applied: {cpu} CPUs, {memory}GB RAM, {disk}GB Disk.",
                        "stderr": proc.stderr,
                        "duration": round(time.time() - t0, 2),
                        "command": " ".join(restart_cmd)
                    })
                    return
                else:
                    Thread(target=update_scan_cache, args=(True,), daemon=True).start()
                    self.send_json(200, {
                        "success": True,
                        "exit_code": 0,
                        "stdout": f"Colima settings saved ({cpu} CPUs, {memory}GB RAM, {disk}GB Disk). They will take effect on next Colima start/restart.",
                        "stderr": "",
                        "duration": 0.1
                    })
                    return
            elif action == "ddev_build_dist":
                if not target or not re.match(r"^[a-zA-Z0-9_\.-]+$", target):
                    self.send_json(400, {"error": "Invalid project name"})
                    return

                proj_data = {}
                if DATA_CACHE and "projects" in DATA_CACHE and target in DATA_CACHE["projects"]:
                    proj_data = DATA_CACHE["projects"][target]

                approot = proj_data.get("approot")
                if not approot or not os.path.isdir(approot):
                    cand = os.path.join(SITES_DIR, target)
                    if os.path.isdir(cand):
                        approot = cand

                if not approot or not os.path.isdir(approot):
                    self.send_json(404, {"error": f"Approot not found for {target}"})
                    return

                build_cmd = req_json.get("build_cmd") or proj_data.get("dist", {}).get("build_cmd")
                if not build_cmd:
                    build_cmd = "make buildall" if os.path.isfile(os.path.join(approot, "Makefile")) else "npm run build"

                t0 = time.time()
                try:
                    proc = subprocess.run(["bash", "-c", build_cmd], cwd=approot, env=env, capture_output=True, text=True, timeout=300)
                    dur = round(time.time() - t0, 2)
                    Thread(target=update_scan_cache, args=(True,), daemon=True).start()
                    self.send_json(200, {
                        "success": proc.returncode == 0,
                        "exit_code": proc.returncode,
                        "stdout": proc.stdout or "Frontend dist build completed successfully.",
                        "stderr": proc.stderr,
                        "duration": dur,
                        "command": f"cd {approot} && {build_cmd}"
                    })
                except subprocess.TimeoutExpired:
                    self.send_json(504, {"error": f"Build timed out after 300s: {build_cmd}"})
                except Exception as e:
                    self.send_json(500, {"error": str(e)})
                return
            elif action in ("ddev_start_everything", "ddev_setup_project"):
                if not target or not re.match(r"^[a-zA-Z0-9_\.-]+$", target):
                    self.send_json(400, {"error": "Invalid project name"})
                    return

                t0 = time.time()
                steps_log = []
                overall_success = True

                # Step 1: Ensure Colima is running
                p_colima_stat = subprocess.run(["colima", "status"], env=env, capture_output=True, text=True)
                colima_running = ("running" in p_colima_stat.stdout.lower() or "running" in p_colima_stat.stderr.lower())
                if not colima_running:
                    steps_log.append("▶ Step 1/4: Starting Colima VM runtime...")
                    c_start = subprocess.run(["colima", "start"], env=env, capture_output=True, text=True, timeout=120)
                    if c_start.returncode != 0:
                        steps_log.append(f"✖ Failed to start Colima:\n{c_start.stderr}")
                        self.send_json(500, {
                            "success": False,
                            "exit_code": c_start.returncode,
                            "stdout": "\n".join(steps_log),
                            "stderr": c_start.stderr,
                            "duration": round(time.time() - t0, 2),
                            "command": "colima start"
                        })
                        return
                    steps_log.append("✔ Colima VM is up and running.")
                else:
                    steps_log.append("✔ Colima VM is already running.")

                # Step 2: DDEV Start (with search profile if configured)
                proj_data = {}
                if DATA_CACHE and "projects" in DATA_CACHE and target in DATA_CACHE["projects"]:
                    proj_data = DATA_CACHE["projects"][target]

                profile = req_json.get("profile", "").strip() or proj_data.get("search", {}).get("profile", "")
                if profile:
                    start_cmd = ["ddev", "start", target, f"--profiles={profile}"]
                    steps_log.append(f"▶ Step 2/4: Starting DDEV project '{target}' with search profile '{profile}'...")
                else:
                    start_cmd = ["ddev", "start", target]
                    steps_log.append(f"▶ Step 2/4: Starting DDEV project '{target}'...")

                ddev_start = subprocess.run(start_cmd, env=env, capture_output=True, text=True, timeout=300)
                if ddev_start.returncode != 0:
                    steps_log.append(f"✖ DDEV start failed:\n{ddev_start.stderr}")
                    overall_success = False
                else:
                    steps_log.append(f"✔ DDEV containers active.")

                # Locate approot
                approot = proj_data.get("approot")
                if not approot or not os.path.isdir(approot):
                    cand = os.path.join(SITES_DIR, target)
                    if os.path.isdir(cand):
                        approot = cand

                # Step 3: Run project setup (dset: composer install && dev/build && vendor-expose)
                if approot and os.path.isdir(approot) and overall_success:
                    steps_log.append("▶ Step 3/4: Running project setup (`dset`: composer install, dev/build, vendor-expose)...")
                    # Try user's interactive zsh alias 'dset' first, falling back to direct ddev exec sequence
                    dset_res = subprocess.run(["zsh", "-i", "-c", f"cd '{approot}' && dset"], env=env, capture_output=True, text=True, timeout=600)
                    if dset_res.returncode != 0:
                        # Fallback to direct ddev exec sequence
                        fallback_cmd = "ddev exec 'composer install' && ddev exec 'vendor/bin/sake dev/build flush=all' && ddev exec 'composer vendor-expose'"
                        dset_res = subprocess.run(["bash", "-c", fallback_cmd], cwd=approot, env=env, capture_output=True, text=True, timeout=600)

                    if dset_res.returncode == 0:
                        steps_log.append("✔ Project setup (`dset`) completed successfully.")
                    else:
                        out_snippet = (dset_res.stderr or dset_res.stdout or "Setup exited with code non-zero").strip()
                        if len(out_snippet) > 800:
                            out_snippet = out_snippet[-800:]
                        steps_log.append(f"⚠ Setup output:\n{out_snippet}")

                # Step 4: Check dist status and build if missing
                dist_info = proj_data.get("dist", {})
                is_built = dist_info.get("is_built", True)
                force_build = req_json.get("force_dist_build", False)

                if approot and (not is_built or force_build):
                    build_cmd = req_json.get("build_cmd") or dist_info.get("build_cmd")
                    if not build_cmd:
                        build_cmd = "make buildall" if os.path.isfile(os.path.join(approot, "Makefile")) else "npm run build"

                    steps_log.append(f"▶ Step 4/4: Building frontend assets ({build_cmd})...")
                    b_proc = subprocess.run(["bash", "-c", build_cmd], cwd=approot, env=env, capture_output=True, text=True, timeout=300)
                    if b_proc.returncode != 0:
                        steps_log.append(f"⚠ Build warning/error:\n{b_proc.stderr or b_proc.stdout}")
                    else:
                        steps_log.append("✔ Frontend dist built successfully.")
                else:
                    steps_log.append("✔ Frontend dist already built and ready.")

                dur = round(time.time() - t0, 2)
                steps_log.append(f"\n✨ Project '{target}' is fully set up and ready! ({dur}s total)")

                Thread(target=update_scan_cache, args=(True,), daemon=True).start()
                self.send_json(200, {
                    "success": overall_success,
                    "exit_code": 0 if overall_success else 1,
                    "stdout": "\n".join(steps_log),
                    "stderr": "",
                    "duration": dur,
                    "command": f"ddev start {target} && dset"
                })
                return
            elif action == "docker_prune_images":
                cmd = ["docker", "image", "prune", "-af"]
            elif action == "docker_prune_dangling_images":
                cmd = ["docker", "image", "prune", "-f"]
            elif action == "docker_rmi":
                if not target or not re.match(r"^[a-zA-Z0-9_\.:/ -]+$", target):
                    self.send_json(400, {"error": "Invalid image name or ID"})
                    return
                cmd = ["docker", "rmi", target]
            elif action == "docker_logs":
                if not target or not re.match(r"^[a-zA-Z0-9_\.-]+$", target):
                    self.send_json(400, {"error": "Invalid container name"})
                    return
                tail = req_json.get("tail", 150)
                try:
                    tail = max(10, min(2000, int(tail)))
                except Exception:
                    tail = 150
                cmd = ["docker", "logs", "--tail", str(tail), target]
            elif action == "open_database":
                if not target or not re.match(r"^[a-zA-Z0-9_\.-]+$", target):
                    self.send_json(400, {"error": "Invalid project name"})
                    return
                approot = req_json.get("approot", "").strip()
                cd_dir = approot if (approot and os.path.isdir(approot)) else os.path.expanduser(f"~/Sites/{target}")

                # Launch Sequel Ace directly in background via ddev sequelace (no terminal window required!)
                try:
                    res = subprocess.run(["ddev", "sequelace"], cwd=cd_dir, env=env, capture_output=True, text=True, timeout=15)
                    if res.returncode == 0:
                        self.send_json(200, {
                            "success": True,
                            "stdout": f"Opened Sequel Ace for {target}",
                            "stderr": ""
                        })
                        return
                except Exception:
                    pass

                # Fallback: run zsh alias headlessly in background
                try:
                    res = subprocess.run(["zsh", "-i", "-c", f"cd {shlex.quote(cd_dir)} && dsa"], env=env, capture_output=True, text=True, timeout=15)
                    self.send_json(200, {
                        "success": res.returncode == 0,
                        "stdout": f"Opened Sequel Ace for {target}",
                        "stderr": res.stderr
                    })
                except Exception as ex:
                    self.send_json(500, {"error": f"Failed to launch Sequel Ace: {str(ex)}"})
                return
            elif action == "launch_terminal":
                command = req_json.get("command", "").strip()
                approot = req_json.get("approot", "").strip()
                cd_dir = approot if (approot and os.path.isdir(approot)) else HOME

                # Check for iTerm availability on macOS
                has_iterm = True
                try:
                    check_iterm = subprocess.run(["osascript", "-e", 'id of application "iTerm"'], capture_output=True, text=True, timeout=2)
                    has_iterm = (check_iterm.returncode == 0)
                except Exception:
                    has_iterm = False

                full_cmd = f"cd {shlex.quote(cd_dir)}"
                if command:
                    full_cmd += f" && {command}"

                escaped_cmd = full_cmd.replace('\\', '\\\\').replace('"', '\\"')

                if has_iterm:
                    osa_script = f'''tell application "iTerm"
    activate
    if (count of windows) = 0 then
        create window with default profile
    else
        tell current window
            create tab with default profile
        end tell
    end if
    tell current session of current window
        write text "{escaped_cmd}"
    end tell
end tell'''
                else:
                    osa_script = f'''tell application "Terminal"
    activate
    do script "{escaped_cmd}"
end tell'''

                try:
                    res = subprocess.run(["osascript", "-e", osa_script], capture_output=True, text=True, timeout=5)
                    self.send_json(200, {
                        "success": res.returncode == 0,
                        "exit_code": res.returncode,
                        "stdout": f"Opened iTerm in {cd_dir}" + (f": {command}" if command else ""),
                        "stderr": res.stderr,
                        "command": command or f"cd {cd_dir}"
                    })
                except Exception as ex:
                    self.send_json(200, {
                        "success": False,
                        "exit_code": 1,
                        "stdout": f"iTerm launch attempted: {command}",
                        "stderr": str(ex),
                        "command": command
                    })
                return
            elif action == "docker_builder_prune":
                cmd = ["docker", "builder", "prune", "-af"]
            elif action == "docker_prune_containers":
                cmd = ["docker", "container", "prune", "-f"]
            elif action == "docker_prune_volumes":
                cmd = ["docker", "volume", "prune", "-f"]
            elif action == "ddev_stop_all":
                cmd = ["ddev", "stop", "--all"]
            elif action == "ddev_logs":
                if not target or not re.match(r"^[a-zA-Z0-9_\.-]+$", target):
                    self.send_json(400, {"error": "Invalid project name"})
                    return
                service = req_json.get("service", "web")
                tail = req_json.get("tail", 150)
                try:
                    tail = max(10, min(2000, int(tail)))
                except Exception:
                    tail = 150
                if service and service != "all":
                    cmd = ["ddev", "logs", "-s", service, "--tail", str(tail), target]
                else:
                    cmd = ["ddev", "logs", "--tail", str(tail), target]
            elif action == "ddev_stop_project":
                if not target or not re.match(r"^[a-zA-Z0-9_\.-]+$", target):
                    self.send_json(400, {"error": "Invalid project name"})
                    return
                cmd = ["ddev", "stop", target]
            elif action in ["ddev_start_project", "ddev_restart_project", "ddev_start_search"]:
                if not target or not re.match(r"^[a-zA-Z0-9_\.-]+$", target):
                    self.send_json(400, {"error": "Invalid project name"})
                    return
                profile = req_json.get("profile", "").strip()
                if profile and not re.match(r"^[a-zA-Z0-9_\.,-]+$", profile):
                    self.send_json(400, {"error": "Invalid profile name"})
                    return
                if action == "ddev_start_project":
                    cmd = ["ddev", "start", target]
                elif action == "ddev_restart_project":
                    cmd = ["ddev", "restart", target]
                elif action == "ddev_start_search":
                    if profile:
                        cmd = ["ddev", "start", target, f"--profiles={profile}"]
                    else:
                        cmd = ["ddev", "start", target, "--profiles=search"]
            elif action == "clean_npm_cache":
                cmd = ["npm", "cache", "clean", "--force"]
            elif action == "ddev_clean_project":
                if not target or not re.match(r"^[a-zA-Z0-9_\.-]+$", target):
                    self.send_json(400, {"error": "Invalid project name"})
                    return
                cmd = ["ddev", "delete", target, "--omit-snapshot"]
            elif action == "clean_xcode_derived_data":
                dd = os.path.expanduser("~/Library/Developer/Xcode/DerivedData")
                if os.path.isdir(dd):
                    trash_dir = os.path.join(HOME, ".Trash")
                    count = 0
                    total_freed = 0
                    for item in os.listdir(dd):
                        item_path = os.path.join(dd, item)
                        try:
                            sz = 0
                            if os.path.islink(item_path):
                                sz = 0
                            elif os.path.isdir(item_path):
                                for root, _, files in os.walk(item_path):
                                    for f in files:
                                        try:
                                            sz += os.path.getsize(os.path.join(root, f))
                                        except Exception:
                                            pass
                            else:
                                sz = os.path.getsize(item_path)
                            shutil.move(item_path, os.path.join(trash_dir, f"{item}_{int(time.time())}"))
                            count += 1
                            total_freed += sz
                        except Exception:
                            pass
                    Thread(target=update_scan_cache, args=(True,), daemon=True).start()
                    self.send_json(200, {
                        "success": True,
                        "exit_code": 0,
                        "stdout": f"Cleaned {count} items from Xcode DerivedData ({format_bytes(total_freed)} freed to Trash).",
                        "stderr": "",
                        "saved_bytes": total_freed,
                        "saved_str": format_bytes(total_freed),
                        "duration": 0.5
                    })
                    return
                else:
                    self.send_json(200, {"success": True, "exit_code": 0, "stdout": "DerivedData directory does not exist or is already clean.", "stderr": ""})
                    return
            elif action == "trash_artifact":
                if not target:
                    self.send_json(400, {"error": "No artifact target specified"})
                    return
                ok, err, size = safe_trash_path(target)
                if ok:
                    Thread(target=update_scan_cache, args=(True,), daemon=True).start()
                    self.send_json(200, {
                        "success": True,
                        "exit_code": 0,
                        "stdout": f"Moved artifact to Trash ({format_bytes(size)} freed)",
                        "saved_bytes": size,
                        "saved_str": format_bytes(size),
                        "stderr": "",
                        "duration": 0.2
                    })
                    return
                else:
                    self.send_json(500, {"error": err})
                    return
            else:
                self.send_json(400, {"error": f"Unknown or disallowed action: {action}"})
                return

            t0 = time.time()
            pre_free = shutil.disk_usage("/").free
            colima_disk_path = os.path.join(COLIMA_DIR, "_lima", "_disks", "colima", "datadisk")
            pre_colima_allocated = 0
            if os.path.exists(colima_disk_path):
                try:
                    pre_colima_allocated = os.stat(colima_disk_path).st_blocks * 512
                except Exception:
                    pass

            try:
                proc = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=300)
                dur = round(time.time() - t0, 2)

                # Graceful fallback for ddev_logs when a container is not currently running
                combined_output = (proc.stdout or "") + (proc.stderr or "")
                if action == "ddev_logs" and ("No running service container" in combined_output or (proc.returncode != 0 and not combined_output.strip())):
                    target_container = f"ddev-{target}-{service}"
                    docker_check = subprocess.run(["docker", "ps", "-a", "--filter", f"name=^{target_container}$", "--format", "{{.Names}}"], capture_output=True, text=True, timeout=5)
                    if docker_check.stdout.strip() == target_container:
                        dl_proc = subprocess.run(["docker", "logs", "--tail", str(tail), target_container], capture_output=True, text=True, timeout=10)
                        proc.stdout = f"[Container '{target_container}' is stopped. Showing last recorded logs:]\n\n" + (dl_proc.stdout or dl_proc.stderr or "(No logs recorded)")
                        proc.stderr = ""
                    else:
                        aux_check = subprocess.run(["docker", "ps", "--filter", f"name=ddev-{target}", "--format", "{{.Names}}"], capture_output=True, text=True, timeout=5)
                        running_aux = [c.strip() for c in aux_check.stdout.strip().split("\n") if c.strip()]
                        if running_aux:
                            aux_name = running_aux[0]
                            dl_proc = subprocess.run(["docker", "logs", "--tail", str(tail), aux_name], capture_output=True, text=True, timeout=10)
                            proc.stdout = f"[Service '{service}' is not running for project '{target}'.]\n[Showing logs from active container '{aux_name}']:\n\n" + (dl_proc.stdout or dl_proc.stderr or "")
                            proc.stderr = ""
                        else:
                            proc.stdout = f"Project '{target}' is currently stopped (no active '{service}' container found).\n\nTo view live container logs, click 'Start' or 'Start Everything' on the '{target}' project card."
                            proc.stderr = ""
                
                post_free = shutil.disk_usage("/").free
                post_colima_allocated = 0
                if os.path.exists(colima_disk_path):
                    try:
                        post_colima_allocated = os.stat(colima_disk_path).st_blocks * 512
                    except Exception:
                        pass

                saved_bytes = 0
                saved_str = None
                
                # Check parsed stdout (Docker prune or fstrim)
                docker_match = re.search(r"(?i)(?:Total reclaimed space|Total):\s*([0-9\.]+\s*[kKmMgGtT]?[bB])", proc.stdout or "")
                if docker_match:
                    raw_str = docker_match.group(1).strip()
                    if raw_str.upper() not in ["0B", "0 B"]:
                        saved_str = raw_str

                fstrim_bytes = sum(int(b) for b in re.findall(r"(\d+)\s*bytes trimmed", proc.stdout or ""))
                if fstrim_bytes > 0:
                    saved_bytes = fstrim_bytes
                    saved_str = format_bytes(fstrim_bytes)

                colima_gain = max(0, pre_colima_allocated - post_colima_allocated)
                host_gain = max(0, post_free - pre_free)

                if not saved_str and colima_gain > 5 * 1024 * 1024:
                    saved_bytes = colima_gain
                    saved_str = format_bytes(colima_gain)
                elif not saved_str and host_gain > 20 * 1024 * 1024:
                    saved_bytes = host_gain
                    saved_str = format_bytes(host_gain)

                Thread(target=update_scan_cache, args=(True,), daemon=True).start()
                self.send_json(200, {
                    "success": proc.returncode == 0,
                    "exit_code": proc.returncode,
                    "stdout": proc.stdout,
                    "stderr": proc.stderr,
                    "duration": dur,
                    "command": " ".join(cmd),
                    "saved_bytes": saved_bytes,
                    "saved_str": saved_str,
                    "colima_gain": colima_gain,
                    "host_gain": host_gain
                })
            except subprocess.TimeoutExpired:
                self.send_json(504, {"error": "Command timed out after 300 seconds", "command": " ".join(cmd)})
            except Exception as e:
                self.send_json(500, {"error": str(e), "command": " ".join(cmd)})
            return

        self.send_error(404, "Endpoint not found")

def ensure_traefik_orbit_config():
    """
    Ensures orbit.ddev.site is routed via DDEV's Traefik reverse proxy to port 7890.
    """
    try:
        custom_dir = os.path.expanduser("~/.ddev/traefik/custom-global-config")
        os.makedirs(custom_dir, exist_ok=True)
        orbit_cfg = os.path.join(custom_dir, "orbit.yaml")
        cfg_content = """http:
  routers:
    orbit-http:
      entrypoints:
        - http-80
      rule: Host(`orbit.ddev.site`)
      service: orbit-service
      tls: false
    orbit-https:
      entrypoints:
        - http-443
      rule: Host(`orbit.ddev.site`)
      service: orbit-service
      tls: true

  services:
    orbit-service:
      loadbalancer:
        servers:
          - url: http://host.docker.internal:7890

tls:
  certificates:
    - certFile: /mnt/ddev-global-cache/traefik/certs/default_cert.crt
      keyFile: /mnt/ddev-global-cache/traefik/certs/default_key.key
"""
        with open(orbit_cfg, "w") as f:
            f.write(cfg_content)

        subprocess.run(
            ["docker", "cp", orbit_cfg, "ddev-router:/mnt/ddev-global-cache/traefik/config/orbit.yaml"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2
        )
    except Exception:
        pass

def start_server(port=PORT, auto_open=False):
    ensure_traefik_orbit_config()
    Thread(target=update_scan_cache, args=(False,), daemon=True).start()
    
    for p in range(port, port + 10):
        try:
            httpd = ThreadingHTTPServer(("127.0.0.1", p), OrbitHTTPHandler)
            url = f"http://localhost:{p}"
            print(f"\n========================================================", flush=True)
            print(f"🚀 DDev & Disk Orbit is running!", flush=True)
            print(f"👉 Dedicated Local Address: https://orbit.ddev.site", flush=True)
            print(f"👉 Direct Localhost:        {url}", flush=True)
            print(f"========================================================\n", flush=True)
            if auto_open:
                try:
                    subprocess.Popen(["open", "https://orbit.ddev.site"])
                except Exception:
                    pass
            httpd.serve_forever()
            break
        except OSError:
            continue

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    start_server(port=port)
