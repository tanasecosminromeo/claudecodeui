# exec-tracer

Root bpftrace tracer that logs every process started under a `claude` or `claude-swap` process
(Bash-tool commands, curl, git, MCP servers, nested `claude -p`) and its exit, into one JSONL file
per user: `/var/log/agent-exec/<uid>.jsonl`, mode 0600 owned by that uid, 10 MB cap with one
rotated copy `<uid>.jsonl.1`. Session Radar (`../session-radar`) reads the current user's file to
show finished commands in a session's process tree. Nothing without a claude ancestor is logged.

Install (needs sudo): `make exec-tracer`. Remove: `make exec-tracer-uninstall`.
Files land in `/usr/local/lib/agent-exec-tracer/` and `/etc/systemd/system/agent-exec-tracer.service`.

Check: `systemctl status agent-exec-tracer`, then run `claude -p 'run: curl -s https://example.com'`
and `tail -3 /var/log/agent-exec/$(id -u).jsonl`.

Record shapes:

    {"ts":1759570000123,"ev":"exec","pid":123,"ppid":120,"lparent":118,"root":100,"uid":1000,"argv":"curl -s https://example.com"}
    {"ts":1759570000456,"ev":"exit","pid":123,"uid":1000,"code":0,"sig":0}

`root` = pid of the nearest claude/claude-swap ancestor; `lparent` = nearest ancestor that is itself
logged (or root), so a child of a forked-but-never-exec'd subshell still attaches to the tree.
`ts` is wall-clock milliseconds stamped by the wrapper when it reads the line. Each argument is cut
at 200 bytes and at most 12 arguments are kept; an argument containing a newline breaks its line and
is dropped. Linux only (bpftrace, BTF); the macOS instance shows live trees without history.

The parser is tested without root by `tests/tracer.test.mjs` (`make test-custom`), which feeds
bpftrace-format lines to `agent-exec-tracer.py --stdin --dir <tmp>`.
