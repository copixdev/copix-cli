#!/usr/bin/env python3
"""Drive the model picker through a pseudoterminal."""
import os
import select
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODES = {
    "down-enter": ("raw", b"\x1b[B\r"),
    "esc": ("raw", b"\x1b"),
    "three": ("raw", b"3\r"),
    "ctrl-c": ("raw", b"\x03"),
    "j-enter": ("raw", b"j\r"),
    "plain-two": ("plain", b"2\n"),
    "plain-name": ("plain", b"mistral:7b\n"),
    "plain-empty": ("plain", b"\n"),
}


def main():
    mode = sys.argv[1]
    if mode not in MODES:
        sys.stderr.write(f"unknown mode {mode}\n")
        return 2
    kind, keys = MODES[mode]
    import pty

    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(ROOT)
        env = os.environ.copy()
        env["TERM"] = "xterm-256color"
        env.pop("NO_COLOR", None)
        os.execvpe(
            "node",
            ["node", os.path.join(ROOT, "scripts", "picker-fixture.mjs"), kind],
            env,
        )

    buf = b""
    sent = False
    deadline = time.time() + 6
    child_status = None
    while time.time() < deadline and child_status is None:
        readable, _, _ = select.select([fd], [], [], 0.1)
        if readable:
            try:
                chunk = os.read(fd, 8192)
            except OSError:
                chunk = b""
            if chunk:
                buf += chunk
            else:
                break
        markers = (b"route by task", b"Choose a number or name", b"1. auto")
        if not sent and any(marker in buf for marker in markers):
            time.sleep(0.05)
            os.write(fd, keys)
            sent = True
        wpid, status = os.waitpid(pid, os.WNOHANG)
        if wpid != 0:
            child_status = status
    while True:
        readable, _, _ = select.select([fd], [], [], 0.1)
        if not readable:
            break
        try:
            chunk = os.read(fd, 8192)
        except OSError:
            break
        if not chunk:
            break
        buf += chunk
    if child_status is None:
        try:
            os.kill(pid, 15)
        except OSError:
            pass
        _, child_status = os.waitpid(pid, 0)
    sys.stdout.buffer.write(buf)
    if not sent:
        return 1
    if os.WIFEXITED(child_status) and os.WEXITSTATUS(child_status) == 0:
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
