#!/usr/bin/env python3
"""agent-exec-tracer: run agent-exec.bt as root and write one JSONL log per uid.

  agent-exec-tracer.py [--dir /var/log/agent-exec] [--bt agent-exec.bt] [--stdin]

--stdin parses bpftrace-format lines from stdin instead of starting bpftrace (tests, no root).
Files: <dir>/<uid>.jsonl, mode 0600 owned by that uid; rotated to <uid>.jsonl.1 past
AGENT_EXEC_MAX_BYTES (default 10 MB). See README.md for the record shapes.
"""
import argparse
import json
import os
import subprocess
import sys
import time

MAX_BYTES = int(os.environ.get("AGENT_EXEC_MAX_BYTES", str(10 * 1024 * 1024)))


class Writer:
    def __init__(self, directory):
        self.dir = directory
        self.files = {}  # uid -> file object

    def path(self, uid):
        return os.path.join(self.dir, f"{uid}.jsonl")

    def _open(self, uid):
        p = self.path(uid)
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        os.fchmod(fd, 0o600)
        if os.geteuid() == 0:
            os.fchown(fd, uid, -1)
        fh = os.fdopen(fd, "w", encoding="utf-8")
        self.files[uid] = fh
        return fh

    def write(self, uid, record):
        fh = self.files.get(uid) or self._open(uid)
        if fh.tell() > MAX_BYTES:
            fh.close()
            os.replace(self.path(uid), self.path(uid) + ".1")
            fh = self._open(uid)
        fh.write(json.dumps(record, separators=(",", ":"), ensure_ascii=False) + "\n")
        fh.flush()


class Parser:
    def __init__(self, writer, now=lambda: int(time.time() * 1000)):
        self.writer = writer
        self.now = now
        self.args = {}  # pid -> argv elements seen so far
        self.uid_of = {}  # tracked pid -> uid (so an exit knows its file)

    def line(self, raw):
        parts = raw.rstrip("\n").split(" ")
        kind = parts[0]
        try:
            if kind == "A" and len(parts) >= 4:
                pid, index = int(parts[1]), int(parts[2])
                argv = self.args.setdefault(pid, [])
                if index == 0:
                    argv.clear()
                argv.append(" ".join(parts[3:]))
            elif kind == "X" and len(parts) == 7:
                pid, ppid, uid, root, lparent, _n = (int(x) for x in parts[1:])
                argv = " ".join(self.args.pop(pid, []))
                self.uid_of[pid] = uid
                if len(self.uid_of) > 200000:  # exits we never saw (tracer restarted): don't grow forever
                    self.uid_of.clear()
                self.writer.write(uid, {"ts": self.now(), "ev": "exec", "pid": pid, "ppid": ppid,
                                        "lparent": lparent, "root": root, "uid": uid, "argv": argv})
            elif kind == "Z" and len(parts) == 4:
                pid, code, sig = (int(x) for x in parts[1:])
                uid = self.uid_of.pop(pid, None)
                if uid is not None:
                    self.writer.write(uid, {"ts": self.now(), "ev": "exit", "pid": pid, "uid": uid,
                                            "code": code, "sig": sig})
        except ValueError:
            pass  # a line broken by a newline inside an argument: skip it


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dir", default="/var/log/agent-exec")
    ap.add_argument("--bt", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent-exec.bt"))
    ap.add_argument("--stdin", action="store_true")
    opts = ap.parse_args()
    os.makedirs(opts.dir, mode=0o755, exist_ok=True)
    parser = Parser(Writer(opts.dir))
    if opts.stdin:
        for line in sys.stdin:
            parser.line(line)
        return 0
    env = {**os.environ, "BPFTRACE_MAX_STRLEN": os.environ.get("BPFTRACE_MAX_STRLEN", "200")}
    proc = subprocess.Popen(["bpftrace", "-q", opts.bt], stdout=subprocess.PIPE, text=True,
                            errors="replace", env=env)
    for line in proc.stdout:
        parser.line(line)
    code = proc.wait()
    print(f"agent-exec-tracer: bpftrace exited with {code}", file=sys.stderr)
    return code or 1


if __name__ == "__main__":
    sys.exit(main())
