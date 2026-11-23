"""ARO code sandbox: a RunPod Serverless (CPU) worker that runs one command or
Python snippet per job, then restarts, so nothing carries over between jobs.

Input (job["input"]):
  mode:            "repo" (default) | "python"
  repo_url:        short-lived tarball URL (GitHub's redirect for /tarball/<ref>,
                   created by the Edge Function; it expires in minutes, so the
                   user's GitHub token never reaches this worker)
  files:           {path: content | null} staged edits applied on top (null = delete)
  command:         shell command, run in the repository root (mode "repo")
  code:            Python source (mode "python")
  toolchains:      ["node", "go"] to install before running
  timeout_seconds: 10..300

Isolation: the command runs as an unprivileged user with a minimal environment
(no RunPod or other credentials), in a fresh directory, with a time limit and
output cap; the worker is refreshed after every job.
"""

import os
import pwd
import shutil
import signal
import subprocess
import tarfile
import tempfile
import time
import urllib.request

import runpod

MAX_OUTPUT = 20_000
MAX_FILES_BYTES = 8 * 1024 * 1024
NODE_URL = "https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.xz"
GO_URL = "https://go.dev/dl/go1.23.3.linux-amd64.tar.gz"
USER = "sandbox"


def _clip(text: str) -> str:
    if len(text) <= MAX_OUTPUT:
        return text
    half = MAX_OUTPUT // 2
    return text[:half] + f"\n… ({len(text) - MAX_OUTPUT} characters cut) …\n" + text[-half:]


def _safe_join(root: str, rel: str) -> str:
    rel = rel.replace("\\", "/")
    while rel.startswith("./"):
        rel = rel[2:]
    parts = rel.split("/")
    if not rel or rel.startswith("/") or any(p in ("", ".", "..") for p in parts) or parts[0] == ".git":
        raise ValueError(f"unsafe path: {rel}")
    path = os.path.realpath(os.path.join(root, rel))
    if not path.startswith(os.path.realpath(root) + os.sep) or "/.git/" in f"/{rel}/":
        raise ValueError(f"unsafe path: {rel}")
    return path


def _download(url: str, dest: str, limit: int = 500 * 1024 * 1024) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "aro-sandbox"})
    with urllib.request.urlopen(req, timeout=120) as res, open(dest, "wb") as out:
        total = 0
        while chunk := res.read(1 << 20):
            total += len(chunk)
            if total > limit:
                raise ValueError("download too large")
            out.write(chunk)


def _extract_repo(archive: str, dest: str) -> None:
    with tarfile.open(archive, "r:*") as tar:
        members = []
        for m in tar.getmembers():
            parts = m.name.split("/", 1)
            if len(parts) < 2 or not parts[1]:
                continue
            if m.issym() or m.islnk() or m.isdev():
                continue
            m.name = parts[1]  # drop GitHub's "<owner>-<repo>-<sha>/" prefix
            _safe_join(dest, m.name)
            members.append(m)
        tar.extractall(dest, members=members, filter="data")


def _install(toolchains: list) -> str:
    notes = []
    tmp = tempfile.mkdtemp()
    if "node" in toolchains and not os.path.exists("/opt/node/bin/node"):
        _download(NODE_URL, f"{tmp}/node.tar.xz")
        os.makedirs("/opt/node", exist_ok=True)
        subprocess.run(["tar", "-xJf", f"{tmp}/node.tar.xz", "-C", "/opt/node", "--strip-components=1"], check=True)
        notes.append("node 22")
    if "go" in toolchains and not os.path.exists("/opt/go/bin/go"):
        _download(GO_URL, f"{tmp}/go.tar.gz")
        subprocess.run(["tar", "-xzf", f"{tmp}/go.tar.gz", "-C", "/opt"], check=True)
        notes.append("go 1.23")
    shutil.rmtree(tmp, ignore_errors=True)
    return ", ".join(notes)


def _run(args: list, cwd: str, timeout: int) -> dict:
    user = pwd.getpwnam(USER)
    env = {
        "PATH": "/opt/node/bin:/opt/go/bin:/home/sandbox/.local/bin:/usr/local/bin:/usr/bin:/bin",
        "HOME": user.pw_dir,
        "LANG": "C.UTF-8",
        "CI": "1",
        "GOPATH": f"{user.pw_dir}/go",
        "GOFLAGS": "-mod=mod",
        "PIP_DISABLE_PIP_VERSION_CHECK": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "NPM_CONFIG_UPDATE_NOTIFIER": "false",
    }
    started = time.time()
    proc = subprocess.Popen(
        args, cwd=cwd, env=env, user=user.pw_uid, group=user.pw_gid, extra_groups=[],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True,
    )
    timed_out = False
    try:
        out, _ = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(proc.pid, signal.SIGKILL)
        out, _ = proc.communicate()
    return {
        "exit_code": proc.returncode if not timed_out else 124,
        "timed_out": timed_out,
        "output": _clip(out.decode("utf-8", "replace")),
        "duration_ms": int((time.time() - started) * 1000),
    }


def run_job(inp: dict) -> dict:
    mode = inp.get("mode", "repo")
    timeout = max(10, min(int(inp.get("timeout_seconds") or 120), 300))
    work = tempfile.mkdtemp(prefix="job-")
    try:
        setup = []
        toolchains = [t for t in (inp.get("toolchains") or []) if t in ("node", "go")]
        if toolchains:
            setup.append(_install(toolchains))
        if mode == "python":
            code = str(inp.get("code") or "")
            if not code.strip():
                return {"error": "No code to run."}
            with open(f"{work}/main.py", "w", encoding="utf-8") as f:
                f.write(code)
            shutil.chown(work, USER, USER)
            shutil.chown(f"{work}/main.py", USER, USER)
            return {**_run(["python3", "-I", "main.py"], work, timeout), "setup": ", ".join(s for s in setup if s)}

        command = str(inp.get("command") or "").strip()
        if not command:
            return {"error": "No command to run."}
        repo = f"{work}/repo"
        os.makedirs(repo)
        if inp.get("repo_url"):
            _download(inp["repo_url"], f"{work}/repo.tar.gz")
            _extract_repo(f"{work}/repo.tar.gz", repo)
            os.remove(f"{work}/repo.tar.gz")
        files = inp.get("files") or {}
        if sum(len(v or "") for v in files.values()) > MAX_FILES_BYTES:
            return {"error": "Staged changes are too large for the sandbox."}
        for rel, content in files.items():
            path = _safe_join(repo, rel)
            if content is None:
                if os.path.isfile(path):
                    os.remove(path)
            else:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "w", encoding="utf-8") as f:
                    f.write(content)
        subprocess.run(["chown", "-R", f"{USER}:{USER}", work], check=True)
        # Not a login shell: /etc/profile would reset PATH and hide the installed toolchains.
        return {**_run(["bash", "-c", command], repo, timeout), "setup": ", ".join(s for s in setup if s)}
    except Exception as err:  # noqa: BLE001 - reported back to the agent as a tool error
        return {"error": f"{type(err).__name__}: {err}"}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def handler(job):
    # Restart the worker after every job: one job can never affect the next.
    # (runpod >= 1.7 removes "refresh_worker" from the output; an "error" key marks the job failed.)
    return {**run_job(job.get("input") or {}), "refresh_worker": True}


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler, "refresh_worker": True})
