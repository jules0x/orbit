#!/usr/bin/env python3
"""
DDev & Disk Orbit Scanner
Fast, resilient disk and DDEV/Docker bloat inspector for macOS.
"""

import os
import sys
import json
import time
import shutil
import glob
import re
import subprocess
from pathlib import Path
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor

HOME = os.path.expanduser("~")
SITES_DIR = os.path.join(HOME, "Sites")
DDEV_DIR = os.path.join(HOME, ".ddev")
COLIMA_DIR = os.path.join(HOME, ".colima")
DOWNLOADS_DIR = os.path.join(HOME, "Downloads")
DOWNLOADS_DB_DIR = os.path.join(DOWNLOADS_DIR, "DB")

def format_bytes(size):
    if size is None or size < 0:
        return "0 B"
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if size < 1024.0:
            return f"{size:.1f} {unit}"
        size /= 1024.0
    return f"{size:.1f} PB"

def format_age(days):
    if days == 0:
        return "Today"
    elif days == 1:
        return "Yesterday"
    elif days < 7:
        return f"{days}d ago"
    elif days < 30:
        return f"{days // 7}w ago"
    elif days < 365:
        return f"{days // 30}mo ago"
    else:
        return f"{days // 365}y ago"

def get_disk_overview():
    total, used, free = shutil.disk_usage("/")
    colima_datadisk = os.path.join(COLIMA_DIR, "_lima", "_disks", "colima", "datadisk")
    colima_allocated = 0
    colima_logical = 0
    if os.path.exists(colima_datadisk):
        try:
            st = os.stat(colima_datadisk)
            colima_logical = st.st_size
            colima_allocated = st.st_blocks * 512
        except Exception:
            pass

    return {
        "disk_total": total,
        "disk_used": used,
        "disk_free": free,
        "disk_total_str": format_bytes(total),
        "disk_used_str": format_bytes(used),
        "disk_free_str": format_bytes(free),
        "disk_used_percent": round((used / total) * 100, 1) if total else 0,
        "colima_allocated": colima_allocated,
        "colima_allocated_str": format_bytes(colima_allocated),
        "colima_logical": colima_logical,
        "colima_logical_str": format_bytes(colima_logical)
    }

def get_colima_info(colima_allocated=0):
    yaml_path = os.path.join(COLIMA_DIR, "default", "colima.yaml")
    cfg = {
        "status": "Stopped",
        "running": False,
        "is_running": False,
        "cpu": 4,
        "memory": 8,
        "disk": 100,
        "profile": "default",
        "vm_type": "vz",
        "runtime": "docker",
        "arch": "aarch64",
        "host_total_ram": 0,
        "host_total_ram_str": "0 GB",
        "host_total_cpus": 0,
        "memory_used_bytes": 0,
        "memory_used_str": "0 B",
        "memory_used_percent": 0.0,
        "cpu_used_percent": 0.0,
        "load_avg": 0.0,
        "disk_used_bytes": colima_allocated,
        "disk_used_str": format_bytes(colima_allocated),
        "disk_used_percent": 0.0
    }
    if os.path.isfile(yaml_path):
        try:
            with open(yaml_path, "r", errors="ignore") as f:
                for line in f:
                    s = line.strip()
                    if s.startswith("cpu:"):
                        cfg["cpu"] = int(s.split(":", 1)[1].strip())
                    elif s.startswith("memory:"):
                        cfg["memory"] = int(s.split(":", 1)[1].strip())
                    elif s.startswith("disk:"):
                        cfg["disk"] = int(s.split(":", 1)[1].strip())
                    elif s.startswith("vmType:"):
                        cfg["vm_type"] = s.split(":", 1)[1].strip().strip('"\'')
                    elif s.startswith("runtime:"):
                        cfg["runtime"] = s.split(":", 1)[1].strip().strip('"\'')
                    elif s.startswith("arch:"):
                        cfg["arch"] = s.split(":", 1)[1].strip().strip('"\'')
        except Exception:
            pass

    try:
        proc = subprocess.run(["colima", "list", "--json"], capture_output=True, text=True, timeout=3)
        if proc.returncode == 0 and proc.stdout.strip():
            for line in proc.stdout.strip().split("\n"):
                if line.strip():
                    item = json.loads(line)
                    if item.get("name") == "default" or not cfg.get("status_checked"):
                        st = item.get("status", "Stopped")
                        cfg["status"] = st
                        cfg["running"] = (st.lower() == "running")
                        cfg["is_running"] = cfg["running"]
                        if "cpus" in item and item["cpus"]:
                            cfg["cpu"] = item["cpus"]
                        if "memory" in item and item["memory"]:
                            cfg["memory"] = round(item["memory"] / (1024**3))
                        if "disk" in item and item["disk"]:
                            cfg["disk"] = round(item["disk"] / (1024**3))
                        cfg["status_checked"] = True
                        break
    except Exception:
        pass

    # Host hardware metrics
    try:
        res = subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=1)
        if res.returncode == 0:
            cfg["host_total_ram"] = int(res.stdout.strip())
            cfg["host_total_ram_str"] = format_bytes(cfg["host_total_ram"])
    except Exception:
        pass

    try:
        res = subprocess.run(["sysctl", "-n", "hw.ncpu"], capture_output=True, text=True, timeout=1)
        if res.returncode == 0:
            cfg["host_total_cpus"] = int(res.stdout.strip())
    except Exception:
        pass

    # Disk usage calculation vs setting
    disk_setting_bytes = cfg["disk"] * (1024**3)
    cfg["disk_setting_bytes"] = disk_setting_bytes
    if disk_setting_bytes > 0:
        cfg["disk_used_percent"] = round((colima_allocated / disk_setting_bytes) * 100, 1)

    # Memory and CPU live usage when Colima is running
    if cfg["is_running"]:
        try:
            proc = subprocess.run(["colima", "ssh", "--", "free", "-b"], capture_output=True, text=True, timeout=2)
            if proc.returncode == 0:
                for line in proc.stdout.strip().split("\n"):
                    if line.startswith("Mem:"):
                        parts = line.split()
                        if len(parts) >= 3:
                            used_bytes = int(parts[2])
                            cfg["memory_used_bytes"] = used_bytes
                            cfg["memory_used_str"] = format_bytes(used_bytes)
                            mem_limit_bytes = cfg["memory"] * (1024**3)
                            cfg["memory_used_percent"] = round((used_bytes / mem_limit_bytes) * 100, 1) if mem_limit_bytes else 0
        except Exception:
            pass

        try:
            proc = subprocess.run(["colima", "ssh", "--", "cat", "/proc/loadavg"], capture_output=True, text=True, timeout=2)
            if proc.returncode == 0:
                load = float(proc.stdout.split()[0])
                cfg["load_avg"] = load
                cfg["cpu_used_percent"] = round(min(100.0, (load / cfg["cpu"]) * 100), 1)
        except Exception:
            pass

    cfg["cpu_str"] = f"{cfg.get('cpu', 4)} Cores"
    cfg["memory_str"] = f"{cfg.get('memory', 8)} GiB"
    cfg["disk_str"] = f"{cfg.get('disk', 100)} GiB"
    return cfg

import re

def detect_project_dist(approot):
    if not approot or not os.path.isdir(approot):
        return {
            "configured": False,
            "status": "none",
            "is_built": False,
            "themes": [],
            "missing_themes": [],
            "build_cmd": None
        }

    theme_list = []
    themes_dir = os.path.join(approot, "themes")
    if os.path.isdir(themes_dir):
        try:
            for t in sorted(os.listdir(themes_dir)):
                tp = os.path.join(themes_dir, t)
                if not os.path.isdir(tp):
                    continue
                pkg_file = os.path.join(tp, "package.json")
                gulp_file = os.path.join(tp, "gulpfile.js")
                dist_dir = os.path.join(tp, "dist")
                has_pkg = os.path.isfile(pkg_file)
                has_gulp = os.path.isfile(gulp_file)
                has_dist = os.path.isdir(dist_dir) and any(not f.startswith(".") for f in os.listdir(dist_dir))
                
                if has_pkg or has_gulp or os.path.isdir(dist_dir):
                    theme_list.append({
                        "theme": t,
                        "has_pkg": has_pkg,
                        "has_dist": has_dist,
                        "dist_path": f"themes/{t}/dist"
                    })
        except Exception:
            pass

    root_pkg = os.path.isfile(os.path.join(approot, "package.json"))
    root_dist = os.path.join(approot, "dist")
    has_root_dist = os.path.isdir(root_dist) and any(not f.startswith(".") for f in os.listdir(root_dist))

    # Makefile analysis
    makefile = os.path.join(approot, "Makefile")
    make_targets = set()
    if os.path.isfile(makefile):
        try:
            with open(makefile, "r", errors="ignore") as f:
                for line in f:
                    m = re.match(r"^([a-zA-Z0-9_-]+):", line)
                    if m:
                        make_targets.add(m.group(1))
        except Exception:
            pass

    configured = (len(theme_list) > 0) or root_pkg or any(t in make_targets for t in ["yarnprod", "buildall", "gulpbuild", "setup"])
    if not configured:
        return {
            "configured": False,
            "status": "none",
            "is_built": False,
            "themes": [],
            "missing_themes": [],
            "build_cmd": None
        }

    # Determine preferred build command
    cmd = None
    if "yarnprod" in make_targets:
        cmd = "make yarnprod"
    elif "buildall" in make_targets:
        cmd = "make buildall"
    elif "gulpbuild" in make_targets:
        cmd = "make gulpbuild"
    elif "setup" in make_targets:
        cmd = "make setup"
    elif theme_list and theme_list[0].get("has_pkg"):
        tname = theme_list[0]["theme"]
        cmd = f"yarn --cwd themes/{tname} prod"
    elif root_pkg:
        cmd = "npm run build"

    # Check if built
    is_built = True
    missing_themes = []
    if theme_list:
        for t in theme_list:
            if not t["has_dist"]:
                is_built = False
                missing_themes.append(t["theme"])
    elif root_pkg:
        is_built = has_root_dist

    return {
        "configured": True,
        "status": "ready" if is_built else "missing",
        "is_built": is_built,
        "missing_themes": missing_themes,
        "themes": theme_list,
        "build_cmd": cmd
    }

def get_git_branch(approot):
    if not approot or not os.path.isdir(approot):
        return None
    git_dir = os.path.join(approot, ".git")
    try:
        if os.path.isdir(git_dir):
            head_file = os.path.join(git_dir, "HEAD")
            if os.path.isfile(head_file):
                with open(head_file, "r", errors="ignore") as hf:
                    content = hf.read().strip()
                    if content.startswith("ref: refs/heads/"):
                        return content[16:]
                    elif content:
                        return content[:7]
        elif os.path.isfile(git_dir):
            with open(git_dir, "r", errors="ignore") as gf:
                content = gf.read().strip()
                if content.startswith("gitdir:"):
                    real_dir = content[7:].strip()
                    if not os.path.isabs(real_dir):
                        real_dir = os.path.join(approot, real_dir)
                    hf = os.path.join(real_dir, "HEAD")
                    if os.path.isfile(hf):
                        with open(hf, "r", errors="ignore") as hf_file:
                            c2 = hf_file.read().strip()
                            if c2.startswith("ref: refs/heads/"):
                                return c2[16:]
                            elif c2:
                                return c2[:7]
    except Exception:
        pass
    return None

def get_git_info(approot):
    if not approot or not os.path.isdir(approot):
        return None
    git_dir = os.path.join(approot, ".git")
    if not os.path.exists(git_dir):
        return None

    branch = get_git_branch(approot)
    info = {
        "has_git": True,
        "branch": branch,
        "clean": True,
        "changed": 0,
        "untracked": 0,
        "total_dirty": 0,
        "has_changes": False,
        "files": []
    }

    try:
        proc = subprocess.run(
            ["git", "status", "--porcelain", "-unormal"],
            cwd=approot,
            capture_output=True,
            text=True,
            timeout=3
        )
        if proc.returncode != 0:
            return info

        changed = 0
        untracked = 0
        file_previews = []
        for line in proc.stdout.splitlines():
            line = line.rstrip("\r\n")
            if not line.strip():
                continue
            is_untracked = line.startswith("??")
            status_code = line[:2].strip()
            filepath = line[3:].strip()
            if is_untracked:
                untracked += 1
            else:
                changed += 1

            if len(file_previews) < 50:
                file_previews.append({
                    "status": status_code,
                    "file": filepath,
                    "untracked": is_untracked
                })

        total = changed + untracked
        info["changed"] = changed
        info["untracked"] = untracked
        info["total_dirty"] = total
        info["clean"] = (total == 0)
        info["has_changes"] = (total > 0)
        info["files"] = file_previews
        return info
    except Exception:
        return info

def get_project_branding(approot, name):
    """
    Detects project logo/icon and brand theme color.
    Searches themes/<theme>/static/svg, images, public/theme-*/src/svg, public/favicon.*, etc.
    Extracts brand/primary color from variables.scss / _variables.scss if present.
    Falls back to a handsome deterministic color from a balanced palette.
    """
    PALETTE = [
        "#0a84ff", "#10b981", "#f59e0b", "#8b5cf6", 
        "#ec4899", "#06b6d4", "#14b8a6", "#f97316", 
        "#6366f1", "#3b82f6", "#d946ef", "#84cc16"
    ]
    deterministic_color = PALETTE[abs(hash(name)) % len(PALETTE)]
    
    branding = {
        "has_logo": False,
        "logo_path": None,
        "brand_color": deterministic_color,
        "has_theme_color": False,
        "monogram": name[:3].upper() if len(name) >= 3 else name.upper()
    }

    if not approot or not os.path.isdir(approot):
        return branding

    logo_path = None
    brand_color = None

    # 1. Search themes directory
    themes_dir = os.path.join(approot, "themes")
    if os.path.isdir(themes_dir):
        try:
            for t in os.listdir(themes_dir):
                tdir = os.path.join(themes_dir, t)
                if not os.path.isdir(tdir):
                    continue

                # Check for SCSS variables for brand color
                if not brand_color:
                    for root, dirs, files in os.walk(tdir):
                        dirs[:] = [d for d in dirs if d not in ("node_modules", "dist", ".git", "silverstripe-cache")]
                        if len(os.path.relpath(root, tdir).split(os.sep)) > 3:
                            continue
                        for f in files:
                            fl = f.lower()
                            if fl.endswith(".scss") and any(k in fl for k in ("var", "color", "theme", "brand")):
                                try:
                                    with open(os.path.join(root, f), "r", errors="ignore") as fp:
                                        content = fp.read(4000)
                                        m = re.search(r"(?:primary|brand|theme|main|accent)[\w-]*\s*:\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\))", content, re.I)
                                        if m:
                                            c_val = m.group(1).strip()
                                            if c_val.startswith("#") and len(c_val) in (4, 7):
                                                brand_color = c_val
                                                break
                                except Exception:
                                    pass
                        if brand_color:
                            break

                # Check for logo image (SVG prioritized, then PNG, ICO, WEBP)
                svg_candidates = []
                img_candidates = []
                for sub in ["static/svg", "static/images", "static/img", "images", "img", "src/svg", "src/img", "src/images", "assets/images"]:
                    sdir = os.path.join(tdir, sub)
                    if os.path.isdir(sdir):
                        try:
                            for f in os.listdir(sdir):
                                fl = f.lower()
                                fp = os.path.join(sdir, f)
                                if fl.endswith(".svg") and any(k in fl for k in ("logo", "brand", "mark")):
                                    svg_candidates.append(fp)
                                elif fl.endswith((".png", ".ico", ".webp", ".jpg")) and any(k in fl for k in ("logo", "brand", "favicon", "icon")):
                                    img_candidates.append(fp)
                        except Exception:
                            pass
                if svg_candidates:
                    logo_path = svg_candidates[0]
                    break
                elif img_candidates and not logo_path:
                    logo_path = img_candidates[0]
        except Exception:
            pass

    # 2. Check public directory
    if not logo_path:
        public_dir = os.path.join(approot, "public")
        if os.path.isdir(public_dir):
            for pat in [
                "theme-*/src/svg/*logo*.svg",
                "favicon.png",
                "favicon.ico",
                "apple-touch-icon.png",
                "assets/**/logo*.png"
            ]:
                matches = glob.glob(os.path.join(public_dir, pat), recursive=True)
                if matches:
                    logo_path = matches[0]
                    break

    # 3. Check root favicon.ico
    if not logo_path:
        root_fav = os.path.join(approot, "favicon.ico")
        if os.path.isfile(root_fav):
            logo_path = root_fav

    if logo_path and os.path.isfile(logo_path):
        branding["has_logo"] = True
        branding["logo_path"] = logo_path

    if brand_color:
        branding["has_theme_color"] = True
        branding["brand_color"] = brand_color

    return branding

def extract_project_urls(ddev_dir, default_name):
    """
    Parses additional_fqdns and additional_hostnames from .ddev/config.yaml
    and any config.*.yaml override files (with config.local.yaml applied last).
    When an override file defines additional_fqdns or additional_hostnames (including []),
    it replaces the prior value just like DDEV does.
    Prefers 'local.*' style agency domains (e.g. local.tradingstandards.govt.nz),
    falling back to first additional_fqdn, additional_hostname, or <name>.ddev.site.
    """
    fqdns = []
    hostnames = []
    cfg_files = [os.path.join(ddev_dir, "config.yaml")]
    try:
        extras = sorted(
            f for f in os.listdir(ddev_dir)
            if f.startswith("config.") and f.endswith(".yaml") and f not in ("config.yaml", "config.local.yaml")
        )
        cfg_files.extend(os.path.join(ddev_dir, f) for f in extras)
        local_cfg = os.path.join(ddev_dir, "config.local.yaml")
        if os.path.isfile(local_cfg):
            cfg_files.append(local_cfg)
    except Exception:
        pass

    def _parse_inline_yaml_list(raw_val):
        cleaned = raw_val.split("#", 1)[0].strip() if "[" in raw_val else ""
        if cleaned.startswith("[") and cleaned.endswith("]"):
            return [x.strip().strip("'\"") for x in cleaned[1:-1].split(",") if x.strip()]
        return None

    for cf in cfg_files:
        if not os.path.isfile(cf):
            continue
        try:
            with open(cf, "r", errors="ignore") as f:
                in_fqdns = False
                in_hostnames = False
                for line in f:
                    stripped = line.strip()
                    if not stripped or stripped.startswith("#"):
                        continue
                    is_top_level = line[0] not in (" ", "\t")
                    if is_top_level and stripped.startswith("additional_fqdns:"):
                        val = stripped.split("additional_fqdns:", 1)[1].strip()
                        inline_items = _parse_inline_yaml_list(val)
                        if inline_items is not None:
                            fqdns = inline_items
                            in_fqdns = False
                        else:
                            # Block list follows (or empty key overrides prior values)
                            fqdns = []
                            in_fqdns = True
                        in_hostnames = False
                        continue
                    elif is_top_level and stripped.startswith("additional_hostnames:"):
                        val = stripped.split("additional_hostnames:", 1)[1].strip()
                        inline_items = _parse_inline_yaml_list(val)
                        if inline_items is not None:
                            hostnames = inline_items
                            in_hostnames = False
                        else:
                            hostnames = []
                            in_hostnames = True
                        in_fqdns = False
                        continue
                    elif is_top_level and ":" in line:
                        in_fqdns = False
                        in_hostnames = False

                    if in_fqdns and stripped.startswith("-"):
                        val = stripped.lstrip("-").strip().split("#", 1)[0].strip().strip("'\"")
                        if val and val not in fqdns:
                            fqdns.append(val)
                    elif in_hostnames and stripped.startswith("-"):
                        val = stripped.lstrip("-").strip().split("#", 1)[0].strip().strip("'\"")
                        if val and val not in hostnames:
                            hostnames.append(val)
        except Exception:
            pass

    primary_domain = None
    # 1. Prefer local.* style domains (e.g. local.tradingstandards.govt.nz)
    for d in fqdns:
        if d.startswith("local."):
            primary_domain = d
            break
    # 2. Next prefer any other custom FQDN (e.g. tradingstandards.test)
    if not primary_domain and fqdns:
        primary_domain = fqdns[0]
    # 3. Next prefer additional_hostname
    elif not primary_domain and hostnames:
        primary_domain = f"{hostnames[0]}.ddev.site"

    default_domain = f"{default_name}.ddev.site"
    if not primary_domain:
        primary_domain = default_domain

    primary_url = f"https://{primary_domain}"

    all_domains = []
    if primary_domain:
        all_domains.append(primary_domain)
    for d in fqdns:
        if d not in all_domains:
            all_domains.append(d)
    for h in hostnames:
        hd = f"{h}.ddev.site"
        if hd not in all_domains:
            all_domains.append(hd)
    if default_domain not in all_domains:
        all_domains.append(default_domain)

    return {
        "primary_url": primary_url,
        "primary_domain": primary_domain,
        "all_urls": [f"https://{d}" for d in all_domains],
        "all_domains": all_domains
    }

def get_ddev_projects():
    projects = {}
    proj_list_file = os.path.join(DDEV_DIR, "project_list.yaml")
    now = time.time()
    if os.path.exists(proj_list_file):
        try:
            current_proj = None
            with open(proj_list_file, "r") as f:
                for line in f:
                    stripped = line.rstrip()
                    if not stripped or stripped.startswith("#"):
                        continue
                    if not line.startswith(" ") and stripped.endswith(":"):
                        current_proj = stripped[:-1].strip()
                        projects[current_proj] = {
                            "name": current_proj,
                            "approot": "",
                            "status": "stopped",
                            "is_running": False,
                            "branch": None,
                            "age_days": 999,
                            "mtime": 0,
                            "last_modified_str": "Unknown",
                            "php_version": "",
                            "project_type": "",
                            "db_type": "",
                            "http_url": f"https://{current_proj}.ddev.site",
                            "snapshots_count": 0,
                            "search": {
                                "configured": False,
                                "type": None,
                                "profile": None,
                                "file": None,
                                "is_running": False
                            },
                            "dist": {
                                "configured": False,
                                "status": "none",
                                "is_built": False,
                                "themes": [],
                                "missing_themes": [],
                                "build_cmd": None
                            }
                        }
                    elif current_proj and "approot:" in line:
                        parts = line.split("approot:", 1)
                        if len(parts) > 1:
                            projects[current_proj]["approot"] = parts[1].strip().strip('"').strip("'")
        except Exception as e:
            sys.stderr.write(f"Error reading project_list.yaml: {e}\n")

    for name, p in projects.items():
        approot = p["approot"]
        if not approot or not os.path.isdir(approot):
            continue
        try:
            st = os.stat(approot)
            p["mtime"] = st.st_mtime
            p["age_days"] = int((now - st.st_mtime) / 86400)
            p["last_modified_str"] = format_age(p["age_days"])
        except Exception:
            pass

        ddev_dir = os.path.join(approot, ".ddev")
        if os.path.isdir(ddev_dir):
            cfg_file = os.path.join(ddev_dir, "config.yaml")
            if os.path.isfile(cfg_file):
                try:
                    with open(cfg_file, "r", errors="ignore") as cf:
                        for line in cf:
                            if line.startswith(" ") or line.startswith("\t"):
                                continue
                            cl = line.strip()
                            if cl.startswith("php_version:"):
                                p["php_version"] = cl.split(":", 1)[1].strip().strip('"\'')
                            elif cl.startswith("type:"):
                                p["project_type"] = cl.split(":", 1)[1].strip().strip('"\'')
                            elif cl.startswith("database:"):
                                p["db_type"] = cl.split(":", 1)[1].strip().strip('"\'')
                except Exception:
                    pass

            # Extract preferred agency domain / additional FQDNs
            urls_info = extract_project_urls(ddev_dir, name)
            p["http_url"] = urls_info["primary_url"]
            p["primary_domain"] = urls_info["primary_domain"]
            p["all_urls"] = urls_info["all_urls"]
            p["all_domains"] = urls_info["all_domains"]

            # Search compose files
            try:
                for f in os.listdir(ddev_dir):
                    if f.endswith(".yaml") and any(k in f.lower() for k in ["solr", "elastic", "open"]):
                        fp = os.path.join(ddev_dir, f)
                        stype = "solr" if "solr" in f.lower() else "elasticsearch" if "elastic" in f.lower() else "opensearch"
                        profile = None
                        try:
                            with open(fp, "r", errors="ignore") as yf:
                                lines = yf.readlines()
                                for i, l in enumerate(lines):
                                    if "profiles:" in l:
                                        if "[" in l:
                                            profile = l.split("[", 1)[1].split("]", 1)[0].replace('"', '').replace("'", '').strip()
                                        elif i + 1 < len(lines) and "-" in lines[i+1]:
                                            profile = lines[i+1].replace("-", "").replace('"', '').replace("'", '').strip()
                        except Exception:
                            pass
                        p["search"] = {
                            "configured": True,
                            "type": stype,
                            "profile": profile,
                            "file": f,
                            "is_running": False
                        }
                        break
            except Exception:
                pass

            # Count snapshots
            snap_dir = os.path.join(ddev_dir, "db_snapshots")
            if os.path.isdir(snap_dir):
                try:
                    snaps = [f for f in os.listdir(snap_dir) if not f.startswith(".")]
                    p["snapshots_count"] = len(snaps)
                except Exception:
                    pass

    # Inspect git status, dist, and branding concurrently across all projects
    def inspect_project_git_and_dist(item):
        pname, pdata = item
        approot = pdata.get("approot")
        dist = detect_project_dist(approot) if approot else {"configured": False, "status": "none", "is_built": False}
        git_info = get_git_info(approot) if approot else None
        branding = get_project_branding(approot, pname)
        return pname, dist, git_info, branding

    try:
        with ThreadPoolExecutor(max_workers=10) as ex:
            results = list(ex.map(inspect_project_git_and_dist, projects.items()))
        for pname, dist, git_info, branding in results:
            if pname in projects:
                projects[pname]["dist"] = dist
                projects[pname]["git"] = git_info
                projects[pname]["branch"] = git_info.get("branch") if git_info else None
                projects[pname]["branding"] = branding
    except Exception:
        # Fallback to serial inspection if ThreadPool fails
        for pname, p in projects.items():
            approot = p.get("approot")
            p["dist"] = detect_project_dist(approot)
            p["git"] = get_git_info(approot)
            p["branch"] = p["git"].get("branch") if p["git"] else get_git_branch(approot)
            p["branding"] = get_project_branding(approot, pname)

    return projects

def refresh_live_containers(cache):
    if not cache or "projects" not in cache:
        return
    try:
        proc = subprocess.run(
            ["docker", "ps", "--format", "{{.Names}}"],
            capture_output=True, text=True, timeout=3
        )
        if proc.returncode == 0:
            running_set = set(line.strip() for line in proc.stdout.strip().split("\n") if line.strip())
            if "docker" in cache:
                cache["docker"]["running_containers"] = list(running_set)
            for name, p in cache.get("projects", {}).items():
                is_web_running = (f"ddev-{name}-web" in running_set)
                search_is_running = any(
                    (c == f"ddev-{name}-solr" or c == f"ddev-{name}-elasticsearch" or c == f"ddev-{name}-es" or c == f"ddev-{name}-opensearch" or f"{name}-solr" in c or f"{name}-elasticsearch" in c)
                    for c in running_set
                )
                p["is_running"] = is_web_running
                p["status"] = "running" if is_web_running else "stopped"
                if p.get("search", {}).get("configured"):
                    p["search"]["is_running"] = search_is_running
    except Exception:
        pass

def parse_docker_size_bytes(size_str):
    if not size_str:
        return 0
    s = size_str.strip().upper()
    try:
        if s.endswith("GB") or s.endswith("G"):
            return int(float(s.rstrip("GB").rstrip("G")) * 1024 * 1024 * 1024)
        if s.endswith("MB") or s.endswith("M"):
            return int(float(s.rstrip("MB").rstrip("M")) * 1024 * 1024)
        if s.endswith("KB") or s.endswith("K"):
            return int(float(s.rstrip("KB").rstrip("K")) * 1024)
        if s.endswith("B"):
            return int(float(s.rstrip("B")))
        return int(float(s))
    except Exception:
        return 0

def get_docker_data(known_projects):
    volumes = []
    images = []
    running_containers = set()

    containers_detail = []
    # Check running containers
    try:
        proc = subprocess.run(
            ["docker", "ps", "--format", "{{.Names}}\t{{.Status}}\t{{.Ports}}\t{{.Image}}"],
            capture_output=True, text=True, timeout=5
        )
        if proc.returncode == 0:
            for line in proc.stdout.strip().split("\n"):
                if line:
                    parts = line.split("\t")
                    c_name = parts[0].strip()
                    c_status = parts[1].strip() if len(parts) > 1 else "Up"
                    c_ports = parts[2].strip() if len(parts) > 2 else ""
                    c_image = parts[3].strip() if len(parts) > 3 else ""
                    running_containers.add(c_name)
                    containers_detail.append({
                        "name": c_name,
                        "status": c_status,
                        "ports": c_ports,
                        "image": c_image
                    })
    except Exception:
        pass

    # Inspect volumes
    try:
        proc = subprocess.run(
            ["docker", "volume", "ls", "--format", "{{.Name}}"],
            capture_output=True, text=True, timeout=5
        )
        if proc.returncode == 0:
            for line in proc.stdout.strip().split("\n"):
                vol_name = line.strip()
                if not vol_name:
                    continue
                
                # Match volume to known project
                matched_proj = None
                for proj_name in known_projects:
                    if vol_name.startswith(f"{proj_name}-") or \
                       vol_name.startswith(f"{proj_name}_") or \
                       vol_name.startswith(f"ddev-{proj_name}_") or \
                       vol_name.startswith(f"ddev-{proj_name}-"):
                        matched_proj = proj_name
                        break

                vol_type = "generic"
                if "mariadb" in vol_name:
                    vol_type = "MariaDB Database"
                elif "postgres" in vol_name:
                    vol_type = "PostgreSQL Database"
                elif "mysql" in vol_name:
                    vol_type = "MySQL Database"
                elif "elastic" in vol_name or "kibana" in vol_name:
                    vol_type = "Elasticsearch / Kibana"
                elif "mutagen" in vol_name:
                    vol_type = "Mutagen Sync Cache"

                volumes.append({
                    "name": vol_name,
                    "project": matched_proj,
                    "type": vol_type,
                    "is_orphaned": matched_proj is None and not vol_name.startswith("ddev-")
                })
    except Exception:
        pass

    # Inspect images
    try:
        proc = subprocess.run(
            ["docker", "images", "--format", "{{.Repository}}\t{{.Tag}}\t{{.Size}}\t{{.ID}}"],
            capture_output=True, text=True, timeout=8
        )
        if proc.returncode == 0:
            for line in proc.stdout.strip().split("\n"):
                parts = line.split("\t")
                if len(parts) >= 3:
                    repo, tag, size_str = parts[0], parts[1], parts[2]
                    img_id = parts[3] if len(parts) > 3 else ""
                    
                    is_ddev_custom = "-built" in tag or "ddev-" in repo or repo.startswith("ddev/")
                    is_dangling = repo == "<none>" and tag == "<none>"
                    
                    # Try matching project
                    matched_proj = None
                    if "-built" in tag:
                        try:
                            without_built = tag.rsplit("-built", 1)[0]
                            if "-" in without_built:
                                cand = without_built.split("-", 1)[1]
                                matched_proj = cand
                        except Exception:
                            pass

                    if not matched_proj:
                        for proj_name in known_projects:
                            if proj_name in repo or proj_name in tag:
                                matched_proj = proj_name
                                break

                    images.append({
                        "repository": repo,
                        "tag": tag,
                        "size_str": size_str,
                        "size_bytes": parse_docker_size_bytes(size_str),
                        "id": img_id,
                        "is_ddev_custom": is_ddev_custom,
                        "is_dangling": is_dangling,
                        "project": matched_proj
                    })
    except Exception:
        pass

    return {
        "running_containers": list(running_containers),
        "containers_detail": containers_detail,
        "volumes": volumes,
        "images": images,
        "total_volumes": len(volumes),
        "total_images": len(images)
    }

def get_database_dumps(known_projects):
    dumps = []
    extensions = {".sql", ".gz", ".sspak", ".zst", ".tar", ".tgz", ".dump", ".bak"}
    
    # Target search roots
    targets = [
        DOWNLOADS_DB_DIR,
        DOWNLOADS_DIR,
        os.path.join(HOME, "Desktop"),
        os.path.join(HOME, "Documents")
    ]
    
    # Also include project-level db_snapshots
    for proj_name, info in known_projects.items():
        approot = info.get("approot")
        if approot and os.path.isdir(approot):
            snap_dir = os.path.join(approot, ".ddev", "db_snapshots")
            if os.path.isdir(snap_dir):
                targets.append(snap_dir)
            dumps_dir = os.path.join(approot, "dumps")
            if os.path.isdir(dumps_dir):
                targets.append(dumps_dir)

    now = time.time()
    seen_paths = set()

    for root_dir in targets:
        if not os.path.exists(root_dir):
            continue
        try:
            # We don't recurse infinitely; maxdepth 2 for general, 1 for DB dir
            is_downloads_root = (root_dir == DOWNLOADS_DIR)
            for entry in os.scandir(root_dir):
                try:
                    if entry.is_file(follow_symlinks=False):
                        p = entry.path
                        if p in seen_paths:
                            continue
                        name = entry.name
                        lower = name.lower()
                        
                        # Match extensions or .sspak.zip
                        matched = any(lower.endswith(ext) for ext in extensions) or lower.endswith(".sspak.zip") or ".sql." in lower
                        if not matched:
                            continue
                        
                        st = entry.stat(follow_symlinks=False)
                        size = st.st_size
                        # Only report files > 1 MB to reduce clutter
                        if size < 1024 * 1024:
                            continue
                        
                        seen_paths.add(p)
                        mtime = st.st_mtime
                        age_days = int((now - mtime) / 86400)
                        
                        # Match project
                        matched_proj = None
                        for proj_name in known_projects:
                            if proj_name.lower() in lower:
                                matched_proj = proj_name
                                break
                        
                        dumps.append({
                            "name": name,
                            "path": p,
                            "size": size,
                            "size_str": format_bytes(size),
                            "modified": datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M"),
                            "age_days": age_days,
                            "project": matched_proj,
                            "location": "Downloads/DB" if DOWNLOADS_DB_DIR in p else ("Project Snapshot" if "db_snapshots" in p else "Downloads/Other")
                        })
                    elif entry.is_dir(follow_symlinks=False) and not is_downloads_root:
                        # Scan 1 level into subdirectories if inside DB dir
                        try:
                            for sub_entry in os.scandir(entry.path):
                                if sub_entry.is_file(follow_symlinks=False):
                                    sub_p = sub_entry.path
                                    if sub_p in seen_paths:
                                        continue
                                    sub_lower = sub_entry.name.lower()
                                    if any(sub_lower.endswith(ext) for ext in extensions) or sub_lower.endswith(".sspak.zip") or ".sql." in sub_lower:
                                        sub_st = sub_entry.stat(follow_symlinks=False)
                                        sub_size = sub_st.st_size
                                        if sub_size < 1024 * 1024:
                                            continue
                                        seen_paths.add(sub_p)
                                        sub_mtime = sub_st.st_mtime
                                        dumps.append({
                                            "name": sub_entry.name,
                                            "path": sub_p,
                                            "size": sub_size,
                                            "size_str": format_bytes(sub_size),
                                            "modified": datetime.fromtimestamp(sub_mtime).strftime("%Y-%m-%d %H:%M"),
                                            "age_days": int((now - sub_mtime) / 86400),
                                            "project": None,
                                            "location": "Downloads/DB (Subdir)"
                                        })
                        except Exception:
                            pass
                except Exception:
                    pass
        except Exception:
            pass

    dumps.sort(key=lambda x: x["size"], reverse=True)
    total_dumps_size = sum(d["size"] for d in dumps)
    return {
        "dumps": dumps,
        "total_dumps": len(dumps),
        "total_dumps_size": total_dumps_size,
        "total_dumps_size_str": format_bytes(total_dumps_size)
    }

from concurrent.futures import ThreadPoolExecutor

CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".scan_cache.json")
_cache = None
_cache_time = 0

def check_single_artifact(item):
    proj_name, candidate, cand_path = item
    try:
        res = subprocess.run(
            ["du", "-sk", cand_path],
            capture_output=True, text=True, timeout=3
        )
        if res.returncode == 0:
            kb = int(res.stdout.split()[0])
            size = kb * 1024
            if size > 15 * 1024 * 1024:  # > 15MB
                return {
                    "project": proj_name,
                    "type": candidate,
                    "path": cand_path,
                    "size": size,
                    "size_str": format_bytes(size)
                }
    except Exception:
        pass
    return None

def get_dev_artifacts(known_projects):
    candidates = []
    for proj_name, info in known_projects.items():
        approot = info.get("approot")
        if not approot or not os.path.isdir(approot):
            continue
        for folder in ["node_modules", "vendor", ".next", "dist", "build"]:
            cand_path = os.path.join(approot, folder)
            if os.path.isdir(cand_path):
                candidates.append((proj_name, folder, cand_path))

    artifacts = []
    with ThreadPoolExecutor(max_workers=12) as executor:
        results = executor.map(check_single_artifact, candidates)
        for r in results:
            if r:
                artifacts.append(r)

    # Check Xcode DerivedData & Archives
    xcode_derived = os.path.join(HOME, "Library/Developer/Xcode/DerivedData")
    if os.path.isdir(xcode_derived):
        try:
            res = subprocess.run(["du", "-sk", xcode_derived], capture_output=True, text=True, timeout=3)
            if res.returncode == 0:
                kb = int(res.stdout.split()[0])
                sz = kb * 1024
                if sz > 50 * 1024 * 1024:
                    artifacts.append({
                        "project": "Xcode System",
                        "type": "DerivedData",
                        "path": xcode_derived,
                        "size": sz,
                        "size_str": format_bytes(sz)
                    })
        except Exception:
            pass

    artifacts.sort(key=lambda x: x["size"], reverse=True)
    total_artifacts_size = sum(a["size"] for a in artifacts)
    return {
        "artifacts": artifacts,
        "total_artifacts": len(artifacts),
        "total_artifacts_size": total_artifacts_size,
        "total_artifacts_size_str": format_bytes(total_artifacts_size)
    }

def get_giant_files(min_mb=150):
    min_bytes = min_mb * 1024 * 1024
    giant_files = []
    
    # Target folders to scan 2 levels deep
    scan_roots = [
        DOWNLOADS_DIR,
        os.path.join(HOME, "Desktop"),
        os.path.join(HOME, "Documents")
    ]
    
    for s_root in scan_roots:
        if not os.path.isdir(s_root):
            continue
        try:
            for root, dirs, files in os.walk(s_root):
                # Don't go deeper than 2 levels
                rel = os.path.relpath(root, s_root)
                depth = len(rel.split(os.sep)) if rel != "." else 0
                if depth > 2:
                    dirs.clear()
                    continue
                # Skip .git
                if ".git" in dirs:
                    dirs.remove(".git")
                if "node_modules" in dirs:
                    dirs.remove("node_modules")

                for f in files:
                    try:
                        p = os.path.join(root, f)
                        st = os.stat(p, follow_symlinks=False)
                        size = st.st_size
                        if size >= min_bytes:
                            giant_files.append({
                                "name": f,
                                "path": p,
                                "size": size,
                                "size_str": format_bytes(size),
                                "modified": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M")
                            })
                    except Exception:
                        pass
        except Exception:
            pass

    giant_files.sort(key=lambda x: x["size"], reverse=True)
    return giant_files

def full_audit():
    overview = get_disk_overview()
    overview["colima"] = get_colima_info(overview.get("colima_allocated", 0))
    projects = get_ddev_projects()
    docker_data = get_docker_data(projects)
    db_dumps = get_database_dumps(projects)
    artifacts = get_dev_artifacts(projects)
    giant_files = get_giant_files()

    # Enrich projects with live container status, volumes, and dumps
    running_set = set(docker_data.get("running_containers", []))
    for name, p in projects.items():
        # A DDEV project is only active/running if its primary web container is running
        is_web_running = (f"ddev-{name}-web" in running_set)
        search_is_running = any(
            (c == f"ddev-{name}-solr" or c == f"ddev-{name}-elasticsearch" or c == f"ddev-{name}-es" or c == f"ddev-{name}-opensearch" or f"{name}-solr" in c or f"{name}-elasticsearch" in c)
            for c in running_set
        )
        p["is_running"] = is_web_running
        p["status"] = "running" if is_web_running else "stopped"
        if p.get("search", {}).get("configured"):
            p["search"]["is_running"] = search_is_running

        # Count project volumes and database backups
        vols = [v for v in docker_data.get("volumes", []) if v.get("project") == name or name in v.get("name", "")]
        p["volumes_count"] = len(vols)
        
        p_dumps = [d for d in db_dumps.get("dumps", []) if d.get("project") == name]
        p["dumps_count"] = len(p_dumps)
        p["dumps_size"] = sum(d["size"] for d in p_dumps)
        p["dumps_size_str"] = format_bytes(p["dumps_size"])

    # Calculate potential savings
    potential_savings = 0
    
    # 1. Downloads DB files older than 30 days or raw .sql dumps
    db_savings = sum(d["size"] for d in db_dumps["dumps"])
    potential_savings += db_savings
    
    # 2. Estimate Colima unneeded volume / dangling image savings (e.g. inactive DDEV projects)
    # Colima allocated is 97.6GB. If trimmed down to active containers, typically saves 40-70GB
    colima_savings_est = max(0, overview["colima_allocated"] - (15 * 1024 * 1024 * 1024))
    potential_savings += colima_savings_est

    # 3. Dev artifacts
    artifacts_savings = artifacts["total_artifacts_size"]
    potential_savings += artifacts_savings

    return {
        "timestamp": datetime.now().isoformat(),
        "overview": overview,
        "projects_count": len(projects),
        "projects": projects,
        "docker": docker_data,
        "db_dumps": db_dumps,
        "artifacts": artifacts,
        "giant_files": giant_files,
        "potential_savings": potential_savings,
        "potential_savings_str": format_bytes(potential_savings)
    }

if __name__ == "__main__":
    t0 = time.time()
    print("Running audit...")
    data = full_audit()
    print(f"Audit completed in {time.time() - t0:.2f}s")
    print(f"Disk Free: {data['overview']['disk_free_str']} of {data['overview']['disk_total_str']}")
    print(f"Colima Disk: {data['overview']['colima_allocated_str']}")
    print(f"Database Dumps Found: {data['db_dumps']['total_dumps']} ({data['db_dumps']['total_dumps_size_str']})")
    print(f"Docker Volumes: {data['docker']['total_volumes']}")
    print(f"Potential Space To Reclaim: ~{data['potential_savings_str']}")
