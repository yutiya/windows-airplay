"""用 Python 标准库生成应用/托盘图标，避免引入额外的图像依赖。"""

import math
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets")


def write_png(filename, width, height, painter):
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # 每行滤波类型：None
        for x in range(width):
            raw.extend(painter(x, y, width, height))

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack(">2I5B", width, height, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", header)
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    with open(filename, "wb") as handle:
        handle.write(png)


def rounded_rect(x, y, left, top, right, bottom, radius):
    if x < left or x > right or y < top or y > bottom:
        return False
    cx = min(max(x, left + radius), right - radius)
    cy = min(max(y, top + radius), bottom - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2


def painter(x, y, w, h):
    scale = w / 256.0
    pad = 18 * scale
    radius = 52 * scale
    if not rounded_rect(x, y, pad, pad, w - pad, h - pad, radius):
        return (0, 0, 0, 0)

    # 深蓝底
    color = (37, 99, 235, 255)
    # 白色屏幕外框
    left, top, right, bottom = 62 * scale, 72 * scale, 194 * scale, 166 * scale
    inner = 8 * scale
    if left <= x <= right and top <= y <= bottom:
        is_border = (
            x < left + inner or x > right - inner or
            y < top + inner or y > bottom - inner or
            y > 148 * scale
        )
        if is_border:
            return (255, 255, 255, 255)
        return (37, 99, 235, 255)
    # 底部投屏三角
    tri_top, tri_bottom = 176 * scale, 206 * scale
    if tri_top <= y <= tri_bottom:
        half = (y - tri_top) / (tri_bottom - tri_top) * 34 * scale
        if abs(x - 128 * scale) <= half:
            return (255, 255, 255, 255)
    return color


def main():
    os.makedirs(OUT, exist_ok=True)
    write_png(os.path.join(OUT, "icon.png"), 256, 256, painter)
    write_png(os.path.join(OUT, "tray.png"), 64, 64, painter)
    print("已生成 assets/icon.png 与 assets/tray.png")


if __name__ == "__main__":
    main()
