#!/usr/bin/env python3
"""Spotlight acceptance gate.

Zero external dependencies. Exit code 0 means every check (metadata, GSettings
schema, PURE module isolation and the gjs test suites) passed.

Usage: python3 tests/run_all.py
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCHEMAS_DIR = ROOT / "schemas"
TESTS_DIR = ROOT / "tests" / "js"

UUID = "spotlight@haniewicz.dev"
SCHEMA_ID = "org.gnome.shell.extensions.spotlight"

EXPECTED_KEYS = {
    "toggle-keybinding": "as",
    "enabled-providers": "as",
    "max-results": "i",
    "preview-enabled": "b",
    "usage-history": "s",
    "currency-rates": "s",
    "open-on-monitor": "s",
}

EXPECTED_DEFAULTS = {
    "toggle-keybinding": "['<Super>space']",
    "enabled-providers": "['apps','windows','files','settings','commands','calculator']",
    "max-results": "8",
    "preview-enabled": "true",
    "usage-history": "'{}'",
    "currency-rates": "'{}'",
    "open-on-monitor": "'pointer'",
}

# These modules are PURE by DESIGN §3: they must never import the shell or GI.
PURE_MODULES = [
    "lib/cache.js",
    "lib/text.js",
    "lib/fuzzy.js",
    "lib/ranking.js",
    "lib/usage.js",
    "lib/calculator.js",
    "lib/format.js",
    "lib/gtype.js",
    "lib/providers/registry.js",
]

REQUIRED_FILES = [
    "metadata.json",
    "extension.js",
    "stylesheet.css",
    "schemas/org.gnome.shell.extensions.spotlight.gschema.xml",
    "lib/text.js",
    "lib/fuzzy.js",
    "lib/ranking.js",
    "lib/usage.js",
    "lib/calculator.js",
    "lib/format.js",
    "lib/gtype.js",
    "lib/providers/files.js",
    "lib/providers/calculator.js",
    "lib/ui/modal.js",
    "lib/ui/resultRow.js",
    "tests/js/harness.js",
    "tests/run_all.py",
]

problems: list[str] = []


def ok(message: str) -> None:
    print(f"[PASS] {message}")


def fail(message: str) -> None:
    problems.append(message)
    print(f"[FAIL] {message}")


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def check_required_files() -> None:
    missing = [name for name in REQUIRED_FILES if not (ROOT / name).is_file()]
    if missing:
        fail(f"missing required files: {', '.join(missing)}")
    else:
        ok(f"required files present ({len(REQUIRED_FILES)})")


def check_metadata() -> None:
    path = ROOT / "metadata.json"
    if not path.is_file():
        fail("metadata.json is missing")
        return

    try:
        metadata = json.loads(read_text(path))
    except (json.JSONDecodeError, OSError) as exc:
        fail(f"metadata.json is not valid JSON: {exc}")
        return

    errors = []
    if metadata.get("uuid") != UUID:
        errors.append(f"uuid must be {UUID!r}")
    shell_versions = metadata.get("shell-version")
    if not isinstance(shell_versions, list) or "51" not in shell_versions:
        errors.append('shell-version must contain "51"')
    if metadata.get("settings-schema") != SCHEMA_ID:
        errors.append(f"settings-schema must be {SCHEMA_ID!r}")

    if errors:
        fail("metadata.json: " + "; ".join(errors))
    else:
        ok("metadata.json (uuid, shell-version 51, settings-schema)")


def check_schema() -> None:
    path = SCHEMAS_DIR / "org.gnome.shell.extensions.spotlight.gschema.xml"
    if not path.is_file():
        fail("GSettings schema file is missing")
        return

    try:
        tree = ET.parse(path)
    except ET.ParseError as exc:
        fail(f"schema XML does not parse: {exc}")
        return

    root = tree.getroot()
    schema = root.find("schema")
    if schema is None or schema.get("id") != SCHEMA_ID:
        fail(f"schema id must be {SCHEMA_ID!r}")
        return

    actual_keys = {}
    actual_defaults = {}
    for key in schema.findall("key"):
        name = key.get("name")
        actual_keys[name] = key.get("type")
        default = key.find("default")
        actual_defaults[name] = (default.text or "").strip() if default is not None else ""

    if actual_keys != EXPECTED_KEYS:
        missing = sorted(set(EXPECTED_KEYS) - set(actual_keys))
        extra = sorted(set(actual_keys) - set(EXPECTED_KEYS))
        wrong_types = sorted(
            name for name in EXPECTED_KEYS
            if name in actual_keys and actual_keys[name] != EXPECTED_KEYS[name]
        )
        fail(
            "schema keys/types differ from DESIGN §8: "
            f"missing={missing}, extra={extra}, wrong_types={wrong_types}"
        )
        return

    wrong_defaults = sorted(
        name for name, expected in EXPECTED_DEFAULTS.items()
        if actual_defaults.get(name) != expected
    )
    if wrong_defaults:
        fail(f"schema defaults differ from DESIGN §8: {wrong_defaults}")
        return

    compiler = shutil.which("glib-compile-schemas")
    if compiler is None:
        fail("glib-compile-schemas not found in PATH")
        return

    result = subprocess.run(
        [compiler, "--strict", "--dry-run", str(SCHEMAS_DIR)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=60,
    )
    if result.returncode != 0:
        output = (result.stderr or result.stdout).strip()
        fail(f"glib-compile-schemas --strict --dry-run failed (rc={result.returncode}): {output}")
        return

    ok("GSettings schema: 7 keys/types/defaults and strict dry-run compile")


def check_pure_modules() -> None:
    checked = []
    for relative in PURE_MODULES:
        path = ROOT / relative
        if not path.is_file():
            continue
        checked.append(relative)
        try:
            source = read_text(path)
        except OSError as exc:
            fail(f"{relative}: cannot read: {exc}")
            continue

        forbidden = []
        if "gi://" in source:
            forbidden.append("gi://")
        if "resource://" in source:
            forbidden.append("resource://")
        if forbidden:
            fail(f"{relative}: PURE module contains {', '.join(forbidden)}")
        else:
            ok(f"PURE {relative}: no gi:// or resource://")

    if not checked:
        fail("no PURE modules found to check")


def check_extension_esm() -> None:
    path = ROOT / "extension.js"
    if not path.is_file():
        fail("extension.js is missing")
        return

    source = read_text(path)
    errors = []

    if "export default class SpotlightExtension extends Extension" not in source:
        errors.append("missing `export default class SpotlightExtension extends Extension`")
    if "resource:///org/gnome/shell/" not in source:
        errors.append("missing resource:///org/gnome/shell/ import")
    if "removeKeybinding" not in source:
        errors.append("disable() must call removeKeybinding")
    if "imports.gi.St" in source:
        errors.append("legacy imports.gi.St is not allowed in ESM")

    if errors:
        fail("extension.js: " + "; ".join(errors))
    else:
        ok("extension.js is ESM and owns its keybinding lifecycle")


def run_tests() -> tuple[int, int, int]:
    gjs = shutil.which("gjs")
    if gjs is None:
        fail("gjs not found in PATH")
        return (0, 0, 0)

    tests = sorted(TESTS_DIR.glob("*.test.js"))
    if not tests:
        fail("no tests/js/*.test.js files found")
        return (0, 0, 0)

    summary_re = re.compile(r"(\d+) passed,\s*(\d+) failed")
    total_passed = 0
    total_failed = 0
    passed_files = 0

    for test_path in tests:
        relative = test_path.relative_to(ROOT)
        try:
            result = subprocess.run(
                [gjs, "-m", str(test_path)],
                cwd=ROOT,
                capture_output=True,
                text=True,
                timeout=120,
            )
        except subprocess.TimeoutExpired:
            fail(f"{relative}: timed out after 120 s")
            total_failed += 1
            continue
        except OSError as exc:
            fail(f"{relative}: cannot run gjs: {exc}")
            total_failed += 1
            continue

        combined = f"{result.stdout}\n{result.stderr}".strip()
        match = summary_re.search(result.stdout)

        if result.returncode != 0:
            fail(f"{relative}: gjs exited with rc={result.returncode}")
            if combined:
                print(combined)
            total_failed += 1
            continue

        if match is None:
            fail(f"{relative}: no harness summary found")
            if combined:
                print(combined)
            total_failed += 1
            continue

        passed = int(match.group(1))
        failed = int(match.group(2))
        total_passed += passed
        total_failed += failed

        if failed > 0:
            fail(f"{relative}: {passed} passed, {failed} failed")
            if combined:
                print(combined)
        elif passed == 0:
            fail(f"{relative}: no test cases")
        else:
            passed_files += 1
            ok(f"{relative}: {passed} passed, 0 failed")

    return (passed_files, total_passed, total_failed)


def main() -> int:
    print("== Spotlight acceptance gate ==")

    check_required_files()
    check_metadata()
    check_schema()
    check_pure_modules()
    check_extension_esm()

    passed_files, total_passed, total_failed = run_tests()

    print()
    if problems or total_failed:
        total_problems = len(problems) + total_failed
        print(f"RESULT: FAIL - {total_problems} problem(s)")
        return 1

    print(
        f"RESULT: PASS - {passed_files} test files, "
        f"{total_passed} cases, {total_failed} failures"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())