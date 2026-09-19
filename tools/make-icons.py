#!/usr/bin/env python3
"""
make-icons.py — regenerates extension/icons/*.png

Pure standard library (zlib + struct), so it runs on any Python 3 with no
pip install. Draws at 4x and box-downsamples, which gives clean antialiased
edges without an imaging library.

    py tools\\make-icons.py
"""

import math
import os
import struct
import zlib

SS = 4  # supersampling factor
SIZES = (16, 32, 48, 128)

BG = (0xD4, 0x00, 0x00)   # red tile
FG = (0xFF, 0xFF, 0xFF)   # white warning triangle

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'extension', 'icons')

# ---------------------------------------------------------------------------
# Geometry, expressed in a 128x128 design space
# ---------------------------------------------------------------------------
TILE_RADIUS = 26.0
TRI_APEX = (64.0, 20.0)
TRI_LEFT = (12.0, 106.0)
TRI_RIGHT = (116.0, 106.0)
BAR_X0, BAR_X1 = 57.0, 71.0
BAR_Y0, BAR_Y1 = 46.0, 76.0
DOT_CENTER, DOT_R = (64.0, 91.0), 7.5


def in_rounded_rect(x, y, w, h, r):
    """Point-in-rounded-rectangle test."""
    if x < 0 or y < 0 or x > w or y > h:
        return False
    cx = min(max(x, r), w - r)
    cy = min(max(y, r), h - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r or (r <= x <= w - r) or (r <= y <= h - r)


def in_triangle(x, y, a, b, c):
    """Half-plane test; winding-order independent."""
    def side(p, q):
        return (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0])
    d1, d2, d3 = side(a, b), side(b, c), side(c, a)
    has_neg = d1 < 0 or d2 < 0 or d3 < 0
    has_pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (has_neg and has_pos)


def in_exclamation(x, y):
    """Rounded bar plus a dot underneath."""
    r = (BAR_X1 - BAR_X0) / 2.0
    if in_rounded_rect(x - BAR_X0, y - BAR_Y0, BAR_X1 - BAR_X0, BAR_Y1 - BAR_Y0, r):
        return True
    return (x - DOT_CENTER[0]) ** 2 + (y - DOT_CENTER[1]) ** 2 <= DOT_R * DOT_R


def sample(u, v):
    """Colour at a point in the 128x128 design space. Returns RGBA."""
    if not in_rounded_rect(u, v, 128.0, 128.0, TILE_RADIUS):
        return (0, 0, 0, 0)                                  # outside the tile
    if in_triangle(u, v, TRI_APEX, TRI_LEFT, TRI_RIGHT):
        if in_exclamation(u, v):
            return BG + (255,)                               # red mark on white
        return FG + (255,)                                   # white triangle
    return BG + (255,)                                       # red tile


def render(size):
    """Supersample then average down to `size` x `size` RGBA bytes."""
    big = size * SS
    scale = 128.0 / big
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            r = g = b = a = 0
            for sy in range(SS):
                for sx in range(SS):
                    u = (px * SS + sx + 0.5) * scale
                    v = (py * SS + sy + 0.5) * scale
                    cr, cg, cb, ca = sample(u, v)
                    # Premultiply so transparent corners do not darken the edge.
                    r += cr * ca
                    g += cg * ca
                    b += cb * ca
                    a += ca
            n = SS * SS
            if a == 0:
                row += bytes((0, 0, 0, 0))
            else:
                row += bytes((round(r / a), round(g / a), round(b / a), round(a / n)))
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    raw = b''.join(b'\x00' + r for r in rows)   # filter byte 0 per scanline

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw, 9))
           + chunk(b'IEND', b''))

    with open(path, 'wb') as f:
        f.write(png)
    return len(png)


def main():
    out = os.path.normpath(OUT_DIR)
    os.makedirs(out, exist_ok=True)
    for size in SIZES:
        path = os.path.join(out, 'icon%d.png' % size)
        n = write_png(path, size, render(size))
        print('  icon%d.png  (%d bytes)' % (size, n))


if __name__ == '__main__':
    main()
