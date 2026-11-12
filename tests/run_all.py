#!/usr/bin/env python3
"""Spotlight acceptance gate.

Zero external dependencies. Exit code 0 means every check (metadata, stylesheet
shadows, GSettings schema, PURE module isolation and the gjs test suites)
passed.

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

# St rasterizes box-shadow on every layer repaint and ignores shadows after the
# first comma-separated layer. Keep exactly one inexpensive shadow on the modal
# and reject shadows anywhere else (selection borders use a real border).
SHADOW_SELECTOR = ".spotlight-modal"
MAX_SHADOW_BLUR_PX = 16.0
COLOR_RE = re.compile(r"(?:rgba?|hsla?)\([^)]*\)|#[0-9a-fA-F]{3,8}")
LENGTH_RE = re.compile(r"(?<![\w.#-])(-?(?:\d+(?:\.\d*)?|\.\d+))([a-zA-Z%]*)(?![\w-])")

EXPECTED_KEYS = {
    "toggle-keybinding": "as",
    "enabled-providers": "as",
    "max-results": "i",
    "preview-enabled": "b",
    "clipboard-enabled": "b",
    "usage-history": "s",
    "currency-rates": "s",
    "open-on-monitor": "s",
    "remote-providers-enabled": "b",
}

EXPECTED_DEFAULTS = {
    "toggle-keybinding": "['<Super>space']",
    "enabled-providers": "['apps','windows','files','settings','commands','calculator']",
    "max-results": "8",
    "preview-enabled": "true",
    "clipboard-enabled": "true",
    "usage-history": "'{}'",
    "currency-rates": "'{}'",
    "open-on-monitor": "'pointer'",
    "remote-providers-enabled": "true",
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
    "lib/files-parse.js",
    "lib/preview-model.js",
    "lib/providers/registry.js",
    "lib/clipboard-store.js",
    "lib/searchStream.js",
    "lib/search-providers-ini.js",
    "lib/remote-candidates.js",
    "searchd/registry.js",
    "searchd/serialize.js",
    "searchd/providers/commands.js",
    "searchd/providers/calculator.js",
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
    "lib/files-parse.js",
    "lib/preview-model.js",
    "lib/providers/files.js",
    "lib/providers/calculator.js",
    "lib/providers/clipboard.js",
    "lib/daemonClient.js",
    "lib/searchStream.js",
    "lib/ui/modal.js",
    "lib/ui/preview.js",
    "lib/ui/resultRow.js",
    "searchd/main.js",
    "searchd/registry.js",
    "searchd/searchProvider2.js",
    "searchd/providers/apps.js",
    "searchd/providers/settings.js",
    "searchd/providers/files.js",
    "searchd/providers/commands.js",
    "searchd/providers/calculator.js",
    "searchd/providers/remote.js",
    "lib/search-providers-ini.js",
    "lib/remote-candidates.js",
    "tests/js/remote-budget.test.js",
    "tests/js/search-providers-ini.test.js",
    "tools/install-daemon.sh",
    "tools/bench-daemon.sh",
    "tools/headless-perf.sh",
    "tests/js/harness.js",
    "tests/js/daemon-registry.test.js",
    "tests/js/searchStream.test.js",
    "tests/headless/perf.js",
    "tests/js/files-parse.test.js",
    "tests/js/preview-model.test.js",
    "tests/js/clipboard-store.test.js",
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


def split_top_level(value: str, separator: str) -> list[str]:
    """Split a CSS value on a separator outside parentheses."""
    parts: list[str] = []
    current: list[str] = []
    depth = 0
    for character in value:
        if character == "(":
            depth += 1
        elif character == ")" and depth > 0:
            depth -= 1

        if character == separator and depth == 0:
            parts.append("".join(current).strip())
            current = []
        else:
            current.append(character)

    parts.append("".join(current).strip())
    return parts


def check_required_files() -> None:
    missing = [name for name in REQUIRED_FILES if not (ROOT / name).is_file()]
    if missing:
        fail(f"missing required files: {', '.join(missing)}")
    else:
        ok(f"required files present ({len(REQUIRED_FILES)})")


def check_stylesheet() -> None:
    """Guard the cheap-shadow contract from the P0 rendering regression.

    St renders each box-shadow layer in software on every repaint and only
    honours the first layer. A single <=16px blur on the modal is allowed;
    every other selector must use a border/background instead.
    """
    path = ROOT / "stylesheet.css"
    if not path.is_file():
        fail("stylesheet.css is missing")
        return

    source = re.sub(r"/\*.*?\*/", "", read_text(path), flags=re.DOTALL)
    shadows: list[tuple[str, str]] = []
    errors: list[str] = []

    for rule in re.finditer(r"([^{}]+)\{([^{}]*)\}", source):
        selector = " ".join(rule.group(1).split())
        declarations = split_top_level(rule.group(2), ";")
        for declaration in declarations:
            if ":" not in declaration:
                continue
            property_name, value = declaration.split(":", 1)
            if property_name.strip().lower() != "box-shadow":
                continue

            value = value.strip()
            shadows.append((selector, value))

            if selector != SHADOW_SELECTOR:
                errors.append(
                    f"box-shadow is only allowed in {SHADOW_SELECTOR}, "
                    f"found in {selector!r}"
                )
                continue

            layers = split_top_level(value, ",")
            if len(layers) != 1:
                errors.append(
                    f"{selector}: expected exactly one shadow layer, "
                    f"found {len(layers)}"
                )
                continue

            # Color functions contain numbers; strip them before looking for
            # the 2-4 length components of the shadow.
            lengths = LENGTH_RE.findall(
                COLOR_RE.sub(" ", value)
            )
            if len(lengths) < 3:
                errors.append(
                    f"{selector}: shadow needs offset-x, offset-y and blur, "
                    f"found {len(lengths)} length(s)"
                )
                continue

            for number, unit in lengths:
                if float(number) != 0 and unit.lower() != "px":
                    errors.append(
                        f"{selector}: shadow lengths must use px, "
                        f"found {number}{unit}"
                    )
                    break

            blur_number, blur_unit = lengths[2]
            blur = float(blur_number)
            if blur < 0:
                errors.append(f"{selector}: blur must not be negative")
            elif blur_unit.lower() != "px" and blur != 0:
                errors.append(
                    f"{selector}: blur must use px, found {blur}{blur_unit}"
                )
            elif blur > MAX_SHADOW_BLUR_PX:
                errors.append(
                    f"{selector}: blur {blur:g}px exceeds "
                    f"{MAX_SHADOW_BLUR_PX:g}px"
                )

    modal_shadows = [
        value for selector, value in shadows if selector == SHADOW_SELECTOR
    ]
    if not modal_shadows:
        errors.append(f"{SHADOW_SELECTOR} must declare exactly one shadow")
    elif len(modal_shadows) > 1:
        errors.append(
            f"{SHADOW_SELECTOR} declares {len(modal_shadows)} box-shadow "
            "properties, expected one"
        )

    if errors:
        fail("stylesheet.css: " + "; ".join(errors))
    else:
        ok(
            "stylesheet.css: single modal box-shadow, blur <= "
            f"{MAX_SHADOW_BLUR_PX:g}px, no other shadows"
        )


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

    ok(f"GSettings schema: {len(EXPECTED_KEYS)} keys/types/defaults and strict dry-run compile")


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


def check_daemon_isolation() -> None:
    """The daemon must be importable without a GNOME Shell session."""
    daemon_dir = ROOT / "searchd"
    if not daemon_dir.is_dir():
        fail("searchd/ directory is missing")
        return

    forbidden_tokens = [
        "gi://St",
        "gi://Shell",
        "gi://Clutter",
        "resource:///org/gnome/shell",
    ]
    files = sorted(daemon_dir.rglob("*.js"))
    if not files:
        fail("searchd/ contains no JavaScript files")
        return

    problems_found = []
    for path in files:
        relative = path.relative_to(ROOT)
        try:
            source = read_text(path)
        except OSError as exc:
            problems_found.append(f"{relative}: cannot read: {exc}")
            continue
        found = [token for token in forbidden_tokens if token in source]
        if found:
            problems_found.append(f"{relative}: {', '.join(found)}")

    if problems_found:
        fail("daemon imports Shell-only modules: " + "; ".join(problems_found))
    else:
        ok(f"searchd/ has no St/Shell/Clutter imports ({len(files)} files)")


def check_remote_autostart_guard() -> None:
    """Native providers may only be queried when their bus name is owned."""
    path = ROOT / "searchd" / "providers" / "remote.js"
    if not path.is_file():
        fail("searchd/providers/remote.js is missing")
        return

    source = read_text(path)
    required = [
        "NameHasOwner",
        "DO_NOT_AUTO_START",
        "DO_NOT_LOAD_PROPERTIES",
    ]
    missing = [token for token in required if token not in source]
    if missing:
        fail("remote provider misses autostart guard: " + ", ".join(missing))
        return
    if "_sync(" in source:
        fail("remote provider must not use synchronous D-Bus calls")
        return

    ok("remote provider: NameHasOwner + DO_NOT_AUTO_START, no _sync calls")


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


def check_frontend_daemon_path() -> None:
    """The daemon fast path in extension.js must not enumerate locally.

    The in-process providers remain the fallback, but the extension itself
    may only query the daemon and the Shell windows provider per keystroke
    (DESIGN §13). Static check catches accidental re-introduction of the old
    enumeration in the frontend entry point.
    """
    path = ROOT / "extension.js"
    if not path.is_file():
        fail("extension.js is missing")
        return

    source = read_text(path)
    forbidden = ["get_installed(", "Gio.AppInfo.get_all", "AppInfo.get_all", "locate"]
    found = [token for token in forbidden if token in source]
    if found:
        fail("extension.js daemon path enumerates locally: " + ", ".join(found))
    else:
        ok("extension.js: daemon path has no local enumeration (apps/files/settings)")


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
    check_stylesheet()
    check_schema()
    check_pure_modules()
    check_daemon_isolation()
    check_extension_esm()
    check_frontend_daemon_path()
    check_remote_autostart_guard()

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