#!/usr/bin/env python3
"""Exercise /help, /keys, /model, and /plain in the real Copix REPL."""
import os
import select
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    import pty

    home = sys.argv[1]
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(ROOT)
        env = os.environ.copy()
        env["TERM"] = "xterm-256color"
        env["HOME"] = home
        env.pop("NO_COLOR", None)
        os.execvpe("node", ["node", os.path.join(ROOT, "bin", "copix.js")], env)

    buf = b""
    child_status = None

    def pull(timeout):
        nonlocal buf, child_status
        deadline = time.time() + timeout
        while time.time() < deadline and child_status is None:
            readable, _, _ = select.select([fd], [], [], 0.1)
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

    def send(data):
        os.write(fd, data)
        pull(0.2)

    if not pull(12) and b"Ask, plan, build anything" not in buf:
        sys.stdout.buffer.write(buf)
        return 1
    # Wait until the prompt is actually on screen.
    deadline = time.time() + 12
    while b"Ask, plan, build anything" not in buf and time.time() < deadline:
        if not pull(0.2):
            break

    send(b"/")
    pull(0.4)
    send(b"\x15")  # Ctrl+U, clear the slash menu
    pull(0.2)
    send(b"/help\r")
    pull(0.5)
    send(b"/keys\r")
    pull(0.5)
    send(b"/model\r")
    pull(0.5)
    send(b"\x1b[B\r")
    pull(0.6)
    send(b"/plain on\r")
    pull(0.4)
    send(b"/help\r")
    pull(0.4)
    send(b"/model\r")
    pull(0.4)
    send(b"\r")
    pull(0.4)
    send(b"/exit\r")
    pull(3)
    if child_status is None:
        try:
            os.kill(pid, 15)
        except OSError:
            pass
        _, child_status = os.waitpid(pid, 0)

    text = buf.decode("utf-8", "replace")
    needles = [
        "Pick a model, or pin a tag",
        "Toggle screen-reader plain text",
        "pick a model",
        "/keys",
        "/plain",
        "Model picker",
        "route by task",
        "qwen2.5:3b",
        "Plain text is on",
        "Help:",
        "Choose a number or name",
        "Model unchanged",
    ]
    pos = 0
    missing = []
    for needle in needles:
        found = text.find(needle, pos)
        if found < 0:
            missing.append(needle)
        else:
            pos = found + 1
    if missing or not (os.WIFEXITED(child_status) and os.WEXITSTATUS(child_status) == 0):
        sys.stdout.buffer.write(buf)
        sys.stderr.write("missing: " + ", ".join(missing) + "\n")
        sys.stderr.write(f"status: {child_status}\n")
        return 1
    sys.stderr.write("repl flow ok\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
