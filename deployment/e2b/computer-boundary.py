import json
import os
import pathlib
import socket
import subprocess
import time


def as_user(uid, args, timeout=15, env=None):
    def identity():
        os.setgroups([])
        os.setgid(uid)
        os.setuid(uid)
    return subprocess.run(["/usr/bin/setpriv", "--no-new-privs", *args], capture_output=True, timeout=timeout, preexec_fn=identity, env={"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/home/sidekick-browser" if uid == 1001 else "/home/node", "LANG": "C.UTF-8", **(env or {})})


def main():
    children = []
    try:
        pathlib.Path("/data/boundary-profile").mkdir(mode=0o700)
        os.chown("/data/boundary-profile", 1001, 1001)
        pathlib.Path("/data/boundary-private").write_text("synthetic-private")
        os.chown("/data/boundary-private", 1001, 1001)
        os.chmod("/data/boundary-private", 0o600)
        def browser():
            os.setgroups([])
            os.setgid(1001)
            os.setuid(1001)
        chromium = subprocess.Popen(["/usr/bin/chromium", "--headless", "--no-sandbox", "--disable-dev-shm-usage", "--remote-debugging-port=19222", "--remote-debugging-address=127.0.0.1", "--user-data-dir=/data/boundary-profile", "about:blank"], preexec_fn=browser, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        children.append(chromium)
        server = subprocess.Popen(["python3", "-c", "import socket,threading,time\ndef serve(family,address,port):\n s=socket.socket(family);s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)\n if family==socket.AF_INET6:s.setsockopt(socket.IPPROTO_IPV6,socket.IPV6_V6ONLY,1)\n s.bind((address,port));s.listen()\n while True:\n  c,_=s.accept();c.sendall(b'synthetic');c.close()\nfor family,address,port in [(socket.AF_INET,'0.0.0.0',19333),(socket.AF_INET6,'::',19333),(socket.AF_INET,'0.0.0.0',49983)]:threading.Thread(target=serve,args=(family,address,port),daemon=True).start()\ntime.sleep(120)"], preexec_fn=browser, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        children.append(server)
        authority = "/data/boundary.Xauthority"
        xauth = as_user(1001, ["xauth", "-f", authority, "add", ":107", ".", "0123456789abcdef0123456789abcdef"])
        assert xauth.returncode == 0
        os.chmod(authority, 0o600)
        display = subprocess.Popen(["Xvfb", ":107", "-screen", "0", "1280x800x24", "-nolisten", "tcp", "-auth", authority], preexec_fn=browser, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        children.append(display)
        until = time.monotonic() + 20
        while True:
            cdp = as_user(1001, ["curl", "--fail", "--silent", "--max-time", "2", "http://127.0.0.1:19222/json/version"])
            desktop = as_user(1001, ["xdotool", "getdisplaygeometry"], env={"DISPLAY": ":107", "XAUTHORITY": authority})
            if cdp.returncode == 0 and "Browser" in json.loads(cdp.stdout) and desktop.returncode == 0:
                break
            assert time.monotonic() < until
            time.sleep(0.1)
        addresses = json.loads(subprocess.check_output(["ip", "-json", "address", "show"]))
        own = next(item["local"] for interface in addresses if interface["ifname"] != "lo" for item in interface["addr_info"] if item["family"] == "inet")
        targets = [("127.0.0.1", 19222), ("::1", 19333), (own, 19333), ("169.254.169.254", 19333), ("fd00:ec2::254", 19333), ("127.0.0.1", 49983)]
        for host, port in targets:
            probe = f"import socket; s=socket.create_connection(({host!r},{port}),2); assert s.recv(100)"
            if port == 19222:
                probe = f"import socket; s=socket.create_connection(({host!r},{port}),2); s.close()"
            assert as_user(1001, ["python3", "-c", probe]).returncode == 0
            assert as_user(1000, ["python3", "-c", probe]).returncode != 0
        checks = [
            "from pathlib import Path; Path('/data/boundary-private').read_bytes()",
            "from pathlib import Path; Path('/data/boundary-profile').iterdir().__next__()",
            "import socket; s=socket.socket(socket.AF_UNIX); s.connect('/data/control.sock')",
            "import os; os.open('/opt/sidekick/workspace-command.py',os.O_WRONLY)",
            "import os; os.open('/app/src/providers/container-browser/worker.ts',os.O_WRONLY)",
            "import os; os.setuid(0)",
            f"import os; os.kill({chromium.pid},0)",
            f"from pathlib import Path; Path('/proc/{chromium.pid}/environ').read_bytes()",
        ]
        for script in checks:
            assert as_user(1000, ["python3", "-c", script]).returncode != 0
        assert as_user(1000, ["nft", "list", "ruleset"]).returncode != 0
        assert as_user(1000, ["xdotool", "getdisplaygeometry"], env={"DISPLAY": ":107", "XAUTHORITY": authority}).returncode != 0
        safe = as_user(1000, ["python3", "-c", "from pathlib import Path; import socket; s=Path('/proc/self/status').read_text(); assert 'NoNewPrivs:\\t1' in s; assert all(int(line.split()[1],16)==0 for line in s.splitlines() if line.startswith(('CapEff:','CapPrm:','CapAmb:'))); p=Path('/workspace/boundary.txt'); p.write_text('synthetic'); assert p.read_text()=='synthetic'; assert socket.getaddrinfo('example.com',443)"])
        assert safe.returncode == 0
        assert as_user(1000, ["curl", "--fail", "--silent", "--output", "/dev/null", "--max-time", "10", "https://example.com"]).returncode == 0
        assert subprocess.run(["python3", "/opt/sidekick/computer-guard.py", "check"], capture_output=True, timeout=20).returncode == 0
        subprocess.run(["nft", "delete", "table", "inet", "sidekick"], check=True, capture_output=True)
        assert subprocess.run(["python3", "/opt/sidekick/computer-guard.py", "check"], capture_output=True, timeout=20).returncode != 0
        print(json.dumps({"browserCdpAndX11": True, "workspaceNetworkDenied": len(targets), "workspaceFileAndProcessDenied": len(checks), "workspacePrivilegeDenied": True, "workspaceInternetDnsFiles": True, "changedFirewallRejected": True}))
    finally:
        for child in children:
            child.terminate()
        for child in children:
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=3)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print('{"passed":false}')
        raise SystemExit(1)
