import json
from pathlib import Path
import random
import string
import subprocess
import sys
import tempfile


scanner = sys.argv[1]
config = Path(__file__).resolve().parents[2] / ".gitleaks.toml"
sql = "UPDATE tasks SET status='waiting_credentials',waiting_reason='credentials'"


def scan(content):
    with tempfile.TemporaryDirectory(prefix="sidekick-secret-regression-") as directory:
        fixture = Path(directory) / "source"
        fixture.mkdir()
        (fixture / "app.ts").write_text(content)
        report = Path(directory) / "findings.json"
        result = subprocess.run(
            [
                scanner,
                "dir",
                "--no-banner",
                "--redact",
                "--config",
                str(config),
                "--report-format",
                "json",
                "--report-path",
                str(report),
                str(fixture),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        findings = json.loads(report.read_text()) if report.exists() else []
        return result.returncode, findings


code, findings = scan(sql)
if code != 0 or findings:
    raise SystemExit("The exact SQL status assignment must pass secret scanning.")

candidate = "".join(random.Random(271828).choices(string.ascii_letters + string.digits, k=64))
code, findings = scan(f'{sql}; api_key = "{candidate}"')
if code != 1 or not any(finding.get("RuleID") == "generic-api-key" for finding in findings):
    raise SystemExit("A generated secret beside the SQL assignment must fail secret scanning.")

print("Secret scanning configuration regression passed.")
