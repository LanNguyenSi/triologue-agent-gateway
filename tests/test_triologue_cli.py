"""
pytest suite for triologue-cli.py (task 314c8f1c, item 4: the CLI previously
had no test harness at all).

Scope decision: triologue-cli.py parses argv and validates --token
unconditionally at module load (`args = parser.parse_args()` at module
scope, no `if __name__ == "__main__":` guard around argument handling —
only the websocket `main()` loop is guarded). Refactoring the script to make
argument parsing import-safe would be a behavior change to the CLI itself,
which is out of scope for this pass (the task's allowed production changes
are the openclaw-inject seam only). So this suite tests the script as-is,
the same way src/cli.ts is tested (see ../src/__tests__/cli.test.ts): pure
subprocess invocation for anything that touches argv parsing / exit codes,
and — for the two pure functions below the parser (`fmt_time`,
`handle_event`) — importing the file fresh under a monkeypatched sys.argv so
the unconditional parse sees safe fake args. Neither path calls `main()` or
opens a real websocket connection; only `if __name__ == "__main__":` does
that, so no network I/O happens anywhere in this suite.

Requires `websockets` importable (triologue-cli.py itself hard-imports it
before argparse even runs) — see requirements-test.txt.
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
from pathlib import Path
from types import ModuleType

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
CLI_PATH = REPO_ROOT / "triologue-cli.py"


# ── subprocess-level tests: argv parsing / exit codes / stderr ────────────


def run_cli(args: list[str], env: dict | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(CLI_PATH), *args],
        capture_output=True,
        text=True,
        timeout=10,
        env=env,
    )


def test_help_exits_zero_and_documents_flags():
    result = run_cli(["--help"])
    assert result.returncode == 0
    assert "--token TOKEN" in result.stdout
    assert "--room ROOM" in result.stdout
    assert "--send SEND" in result.stdout


def test_missing_token_exits_nonzero_with_clear_error():
    env = {k: v for k, v in os.environ.items() if k != "BYOA_TOKEN"}
    result = run_cli([], env=env)
    assert result.returncode != 0
    assert "Token required" in result.stderr


def test_token_from_env_var_is_accepted_without_flag():
    # No --send/--room so the process would hang trying to connect; use
    # --help instead purely to prove argparse doesn't reject the BYOA_TOKEN
    # env var path with a "Token required" error before reaching --help's
    # own zero-exit (argparse evaluates --help before the custom check).
    env = {**os.environ, "BYOA_TOKEN": "byoa_from_env"}
    result = run_cli(["--help"], env=env)
    assert result.returncode == 0


def test_token_from_env_var_is_used_as_the_effective_token(monkeypatch):
    # Unlike the subprocess test above (which only proves --help doesn't
    # reject the env var path), this asserts the env var actually becomes
    # args.token - the thing a mutant that drops the `default=os.environ.get(
    # "BYOA_TOKEN")` fallback (e.g. `default=None`) would break, since
    # `--help`'s zero exit doesn't depend on args.token at all.
    monkeypatch.setenv("BYOA_TOKEN", "byoa_from_env")
    module = _load_cli_module([])
    assert module.args.token == "byoa_from_env"


# ── module-level tests: fmt_time / handle_event ────────────────────────────


def _load_cli_module(argv: list[str]) -> ModuleType:
    """Import triologue-cli.py fresh under a fake sys.argv.

    A fresh spec/module per call avoids state leaking between tests (the
    module keeps mutable globals like current_room / rooms that
    handle_event mutates in place).
    """
    old_argv = sys.argv
    sys.argv = ["triologue-cli.py", *argv]
    try:
        spec = importlib.util.spec_from_file_location(
            f"triologue_cli_under_test_{id(argv)}", CLI_PATH
        )
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.argv = old_argv


@pytest.fixture()
def cli_module() -> ModuleType:
    m = _load_cli_module(["--token", "byoa_test_fake"])
    # Non-interactive defaults so info()/print() below are observable.
    m.args.json_mode = False
    m.args.pipe = False
    m.args.send = None
    m.args.quiet = False
    return m


class TestFmtTime:
    def test_formats_iso_utc_timestamp_to_hh_mm(self, cli_module):
        assert cli_module.fmt_time("2026-08-18T14:05:00Z") == "14:05"

    def test_returns_placeholder_on_malformed_timestamp(self, cli_module):
        assert cli_module.fmt_time("not-a-timestamp") == "??:??"


class TestHandleEventAuthOk:
    def _rooms(self):
        return [{"id": "r1", "name": "General"}, {"id": "r2", "name": "Random"}]

    def test_selects_room_matching_the_requested_filter(self, cli_module, capsys):
        # MUTATION GUARD: args.room = "rand" matches only r2/Random (the
        # *second* room in self._rooms()), which is distinct from
        # rooms[0]/General - the state a mutant that discards the match
        # (e.g. `match = None`, which always falls back to rooms[0]) would
        # also produce. A filter matching r1/General instead couldn't tell
        # a real match from that fallback, since both land on r1.
        cli_module.args.room = "rand"
        cli_module.handle_event(
            {
                "type": "auth_ok",
                "agent": {"name": "Bot", "username": "bot", "emoji": "🤖"},
                "rooms": self._rooms(),
            }
        )
        assert cli_module.current_room == "r2"
        assert cli_module.current_room_name == "Random"
        assert cli_module.authenticated.is_set()
        assert "Random" in capsys.readouterr().out

    def test_falls_back_to_first_room_when_filter_matches_nothing(self, cli_module, capsys):
        cli_module.args.room = "does-not-exist"
        cli_module.handle_event(
            {
                "type": "auth_ok",
                "agent": {"name": "Bot", "username": "bot", "emoji": "🤖"},
                "rooms": self._rooms(),
            }
        )
        out = capsys.readouterr().out
        assert "not found" in out
        assert cli_module.current_room == "r1"

    def test_defaults_to_first_room_when_no_filter_and_multiple_rooms(self, cli_module):
        cli_module.args.room = None
        cli_module.handle_event(
            {
                "type": "auth_ok",
                "agent": {"name": "Bot", "username": "bot", "emoji": "🤖"},
                "rooms": self._rooms(),
            }
        )
        assert cli_module.current_room == "r1"
        assert cli_module.current_room_name == "General"


class TestHandleEventAuthError:
    def test_auth_error_exits_with_nonzero_status(self, cli_module):
        with pytest.raises(SystemExit) as excinfo:
            cli_module.handle_event({"type": "auth_error", "error": "bad token"})
        assert excinfo.value.code == 1


class TestHandleEventMessage:
    def _select_room(self, cli_module):
        cli_module.current_room = "r1"

    def test_json_mode_prints_a_single_json_line_with_message_fields(self, cli_module, capsys):
        self._select_room(cli_module)
        cli_module.args.json_mode = True
        cli_module.handle_event(
            {
                "type": "message",
                "id": "m1",
                "room": "r1",
                "sender": "alice",
                "content": "hi there",
                "timestamp": "2026-08-18T14:05:00Z",
            }
        )
        out = capsys.readouterr().out.strip()
        assert out.startswith("{")
        assert '"content": "hi there"' in out

    def test_human_mode_prints_formatted_sender_and_content(self, cli_module, capsys):
        self._select_room(cli_module)
        cli_module.handle_event(
            {
                "type": "message",
                "room": "r1",
                "sender": "alice",
                "content": "hi there",
                "timestamp": "2026-08-18T14:05:00Z",
            }
        )
        out = capsys.readouterr().out
        assert "alice: hi there" in out
        assert "[14:05]" in out

    def test_message_from_a_different_room_is_ignored(self, cli_module, capsys):
        self._select_room(cli_module)
        cli_module.handle_event(
            {"type": "message", "room": "other-room", "sender": "alice", "content": "hi"}
        )
        assert capsys.readouterr().out == ""
