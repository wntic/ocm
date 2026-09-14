# Fixture for test/phase16-trust-flow.mjs — invoked as
# `python3 ocm-pty.py <mode> <cmd> [args...]`; not run by bun test itself.
#
# The trust-prompt paths need a real TTY (spawned stdio is never one), and the
# interrupt summary must be captured on stderr separately from the pty, so the
# test runs ocm under a python-allocated pty with stderr on a pipe. When the
# trust prompt appears on stderr, mode "sigint" kills the ocm pid — a direct
# kill, because readline's raw mode would swallow a typed ^C — and any other
# mode is written to the pty as the answer ("n\r" works in raw and canonical
# mode alike).
#
# Prints one JSON document: status (negative = signal), acted (the prompt was
# seen and answered), timed_out, and both captured streams.
import fcntl, json, os, pty, select, signal, sys, termios, time

mode, cmd = sys.argv[1], sys.argv[2:]
master, slave = pty.openpty(); err_r, err_w = os.pipe(); pid = os.fork()
if pid == 0:
    os.setsid(); fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    os.dup2(slave, 0); os.dup2(slave, 1); os.dup2(err_w, 2)
    os.close(master); os.close(err_r); os.execvp(cmd[0], cmd)
os.close(slave); os.close(err_w)
PROMPT, deadline, acted, timed_out = b"trust this marketplace", time.time() + 60, False, False
stderr = stdout = b""; fds = {master: "out", err_r: "err"}
while fds:
    if time.time() > deadline: timed_out = True; os.kill(pid, signal.SIGKILL); break
    for fd in select.select(list(fds), [], [], 1.0)[0]:
        try: data = os.read(fd, 65536)
        except OSError: data = b""
        if fds[fd] == "err":
            stderr += data
            if not acted and PROMPT in stderr:
                acted = True
                os.kill(pid, signal.SIGINT) if mode == "sigint" else os.write(master, mode.encode())
        else: stdout += data
        if not data: os.close(fd); del fds[fd]
_, ws = os.waitpid(pid, 0)
status = -(ws & 0x7f) or (ws >> 8)
print(json.dumps({"status": status, "acted": acted, "timed_out": timed_out, "stderr": stderr.decode("utf-8", "replace"), "stdout": stdout.decode("utf-8", "replace")}))
