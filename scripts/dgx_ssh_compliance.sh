#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

python3 - "$ROOT_DIR" "$@" <<'PY'
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pwd
import re
import signal
import shutil
import socket
import stat
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Mac-side DGX SSH compliance checks")
    parser.add_argument("--json", action="store_true", help="Print compliance payload JSON to stdout")
    return parser.parse_args(sys.argv[2:])


def source_contract_env(contract_path: Path) -> dict[str, str]:
    if not contract_path.exists():
        return {}
    try:
        raw = contract_path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return {}
    values: dict[str, str] = {}
    for raw_line in raw.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        key, val = line.split("=", 1)
        key = key.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        value = val.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        values[key] = value
    return values


def env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def parse_int(raw: str, default: int) -> int:
    try:
        return int(raw.strip())
    except Exception:
        return default


def parse_mode(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, int):
        return value
    text = str(value).strip()
    if not text:
        return None
    try:
        if re.fullmatch(r"[0-7]{3,4}", text):
            return int(text, 8)
        return int(text, 10)
    except Exception:
        return None


def clip(text: str, limit: int = 400) -> str:
    if len(text) <= limit:
        return text
    return f"{text[:limit]}...[truncated]"


def has_network_error(text: str) -> bool:
    lowered = text.lower()
    patterns = (
        "connection timed out",
        "operation timed out",
        "no route to host",
        "name or service not known",
        "could not resolve hostname",
        "connection refused",
        "network is unreachable",
        "host is down",
    )
    return any(p in lowered for p in patterns)


def has_forwarding_error(text: str) -> bool:
    return bool((text or "").strip())


def looks_like_forced_command_json(text: str) -> bool:
    stripped = text.strip()
    if not stripped:
        return False
    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError:
        return False
    return isinstance(parsed, dict) and "error" in parsed


def deterministic_failure_envelope(payload: dict[str, Any]) -> bool:
    required = {"ok", "operation", "requestId", "exitCode", "durationMs", "stdout", "stderr", "remote", "error"}
    if not required.issubset(payload.keys()):
        return False
    remote = payload.get("remote")
    error = payload.get("error")
    if not isinstance(remote, dict) or not isinstance(error, dict):
        return False
    remote_required = {"host", "user", "dispatcherVersion"}
    error_required = {"code", "message"}
    return remote_required.issubset(remote.keys()) and error_required.issubset(error.keys())


def main() -> int:
    root = Path(sys.argv[1]).resolve()
    args = parse_args()

    contract_path = Path(os.environ.get("OPENCLAW_CONTRACT") or (root / "config" / "workspace.env"))
    if not contract_path.exists():
        contract_path = root / "config" / "workspace.env.example"
    contract_env = source_contract_env(contract_path)

    def cfg(name: str, default: str = "") -> str:
        env_val = os.environ.get(name)
        if env_val is not None and env_val != "":
            return env_val
        contract_val = contract_env.get(name)
        if contract_val is not None and contract_val != "":
            return contract_val
        return default

    reports_dir = Path(os.path.expanduser(cfg("DGX_SSH_REPORTS_DIR", str(root / "reports")))).resolve()
    reports_dir.mkdir(parents=True, exist_ok=True)

    check_results: list[dict[str, Any]] = []
    checked_at = dt.datetime.now(dt.timezone.utc)
    now_epoch = int(time.time())

    def add_check(check_id: str, status: str, severity: str, message: str, evidence: dict[str, Any] | None = None) -> None:
        check_results.append(
            {
                "id": check_id,
                "status": status,
                "severity": severity,
                "message": message,
                "evidence": evidence or {},
                "checkedAt": checked_at.isoformat(),
            }
        )

    ssh_host = cfg("DGX_SSH_HOST", cfg("DGX_HOST", "")).strip()
    ssh_user = cfg("DGX_SSH_USER", "dgx-aii").strip()
    ssh_port = parse_int(cfg("DGX_SSH_PORT", "22"), 22)
    key_path = Path(os.path.expanduser(cfg("DGX_SSH_KEY_PATH", "~/.ssh/dgx_spark_tool_ed25519")))
    pub_key_path = Path(f"{key_path}.pub")
    known_hosts_path = Path(os.path.expanduser(cfg("DGX_SSH_KNOWN_HOSTS", "~/.ssh/known_hosts_dgx_spark_tool")))
    cursor_key_raw = cfg("DGX_SSH_CURSOR_KEY_PATH", "").strip()
    cursor_key_path = Path(os.path.expanduser(cursor_key_raw)) if cursor_key_raw else None
    cursor_known_hosts_raw = cfg("DGX_SSH_CURSOR_KNOWN_HOSTS", "").strip()
    cursor_known_hosts_path = Path(os.path.expanduser(cursor_known_hosts_raw)) if cursor_known_hosts_raw else known_hosts_path
    verify_cursor_forwarding = env_bool("DGX_SSH_VERIFY_CURSOR_FORWARDING", False)
    strict_hostkey = env_bool("DGX_SSH_STRICT_HOSTKEY", True)
    wrapper_path = root / "skills" / "dgx-spark-ssh" / "scripts" / "dgx_ssh_tool.py"
    expected_sha = cfg(
        "DGX_SSH_EXPECTED_DISPATCHER_SHA256",
        "16b5f8e9b6e20971d92c00878181022cfa04316dc3db9ac8bd2d52f1fa3fdcce",
    )
    forwarding_policy = cfg("DGX_SSH_FORWARDING_POLICY_MODE", "key_scoped").strip().lower()
    if forwarding_policy not in {"server_blocked", "key_scoped"}:
        forwarding_policy = "key_scoped"
    current_user = pwd.getpwuid(os.getuid()).pw_name

    def check_file_owner_mode(
        check_id: str,
        path: Path,
        allowed_modes: set[int],
        mode_failure_status: str,
        missing_status: str,
    ) -> None:
        if not path.exists():
            add_check(
                check_id,
                missing_status,
                "high" if missing_status == "fail" else "medium",
                f"Required file missing: {path}",
                {"path": str(path)},
            )
            return
        st = path.stat()
        owner = pwd.getpwuid(st.st_uid).pw_name
        mode = stat.S_IMODE(st.st_mode)
        mode_text = f"{mode:03o}"
        if owner != current_user:
            add_check(
                check_id,
                "fail",
                "high",
                f"Owner mismatch for {path}: expected {current_user}, got {owner}",
                {"path": str(path), "owner": owner, "mode": mode_text},
            )
            return
        if mode not in allowed_modes:
            add_check(
                check_id,
                mode_failure_status,
                "medium" if mode_failure_status == "warn" else "high",
                f"Mode for {path} is {mode_text}, expected one of {sorted({f'{m:03o}' for m in allowed_modes})}",
                {"path": str(path), "owner": owner, "mode": mode_text},
            )
            return
        add_check(
            check_id,
            "pass",
            "low",
            f"Owner/mode OK for {path}",
            {"path": str(path), "owner": owner, "mode": mode_text},
        )

    check_file_owner_mode("mac.key.private", key_path, {0o400, 0o600}, "fail", "fail")
    check_file_owner_mode("mac.key.public", pub_key_path, {0o400, 0o600, 0o644}, "warn", "warn")
    check_file_owner_mode("mac.known_hosts.pin", known_hosts_path, {0o400, 0o600}, "fail", "fail")

    wrapper_env = os.environ.copy()
    wrapper_env["DGX_SSH_ENABLED"] = "1"
    if ssh_host:
        wrapper_env["DGX_SSH_HOST"] = ssh_host
    if ssh_user:
        wrapper_env["DGX_SSH_USER"] = ssh_user
    wrapper_env["DGX_SSH_PORT"] = str(ssh_port)
    wrapper_env["DGX_SSH_KEY_PATH"] = str(key_path)
    wrapper_env["DGX_SSH_KNOWN_HOSTS"] = str(known_hosts_path)
    wrapper_env["DGX_SSH_STRICT_HOSTKEY"] = "1" if strict_hostkey else "0"

    def run_wrapper(request_payload: dict[str, Any]) -> tuple[int, dict[str, Any] | None, str]:
        try:
            proc = subprocess.run(
                ["python3", str(wrapper_path), "--request", "-"],
                input=json.dumps(request_payload),
                text=True,
                capture_output=True,
                timeout=30,
                env=wrapper_env,
                check=False,
            )
        except Exception as exc:
            return 2, None, str(exc)
        combined = f"{proc.stdout}\n{proc.stderr}".strip()
        parsed: dict[str, Any] | None
        try:
            parsed = json.loads(proc.stdout)
            if not isinstance(parsed, dict):
                parsed = None
        except Exception:
            parsed = None
        return proc.returncode, parsed, combined

    unknown_inconclusive_error_codes = {
        "dependency_missing",
        "remote_empty",
        "ssh_timeout",
        "ssh_spawn_failed",
        "ssh_auth_failed",
    }

    unknown_rc, unknown_payload, unknown_raw = run_wrapper(
        {"operation": "nope.operation", "requestId": "compliance-unknown-op"}
    )
    if unknown_payload and deterministic_failure_envelope(unknown_payload):
        code = str(((unknown_payload.get("error") or {}).get("code") or "")).strip()
        if code == "invalid_operation":
            add_check(
                "wrapper.unknown_operation",
                "pass",
                "low",
                "Unknown operation is deterministically denied",
                {"exitCode": unknown_rc, "errorCode": code},
            )
        elif code in unknown_inconclusive_error_codes:
            add_check(
                "wrapper.unknown_operation",
                "warn",
                "medium",
                "Unknown operation check is inconclusive (wrapper/remote path unavailable)",
                {"exitCode": unknown_rc, "errorCode": code, "raw": clip(unknown_raw)},
            )
        else:
            add_check(
                "wrapper.unknown_operation",
                "fail",
                "high",
                f"Unexpected error code for unknown operation: {code or '<missing>'}",
                {"exitCode": unknown_rc, "raw": clip(unknown_raw)},
            )
    else:
        add_check(
            "wrapper.unknown_operation",
            "fail",
            "high",
            "Unknown operation did not return deterministic failure envelope",
            {"exitCode": unknown_rc, "raw": clip(unknown_raw)},
        )

    disallowed_rc, disallowed_payload, disallowed_raw = run_wrapper(
        {"operation": "service.status", "requestId": "compliance-disallowed-unit", "args": {"unit": "sshd.service"}}
    )
    allowed_error_codes = {"schema_validation", "unit_not_allowed", "invalid_args", "invalid_request"}
    inconclusive_error_codes = {"dependency_missing", "remote_empty", "ssh_timeout", "ssh_spawn_failed", "ssh_auth_failed"}
    if disallowed_payload and deterministic_failure_envelope(disallowed_payload):
        code = str(((disallowed_payload.get("error") or {}).get("code") or "")).strip()
        if code in allowed_error_codes:
            add_check(
                "wrapper.disallowed_unit",
                "pass",
                "low",
                "Disallowed unit is deterministically denied",
                {"exitCode": disallowed_rc, "errorCode": code},
            )
        elif code in inconclusive_error_codes:
            add_check(
                "wrapper.disallowed_unit",
                "warn",
                "medium",
                "Disallowed unit check is inconclusive (remote path unavailable); deterministic deny could not be verified",
                {"exitCode": disallowed_rc, "errorCode": code, "raw": clip(disallowed_raw)},
            )
        else:
            add_check(
                "wrapper.disallowed_unit",
                "fail",
                "high",
                f"Disallowed unit returned unexpected error code: {code or '<missing>'}",
                {"exitCode": disallowed_rc, "raw": clip(disallowed_raw)},
            )
    else:
        add_check(
            "wrapper.disallowed_unit",
            "fail",
            "high",
            "Disallowed unit check did not return deterministic failure envelope",
            {"exitCode": disallowed_rc, "raw": clip(disallowed_raw)},
        )

    warn_days = parse_int(cfg("DGX_SSH_REVIEW_WARN_DAYS", "75"), 75)
    fail_days = parse_int(cfg("DGX_SSH_REVIEW_FAIL_DAYS", "90"), 90)
    if fail_days < warn_days:
        fail_days = warn_days

    key_age_days: int | None = None
    if key_path.exists():
        key_age_days = (now_epoch - int(key_path.stat().st_mtime)) // 86400

    review_date_raw = cfg("DGX_SSH_LAST_REVIEW_DATE", "").strip()
    review_age_days: int | None = None
    review_date_error = ""
    if review_date_raw and review_date_raw != "YYYY-MM-DD":
        try:
            parsed_review = dt.date.fromisoformat(review_date_raw)
            review_age_days = (checked_at.date() - parsed_review).days
            if review_age_days < 0:
                review_date_error = "review date is in the future"
                review_age_days = None
        except Exception:
            review_date_error = "invalid ISO date format"

    age_source = ""
    age_days: int | None = None
    if review_age_days is not None:
        age_days = review_age_days
        age_source = "last_review_date"
    elif key_age_days is not None:
        age_days = key_age_days
        age_source = "private_key_mtime"

    rotation_warn = False
    rotation_fail = False
    if review_date_error:
        add_check(
            "rotation.review_date",
            "warn",
            "medium",
            f"DGX_SSH_LAST_REVIEW_DATE is unusable: {review_date_error}",
            {"value": review_date_raw},
        )
    elif not review_date_raw or review_date_raw == "YYYY-MM-DD":
        add_check(
            "rotation.review_date",
            "warn",
            "medium",
            "DGX_SSH_LAST_REVIEW_DATE is not set",
            {"value": review_date_raw or ""},
        )
    else:
        add_check(
            "rotation.review_date",
            "pass",
            "low",
            "DGX_SSH_LAST_REVIEW_DATE is set",
            {"value": review_date_raw},
        )

    if age_days is None:
        add_check(
            "rotation.policy",
            "warn",
            "medium",
            "Rotation age could not be computed from review date or key mtime",
            {"reviewDate": review_date_raw, "keyAgeDays": key_age_days},
        )
    elif age_days >= fail_days:
        rotation_warn = True
        rotation_fail = True
        add_check(
            "rotation.policy",
            "fail",
            "high",
            f"Rotation age {age_days}d exceeds fail threshold {fail_days}d",
            {"ageDays": age_days, "warnDays": warn_days, "failDays": fail_days, "source": age_source},
        )
    elif age_days >= warn_days:
        rotation_warn = True
        add_check(
            "rotation.policy",
            "warn",
            "medium",
            f"Rotation age {age_days}d exceeds warning threshold {warn_days}d",
            {"ageDays": age_days, "warnDays": warn_days, "failDays": fail_days, "source": age_source},
        )
    else:
        add_check(
            "rotation.policy",
            "pass",
            "low",
            f"Rotation age {age_days}d is within policy",
            {"ageDays": age_days, "warnDays": warn_days, "failDays": fail_days, "source": age_source},
        )

    remote_evidence_path = Path(
        os.path.expanduser(cfg("DGX_SSH_REMOTE_EVIDENCE_PATH", str(reports_dir / "dgx-ssh-remote-evidence-latest.json")))
    )
    max_age_hours = parse_int(cfg("DGX_SSH_REMOTE_EVIDENCE_MAX_AGE_HOURS", "168"), 168)
    remote_state = "missing"
    remote_data: dict[str, Any] = {}
    remote_age_hours: int | None = None
    remote_error = ""

    if remote_evidence_path.exists():
        try:
            remote_raw = remote_evidence_path.read_text(encoding="utf-8")
            parsed_remote = json.loads(remote_raw)
            if not isinstance(parsed_remote, dict):
                raise ValueError("root must be an object")
            remote_data = parsed_remote
            remote_age_hours = max(0, int((now_epoch - int(remote_evidence_path.stat().st_mtime)) // 3600))
            if remote_age_hours > max_age_hours:
                remote_state = "stale"
            else:
                remote_state = "fresh"
        except Exception as exc:
            remote_state = "malformed"
            remote_error = str(exc)

    def add_remote_check(check_id: str, condition: bool, message: str, evidence: dict[str, Any]) -> None:
        if remote_state == "missing":
            add_check(
                check_id,
                "pending_remote_enforcement",
                "medium",
                "Remote evidence missing; Spark-side verification pending",
                {"path": str(remote_evidence_path)},
            )
            return
        if remote_state == "malformed":
            add_check(
                check_id,
                "warn",
                "medium",
                f"Remote evidence malformed: {remote_error}",
                {"path": str(remote_evidence_path)},
            )
            return
        if remote_state == "stale":
            add_check(
                check_id,
                "warn",
                "medium",
                f"Remote evidence is stale ({remote_age_hours}h old, max {max_age_hours}h)",
                {"path": str(remote_evidence_path), "ageHours": remote_age_hours, "maxAgeHours": max_age_hours},
            )
            return
        if condition:
            add_check(check_id, "pass", "low", "Remote evidence check passed", evidence)
        else:
            add_check(check_id, "fail", "high", message, evidence)

    owner_value = str(remote_data.get("forcedCommandOwner", "")).strip()
    mode_value = remote_data.get("forcedCommandMode")
    mode_parsed = parse_mode(mode_value)
    mode_secure = mode_parsed is not None and (mode_parsed & 0o022) == 0

    add_remote_check(
        "remote.authorized_key_normalized",
        remote_data.get("authorizedKeyNormalized") is True,
        "Remote evidence reports authorized key normalization as false",
        {"value": remote_data.get("authorizedKeyNormalized")},
    )
    add_remote_check(
        "remote.duplicate_fingerprint_absent",
        remote_data.get("duplicateFingerprintFound") is False,
        "Remote evidence reports duplicate authorized_keys fingerprint entries",
        {"value": remote_data.get("duplicateFingerprintFound")},
    )
    add_remote_check(
        "remote.match_user_override_absent",
        remote_data.get("matchUserOverrideDetected") is False,
        "Remote evidence reports Match User override that can affect tool-user policy",
        {"value": remote_data.get("matchUserOverrideDetected")},
    )
    add_remote_check(
        "remote.forced_command_owner",
        owner_value == "root:root",
        "Forced-command binary owner is not root:root",
        {"value": owner_value},
    )
    add_remote_check(
        "remote.forced_command_mode",
        mode_secure,
        "Forced-command binary mode allows group/other write",
        {"value": mode_value},
    )
    add_remote_check(
        "remote.dispatcher_checksum",
        str(remote_data.get("dispatcherSha256", "")).strip().lower() == expected_sha.lower(),
        "Dispatcher checksum does not match expected SHA256",
        {"value": remote_data.get("dispatcherSha256"), "expected": expected_sha},
    )
    if forwarding_policy == "server_blocked":
        add_remote_check(
            "remote.forwarding_policy",
            remote_data.get("forwardingBlockedServerSide") is True,
            "Remote evidence reports forwarding is not blocked server-wide",
            {"policyMode": forwarding_policy, "value": remote_data.get("forwardingBlockedServerSide")},
        )
    else:
        tool_key_forwarding_blocked = remote_data.get("toolKeyForwardingBlocked")
        if tool_key_forwarding_blocked is None:
            tool_key_forwarding_blocked = remote_data.get("forwardingBlockedServerSide")
        add_remote_check(
            "remote.forwarding_policy",
            tool_key_forwarding_blocked is True,
            "Remote evidence reports tool key forwarding is not blocked",
            {
                "policyMode": forwarding_policy,
                "toolKeyForwardingBlocked": tool_key_forwarding_blocked,
                "serverWideForwardingBlocked": remote_data.get("forwardingBlockedServerSide"),
            },
        )
        cursor_lan_value = remote_data.get("cursorForwardingAllowedLan")
        if cursor_lan_value is None:
            add_check(
                "remote.cursor_forwarding_lan",
                "warn",
                "medium",
                "Remote evidence does not assert LAN forwarding allowance for non-Jarvis keys",
                {"policyMode": forwarding_policy},
            )
        else:
            add_remote_check(
                "remote.cursor_forwarding_lan",
                cursor_lan_value is True,
                "Remote evidence reports non-Jarvis LAN forwarding is not allowed",
                {"policyMode": forwarding_policy, "value": cursor_lan_value},
            )
    add_remote_check(
        "remote.non_interactive_server",
        remote_data.get("nonInteractiveServerSide") is True,
        "Remote evidence reports non-interactive enforcement is not active",
        {"value": remote_data.get("nonInteractiveServerSide")},
    )

    skip_probes = env_bool("DGX_SSH_COMPLIANCE_SKIP_PROBES", False)
    ssh_bin = cfg("DGX_SSH_BIN", "ssh").strip() or "ssh"

    def run_noninteractive_probe() -> tuple[int, str, str]:
        if os.environ.get("DGX_SSH_COMPLIANCE_TEST_NONINTERACTIVE_RC") is not None:
            rc = parse_int(os.environ.get("DGX_SSH_COMPLIANCE_TEST_NONINTERACTIVE_RC", "1"), 1)
            stdout = os.environ.get("DGX_SSH_COMPLIANCE_TEST_NONINTERACTIVE_STDOUT", "")
            stderr = os.environ.get("DGX_SSH_COMPLIANCE_TEST_NONINTERACTIVE_STDERR", "")
            return rc, stdout, stderr
        cmd = [
            ssh_bin,
            "-F",
            "/dev/null",
            "-T",
            "-p",
            str(ssh_port),
            "-i",
            str(key_path),
            "-o",
            "BatchMode=yes",
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "ConnectTimeout=5",
            "-o",
            "StrictHostKeyChecking=yes" if strict_hostkey else "StrictHostKeyChecking=accept-new",
            "-o",
            f"UserKnownHostsFile={known_hosts_path}",
            f"{ssh_user}@{ssh_host}",
            "id",
        ]
        proc = subprocess.run(cmd, text=True, capture_output=True, timeout=15, check=False)
        return proc.returncode, proc.stdout, proc.stderr

    def run_forward_probe(
        port: int, probe_key_path: Path | None = None, probe_known_hosts_path: Path | None = None
    ) -> tuple[int, str, bool, int | None]:
        if os.environ.get("DGX_SSH_COMPLIANCE_TEST_FORWARD_RC") is not None:
            rc = parse_int(os.environ.get("DGX_SSH_COMPLIANCE_TEST_FORWARD_RC", "1"), 1)
            stderr = os.environ.get("DGX_SSH_COMPLIANCE_TEST_FORWARD_STDERR", "")
            listener = env_bool("DGX_SSH_COMPLIANCE_TEST_FORWARD_LISTENER", False)
            return rc, stderr, listener, None
        key_for_probe = probe_key_path or key_path
        known_hosts_for_probe = probe_known_hosts_path or known_hosts_path
        cmd = [
            ssh_bin,
            "-F",
            "/dev/null",
            "-T",
            "-N",
            "-p",
            str(ssh_port),
            "-i",
            str(key_for_probe),
            "-o",
            "BatchMode=yes",
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "ConnectTimeout=5",
            "-o",
            "ExitOnForwardFailure=yes",
            "-o",
            "StrictHostKeyChecking=yes" if strict_hostkey else "StrictHostKeyChecking=accept-new",
            "-o",
            f"UserKnownHostsFile={known_hosts_for_probe}",
            "-L",
            f"{port}:127.0.0.1:22",
            f"{ssh_user}@{ssh_host}",
        ]
        try:
            proc = subprocess.Popen(
                cmd,
                text=True,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
        except Exception as exc:
            return 1, str(exc), False, None
        time.sleep(0.4)
        rc = proc.poll()
        stderr_text = ""
        listener = False
        if rc is not None:
            try:
                _, stderr_text = proc.communicate(timeout=0.5)
            except Exception:
                stderr_text = ""
        listener = False
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(0.2)
        try:
            listener = sock.connect_ex(("127.0.0.1", port)) == 0
        finally:
            sock.close()
        if rc is None:
            return 0, stderr_text, listener, proc.pid
        return int(rc), stderr_text, listener, None

    def inspect_forward_channel(port: int) -> tuple[str, str]:
        if os.environ.get("DGX_SSH_COMPLIANCE_TEST_FORWARD_CHANNEL_STATE"):
            state = os.environ.get("DGX_SSH_COMPLIANCE_TEST_FORWARD_CHANNEL_STATE", "closed").strip()
            detail = os.environ.get("DGX_SSH_COMPLIANCE_TEST_FORWARD_CHANNEL_DETAIL", "")
            return state, detail
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(1.0)
        try:
            sock.connect(("127.0.0.1", port))
            data = sock.recv(256)
        except socket.timeout:
            return "timeout", ""
        except Exception as exc:
            return "connect_error", str(exc)
        finally:
            sock.close()
        if not data:
            return "closed", ""
        snippet = data.decode("utf-8", errors="replace")
        if "SSH-" in snippet:
            return "ssh_banner", clip(snippet, 120)
        return "data", clip(snippet, 120)

    def kill_listener(pid: int | None) -> None:
        if pid is None:
            return

        def is_alive(target_pid: int) -> bool:
            try:
                os.kill(target_pid, 0)
            except ProcessLookupError:
                return False
            except PermissionError:
                return True
            except OSError:
                return False
            return True

        def reap_nowait(target_pid: int) -> bool:
            try:
                waited_pid, _ = os.waitpid(target_pid, os.WNOHANG)
                return waited_pid == target_pid
            except ChildProcessError:
                return True
            except OSError:
                return False

        if reap_nowait(pid):
            return
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        except OSError:
            return

        deadline = time.time() + 1.0
        while time.time() < deadline:
            if reap_nowait(pid) or not is_alive(pid):
                return
            time.sleep(0.05)

        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            return
        except OSError:
            return
        reap_nowait(pid)

    if skip_probes:
        add_check(
            "probe.non_interactive",
            "warn",
            "medium",
            "Non-interactivity probe skipped by DGX_SSH_COMPLIANCE_SKIP_PROBES=1",
            {},
        )
        add_check(
            "probe.forwarding_regression",
            "warn",
            "medium",
            "Forwarding regression probe skipped by DGX_SSH_COMPLIANCE_SKIP_PROBES=1",
            {},
        )
    elif not ssh_host:
        add_check(
            "probe.non_interactive",
            "warn",
            "medium",
            "Non-interactivity probe skipped: DGX_SSH_HOST is empty",
            {},
        )
        add_check(
            "probe.forwarding_regression",
            "warn",
            "medium",
            "Forwarding probe skipped: DGX_SSH_HOST is empty",
            {},
        )
    elif not key_path.exists() or (strict_hostkey and not known_hosts_path.exists()):
        add_check(
            "probe.non_interactive",
            "warn",
            "medium",
            "Non-interactivity probe skipped: SSH key or known_hosts prerequisites missing",
            {"keyExists": key_path.exists(), "knownHostsExists": known_hosts_path.exists()},
        )
        add_check(
            "probe.forwarding_regression",
            "warn",
            "medium",
            "Forwarding probe skipped: SSH key or known_hosts prerequisites missing",
            {"keyExists": key_path.exists(), "knownHostsExists": known_hosts_path.exists()},
        )
    else:
        ni_rc, ni_out, ni_err = run_noninteractive_probe()
        ni_combined = f"{ni_out}\n{ni_err}".strip()
        if re.search(r"\buid=\d+", ni_combined):
            add_check(
                "probe.non_interactive",
                "fail",
                "high",
                "Raw command output detected (uid=...), tool key is interactive",
                {"exitCode": ni_rc, "output": clip(ni_combined)},
            )
        elif has_network_error(ni_combined):
            add_check(
                "probe.non_interactive",
                "warn",
                "medium",
                "Non-interactivity probe inconclusive due to network-level error",
                {"exitCode": ni_rc, "output": clip(ni_combined)},
            )
        elif "permission denied (publickey)" in ni_combined.lower():
            add_check(
                "probe.non_interactive",
                "warn",
                "medium",
                "Non-interactivity probe inconclusive due to SSH authentication failure",
                {"exitCode": ni_rc, "output": clip(ni_combined)},
            )
        elif looks_like_forced_command_json(ni_combined):
            add_check(
                "probe.non_interactive",
                "pass",
                "low",
                "Tool key did not execute raw command; forced-command JSON response observed",
                {"exitCode": ni_rc, "output": clip(ni_combined)},
            )
        else:
            add_check(
                "probe.non_interactive",
                "warn",
                "medium",
                "Non-interactivity probe did not return a clear forced-command indicator",
                {"exitCode": ni_rc, "output": clip(ni_combined)},
            )

        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as free_sock:
            free_sock.bind(("127.0.0.1", 0))
            probe_port = free_sock.getsockname()[1]

        fw_rc, fw_err, fw_listener, fw_pid = run_forward_probe(probe_port)
        fw_channel_state = "not_listening"
        fw_channel_detail = ""
        if fw_listener:
            fw_channel_state, fw_channel_detail = inspect_forward_channel(probe_port)
        kill_listener(fw_pid)

        forwarding_evidence = {
            "policyMode": forwarding_policy,
            "exitCode": fw_rc,
            "port": probe_port,
            "stderr": clip(fw_err),
            "listenerCreated": fw_listener,
            "probePid": fw_pid,
            "channelState": fw_channel_state,
            "channelDetail": clip(fw_channel_detail, 120) if fw_channel_detail else "",
        }
        if has_network_error(fw_err):
            add_check(
                "probe.forwarding_regression",
                "warn",
                "medium",
                "Forwarding probe inconclusive due to network-level error",
                forwarding_evidence,
            )
        elif has_forwarding_error(fw_err):
            add_check(
                "probe.forwarding_regression",
                "warn",
                "medium",
                "Forwarding probe reported an SSH-level error; cannot assert policy pass",
                forwarding_evidence,
            )
        elif fw_rc != 0:
            add_check(
                "probe.forwarding_regression",
                "warn",
                "medium",
                "Forwarding probe failed before tunnel verification",
                forwarding_evidence,
            )
        elif forwarding_policy == "server_blocked":
            if fw_listener:
                add_check(
                    "probe.forwarding_regression",
                    "fail",
                    "high",
                    "Forwarding probe created a local listener under server-blocked policy",
                    forwarding_evidence,
                )
            else:
                add_check(
                    "probe.forwarding_regression",
                    "pass",
                    "low",
                    "Forwarding probe did not create a local listener",
                    forwarding_evidence,
                )
        else:
            if fw_listener and fw_channel_state in {"ssh_banner", "data"}:
                add_check(
                    "probe.forwarding_regression",
                    "fail",
                    "high",
                    "Tool key forwarding appears active (channel accepted data)",
                    forwarding_evidence,
                )
            else:
                add_check(
                    "probe.forwarding_regression",
                    "pass",
                    "low",
                    "Tool key forwarding was denied (channel was not usable)",
                    forwarding_evidence,
                )

        if verify_cursor_forwarding:
            if not cursor_key_path or not cursor_key_path.exists():
                add_check(
                    "probe.cursor_forwarding",
                    "warn",
                    "medium",
                    "Cursor forwarding check enabled but DGX_SSH_CURSOR_KEY_PATH is missing",
                    {"keyPath": str(cursor_key_path) if cursor_key_path else ""},
                )
            elif strict_hostkey and not cursor_known_hosts_path.exists():
                add_check(
                    "probe.cursor_forwarding",
                    "warn",
                    "medium",
                    "Cursor forwarding check enabled but cursor known_hosts file is missing",
                    {"knownHostsPath": str(cursor_known_hosts_path)},
                )
            else:
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as free_sock:
                    free_sock.bind(("127.0.0.1", 0))
                    cursor_port = free_sock.getsockname()[1]
                c_rc, c_err, c_listener, c_pid = run_forward_probe(cursor_port, cursor_key_path, cursor_known_hosts_path)
                c_state = "not_listening"
                c_detail = ""
                if c_listener:
                    c_state, c_detail = inspect_forward_channel(cursor_port)
                kill_listener(c_pid)
                cursor_evidence = {
                    "exitCode": c_rc,
                    "port": cursor_port,
                    "stderr": clip(c_err),
                    "listenerCreated": c_listener,
                    "probePid": c_pid,
                    "channelState": c_state,
                    "channelDetail": clip(c_detail, 120) if c_detail else "",
                    "keyPath": str(cursor_key_path),
                }
                if has_network_error(c_err):
                    add_check(
                        "probe.cursor_forwarding",
                        "warn",
                        "medium",
                        "Cursor forwarding probe inconclusive due to network-level error",
                        cursor_evidence,
                    )
                elif c_listener and c_state in {"ssh_banner", "data"}:
                    add_check(
                        "probe.cursor_forwarding",
                        "pass",
                        "low",
                        "Cursor key forwarding is usable",
                        cursor_evidence,
                    )
                else:
                    add_check(
                        "probe.cursor_forwarding",
                        "fail",
                        "high",
                        "Cursor key forwarding is not usable",
                        cursor_evidence,
                    )

    counts = {"pass": 0, "warn": 0, "fail": 0, "pending_remote_enforcement": 0}
    for check in check_results:
        status = str(check.get("status", "warn"))
        counts[status] = counts.get(status, 0) + 1

    total = len(check_results)
    payload = {
        "checkedAt": checked_at.isoformat(),
        "ok": counts.get("fail", 0) == 0,
        "summary": {
            "total": total,
            "passes": counts.get("pass", 0),
            "warns": counts.get("warn", 0),
            "fails": counts.get("fail", 0),
            "pendingRemote": counts.get("pending_remote_enforcement", 0),
        },
        "config": {
            "contractPath": str(contract_path),
            "sshHost": ssh_host,
            "sshUser": ssh_user,
            "sshPort": ssh_port,
            "strictHostKey": strict_hostkey,
            "forwardingPolicyMode": forwarding_policy,
            "keyPath": str(key_path),
            "knownHostsPath": str(known_hosts_path),
            "cursorKeyPath": str(cursor_key_path) if cursor_key_path else "",
            "cursorKnownHostsPath": str(cursor_known_hosts_path),
            "verifyCursorForwarding": verify_cursor_forwarding,
        },
        "rotation": {
            "lastReviewDate": review_date_raw,
            "ageDays": age_days,
            "ageSource": age_source,
            "warnDays": warn_days,
            "failDays": fail_days,
            "warnExceeded": rotation_warn,
            "failExceeded": rotation_fail,
        },
        "remoteEvidence": {
            "path": str(remote_evidence_path),
            "state": remote_state,
            "ageHours": remote_age_hours,
            "maxAgeHours": max_age_hours,
            "expectedDispatcherSha256": expected_sha,
        },
        "checks": check_results,
    }

    stamp = checked_at.strftime("%Y%m%d-%H%M%S")
    out_json = reports_dir / f"dgx-ssh-compliance-{stamp}.json"
    out_md = reports_dir / f"dgx-ssh-compliance-{stamp}.md"
    latest_json = reports_dir / "dgx-ssh-compliance-latest.json"
    latest_md = reports_dir / "dgx-ssh-compliance-latest.md"

    out_json.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    lines: list[str] = []
    lines.append("# DGX SSH Compliance")
    lines.append("")
    lines.append(f"- Timestamp (UTC): {payload['checkedAt']}")
    lines.append(f"- Result: {'PASS' if payload['ok'] else 'FAIL'}")
    lines.append(f"- Total checks: {payload['summary']['total']}")
    lines.append(f"- Pass: {payload['summary']['passes']}")
    lines.append(f"- Warn: {payload['summary']['warns']}")
    lines.append(f"- Fail: {payload['summary']['fails']}")
    lines.append(f"- Pending remote enforcement: {payload['summary']['pendingRemote']}")
    lines.append("")
    lines.append("## Rotation")
    lines.append("")
    lines.append(f"- Last review date: {payload['rotation']['lastReviewDate'] or '<unset>'}")
    lines.append(f"- Age days: {payload['rotation']['ageDays'] if payload['rotation']['ageDays'] is not None else 'n/a'}")
    lines.append(
        f"- Thresholds: warn={payload['rotation']['warnDays']} fail={payload['rotation']['failDays']}"
    )
    lines.append("")
    lines.append("## Checks")
    lines.append("")
    lines.append("| Check | Status | Severity | Message |")
    lines.append("|---|---|---|---|")
    for check in check_results:
        msg = str(check.get("message", "")).replace("|", "\\|")
        lines.append(
            f"| {check.get('id')} | {check.get('status')} | {check.get('severity')} | {msg} |"
        )
    out_md.write_text("\n".join(lines) + "\n", encoding="utf-8")

    shutil.copyfile(out_json, latest_json)
    shutil.copyfile(out_md, latest_md)

    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print(f"DGX SSH compliance report: {out_md}")

    return 1 if counts.get("fail", 0) > 0 else 0


if __name__ == "__main__":
    raise SystemExit(main())
PY
