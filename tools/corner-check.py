#!/usr/bin/env python3
"""Check whether a screenshot's rounded panel corners contain dark scraps.

The launcher paints a blurred backdrop below a translucent panel.  A square,
unmasked layer in the corner shows up as a region that is noticeably darker
than the panel centre.  This tool samples a small square in each corner (well
outside the rounded arc) and compares it with a square in the middle.

Exit codes:
    0  every corner is less than 6% darker than the centre
    1  at least one corner is a dark scrap (>= 6% darker)
    2  invalid input / unreadable image
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:
    from PIL import Image, ImageStat
except ImportError as exc:  # pragma: no cover - environment guard
    raise SystemExit(f"PIL is required: {exc}") from exc


DEFAULT_RADIUS = 18
DEFAULT_THRESHOLD = 0.06


def parse_rect(value: str) -> tuple[int, int, int, int]:
    parts = value.split(",")
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("rect must be x,y,w,h")
    try:
        x, y, width, height = (int(part.strip()) for part in parts)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("rect values must be integers") from exc
    if width <= 0 or height <= 0:
        raise argparse.ArgumentTypeError("rect width and height must be positive")
    return x, y, width, height


def mean_luma(image: Image.Image) -> float:
    return float(ImageStat.Stat(image.convert("L")).mean[0])


def corner_box(
    rect: tuple[int, int, int, int],
    radius: int,
    horizontal: str,
    vertical: str,
) -> tuple[int, int, int, int]:
    """Small square at a panel corner, fully outside the rounded arc."""
    x, y, width, height = rect
    size = max(2, min(width // 2, height // 2, max(2, round(radius / 4))))
    left = x if horizontal == "left" else x + width - size
    top = y if vertical == "top" else y + height - size
    return left, top, left + size, top + size


def centre_box(rect: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    x, y, width, height = rect
    size = max(2, min(width, height) // 5)
    left = x + (width - size) // 2
    top = y + (height - size) // 2
    return left, top, left + size, top + size


def sample(image: Image.Image, box: tuple[int, int, int, int]) -> float:
    left, top, right, bottom = box
    return mean_luma(image.crop((left, top, right, bottom)))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Detect dark, square scraps in rounded screenshot corners."
    )
    parser.add_argument("image", type=Path, help="PNG screenshot to inspect")
    parser.add_argument(
        "--rect",
        required=True,
        type=parse_rect,
        help="panel rectangle as x,y,w,h in image pixels",
    )
    parser.add_argument(
        "--radius",
        type=int,
        default=DEFAULT_RADIUS,
        help=f"panel corner radius in pixels (default: {DEFAULT_RADIUS})",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=DEFAULT_THRESHOLD,
        help=f"allowed relative darkening (default: {DEFAULT_THRESHOLD:.0%})".replace("%", "%%"),
    )
    args = parser.parse_args(argv)

    if args.radius < 0:
        print("error: --radius must not be negative", file=sys.stderr)
        return 2

    try:
        image = Image.open(args.image)
        image.load()
    except (OSError, ValueError) as exc:
        print(f"error: cannot read {args.image}: {exc}", file=sys.stderr)
        return 2

    x, y, width, height = args.rect
    if x < 0 or y < 0 or x + width > image.width or y + height > image.height:
        print(
            f"error: rect {args.rect} is outside the {image.width}x"
            f"{image.height} image",
            file=sys.stderr,
        )
        return 2

    rect = (x, y, width, height)
    centre = sample(image, centre_box(rect))
    denominator = max(centre, 1.0)

    print(f"image: {args.image} ({image.width}x{image.height})")
    print(f"rect: {x},{y},{width},{height} radius={args.radius}")
    print(f"centre luma: {centre:.1f}")

    failed = False
    for vertical in ("top", "bottom"):
        for horizontal in ("left", "right"):
            box = corner_box(rect, args.radius, horizontal, vertical)
            luma = sample(image, box)
            darkening = (centre - luma) / denominator
            status = "FAIL" if darkening >= args.threshold else "ok"
            if status == "FAIL":
                failed = True
            print(
                f"{vertical}-{horizontal}: luma={luma:.1f} "
                f"darker={darkening:.2%} box={box[0]},{box[1]},"
                f"{box[2] - box[0]}x{box[3] - box[1]} -> {status}"
            )

    if failed:
        print(
            f"FAIL: at least one corner is >= {args.threshold:.0%} darker "
            "than the centre"
        )
        return 1

    print(f"PASS: corners are < {args.threshold:.0%} darker than the centre")
    return 0


if __name__ == "__main__":
    sys.exit(main())
