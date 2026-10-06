#!/usr/bin/env python3
"""Check Ctrl+C clears a typed prompt and quits only when the line is empty."""
import os
import select
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    import pty

    mode = sys.argv[1]
    kind = "plain" if mode.startswith("plain") else "raw"
    empty = mode.endswith("empty")
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(ROOT)
        env = os.environ.copy()
        env["TERM"] = "xterm-256color"
        env.pop("NO_COLOR", None)
        os.execvpe(
            "node",
            ["node", os.path.join(ROOT, "scripts", "prompt-fixture.mjs"), kind],
            env,
        )

    buf = b""
    child_status = None

    def pull(timeout):
        nonlocal buf, child_status
        deadline = time.time() + timeout
        while time.time() < deadline and child_status is None:
            readable, _, _ = select.select([fd], [], [], 0.05)
            if readable:
                try:
                    chunk = os.read(fd, 8192)
                except OSError:
                    chunk = b""
                if not chunk:
                    break
                buf += chunk
            wpid, status = os.waitpid(pid, os.WNOHANG)
            if wpid != 0:
                child_status = status
                break
        return child_status is None

    if not pull(2) and b"ready" not in buf:
        sys.stdout.buffer.write(buf)
        return 1
    while b"ready" not in buf and child_status is None:
        if not pull(0.2):
            break
    if empty:
        os.write(fd, b"\x03")
        pull(2)
    else:
        os.write(fd, b"hello")
        pull(0.3)
        os.write(fd, b"\x03")
        pull(0.4)
        if b"LINE:" in buf or child_status is not None:
            sys.stdout.buffer.write(buf)
            sys.stderr.write("Ctrl+C quit while the line still had text\n")
            return 1
        os.write(fd, b"\x03")
        pull(2)
    if child_status is None:
        try:
            os.kill(pid, 15)
        except OSError:
            pass
        _, child_status = os.waitpid(pid, 0)
    sys.stdout.buffer.write(buf)
    if b"LINE:null" not in buf:
        sys.stderr.write("empty Ctrl+C did not quit\n")
        return 1
    if not (os.WIFEXITED(child_status) and os.WEXITSTATUS(child_status) == 0):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
