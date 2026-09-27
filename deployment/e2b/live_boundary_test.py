import contextlib
import errno
import importlib.util
import io
import json
import pathlib
import signal
import socket
import types
import unittest
import tempfile
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("live_boundary", pathlib.Path(__file__).with_name("live-boundary.py"))
boundary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boundary)


class BoundaryTests(unittest.TestCase):
    def test_actual_interfaces_without_added_metadata_addresses(self):
        targets, counts = boundary.addresses(json.dumps([
            {"ifindex": 1, "addr_info": [{"local": "127.0.0.1"}, {"local": "::1"}]},
            {"ifindex": 2, "addr_info": [{"local": "192.0.2.7"}]},
        ]))
        self.assertEqual(targets, [(socket.AF_INET, "127.0.0.1", 0), (socket.AF_INET6, "::1", 0), (socket.AF_INET, "192.0.2.7", 0)])
        self.assertEqual(counts, {4: 1, 6: 0})

    def test_ipv6_link_local_targets_keep_the_interface_scope(self):
        targets, counts = boundary.addresses(json.dumps([
            {"ifindex": 3, "addr_info": [{"local": "fe80::1"}, {"local": "2001:db8::1"}]},
            {"ifindex": 4, "addr_info": [{"local": "fe80::1"}, {"local": "2001:db8::1"}]},
        ]))
        self.assertEqual(targets[2:], [(socket.AF_INET6, "fe80::1", 3), (socket.AF_INET6, "2001:db8::1", 0), (socket.AF_INET6, "fe80::1", 4)])
        self.assertEqual(counts, {4: 0, 6: 3})

    def test_excessive_and_unusable_targets_fail_closed(self):
        values = [
            [{"ifindex": 2, "addr_info": [{"local": "192.0.2." + str(index)} for index in range(1, 18)]}],
            [{"ifindex": 2, "addr_info": [{"local": "0.0.0.0"}]}],
            [{"ifindex": 2, "addr_info": [{"local": "ff02::1"}]}],
        ]
        for value in values:
            with self.subTest(value=value), self.assertRaises(boundary.BoundaryFailure):
                boundary.addresses(json.dumps(value))

    def test_envd_positive_opens_tcp_without_any_protocol_payload(self):
        calls = []

        class Connection:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                calls.append("close")

            def settimeout(self, value):
                calls.append(("timeout", value))

            def connect(self, target):
                calls.append(("connect", target))

        source = boundary.tcp_source((socket.AF_INET, "127.0.0.1", 0), 49983)
        with patch.object(socket, "socket", return_value=Connection()):
            exec(source, {})
        self.assertEqual(calls, [("timeout", 2), ("connect", ("127.0.0.1", 49983)), "close"])

    def test_denial_does_not_accept_a_missing_private_path(self):
        for code in [errno.EACCES, errno.EPERM]:
            exec(boundary.denial_source(f"raise OSError({code},'synthetic')"), {})
        for code in [errno.ENOENT, errno.EIO]:
            with self.assertRaises(AssertionError):
                exec(boundary.denial_source(f"raise OSError({code},'synthetic')"), {})
        with self.assertRaises(AssertionError):
            exec(boundary.denial_source("pass"), {})

    def test_network_timeout_is_not_accepted_as_a_denial(self):
        class Connection:
            def settimeout(self, _value):
                pass

            def connect(self, _target):
                raise TimeoutError()

            def close(self):
                pass

        source = boundary.tcp_source((socket.AF_INET6, "::1", 0), 19000, denied=True)
        with patch.object(socket, "socket", return_value=Connection()), self.assertRaises(AssertionError):
            exec(source, {})

    def test_child_environment_does_not_inherit_operator_values(self):
        with patch.dict("os.environ", {"E2B_API_KEY": "synthetic-private-key", "HOME": "/root"}):
            value = boundary.environment(1000)
        self.assertEqual(value, {"PATH": "/usr/local/bin:/usr/bin:/bin:/usr/sbin", "HOME": "/home/node", "LANG": "C.UTF-8"})

    def test_cleanup_kills_an_adopted_child_outside_the_original_group(self):
        processes = boundary.Processes()
        child = types.SimpleNamespace(pid=11, returncode=None, stdout=None, stderr=None)
        processes.children.append(child)
        streams = [io.BytesIO(b"11 12"), io.BytesIO(b"")]
        statuses = [(11, 0), (0, 0), (12, 0), (0, 0)]
        with patch.object(boundary.pathlib.Path, "open", side_effect=streams), patch.object(boundary.os, "waitid", side_effect=lambda _kind, pid, _flags: None if pid == 12 else object()), patch.object(boundary.os, "waitpid", side_effect=statuses), patch.object(boundary.os, "killpg") as group_kill, patch.object(boundary.os, "kill") as process_kill, patch.object(boundary.time, "sleep"):
            self.assertTrue(processes.cleanup())
        self.assertEqual(group_kill.call_args_list, [unittest.mock.call(11, signal.SIGTERM), unittest.mock.call(11, signal.SIGKILL)])
        process_kill.assert_called_once_with(12, signal.SIGKILL)
        self.assertEqual(processes.children, [])

    def test_x11_denial_requires_browser_access_before_and_after(self):
        processes = boundary.Processes()
        display = object()
        environment = {"DISPLAY": ":107", "XAUTHORITY": "/synthetic/Xauthority"}
        with patch.object(processes, "running", return_value=True) as running, patch.object(processes, "run", side_effect=[(0, b"1280 800\n", b""), (1, b"", b"denied"), (0, b"1280 800\n", b"")]) as run:
            boundary.check_x11(processes, environment, display)
        self.assertEqual([call.args[0] for call in run.call_args_list], [1001, 1000, 1001])
        self.assertEqual(running.call_args_list, [unittest.mock.call(display)] * 4)
        for call in run.call_args_list:
            self.assertEqual(call.args[1:], (["/usr/bin/xdotool", "getdisplaygeometry"], 3, environment))

    def test_x11_denial_does_not_pass_after_display_dies_or_browser_loses_access(self):
        for states, results in [
            ([True, True, False], [(0, b"1280 800\n", b""), (1, b"", b"unavailable")]),
            ([True] * 4, [(0, b"1280 800\n", b""), (1, b"", b"denied"), (1, b"", b"unavailable")]),
            ([True, True, True, False], [(0, b"1280 800\n", b""), (1, b"", b"denied"), (0, b"1280 800\n", b"")]),
        ]:
            processes = boundary.Processes()
            with self.subTest(states=states), patch.object(processes, "running", side_effect=states), patch.object(processes, "run", side_effect=results), self.assertRaisesRegex(boundary.BoundaryFailure, "browser-readiness"):
                boundary.check_x11(processes, {}, object())

    def test_cleanup_requires_both_owned_display_paths_absent_after_process_drain(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = [pathlib.Path(directory) / ".X107-lock", pathlib.Path(directory) / "X107"]
            processes = boundary.Processes()
            processes.display_paths.extend(paths)
            with patch.object(boundary.pathlib.Path, "open", side_effect=lambda *_args: io.BytesIO(b"")), patch.object(boundary.os, "waitpid", side_effect=ChildProcessError):
                self.assertTrue(processes.cleanup())
                for path in paths:
                    path.touch()
                    with self.subTest(path=path.name):
                        self.assertFalse(processes.cleanup())
                        self.assertTrue(path.exists())
                        self.assertEqual(processes.children, [])
                    path.unlink()
                self.assertTrue(processes.cleanup())

    def test_failure_output_cannot_include_exception_content(self):
        for error in [RuntimeError("synthetic-private-key"), boundary.BoundaryFailure("synthetic-private-key")]:
            output = io.StringIO()
            with patch.object(boundary, "probe", side_effect=error), patch.object(boundary.Processes, "cleanup", return_value=True), patch.object(boundary.signal, "signal"), patch.object(boundary.signal, "alarm"), contextlib.redirect_stdout(output):
                self.assertEqual(boundary.main(), 1)
            self.assertEqual(json.loads(output.getvalue()), {"passed": False, "version": 1, "check": "probe-error", "cleanupComplete": True})

    def test_cleanup_failure_prevents_a_success_receipt(self):
        output = io.StringIO()
        with patch.object(boundary, "probe", return_value={"passed": True}), patch.object(boundary.Processes, "cleanup", return_value=False), patch.object(boundary.signal, "signal"), patch.object(boundary.signal, "alarm"), contextlib.redirect_stdout(output):
            self.assertEqual(boundary.main(), 1)
        self.assertEqual(json.loads(output.getvalue()), {"passed": False, "version": 1, "check": "cleanup", "cleanupComplete": False})


if __name__ == "__main__":
    unittest.main()
