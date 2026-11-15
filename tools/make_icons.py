#!/usr/bin/env python3
"""Draws the app icons (blue rounded square, white microphone) as PNG without external libraries."""
import struct, zlib, sys, os

def png(path, size):
    S = size; ss = 4                       # 4x supersampling
    bg = (3, 169, 244); fg = (255, 255, 255)
    def inside(x, y):
        # coordinates normalised to 0..1
        r = 0.18                            # rounded square corner radius
        cx = min(max(x, r), 1 - r); cy = min(max(y, r), 1 - r)
        if (x - cx) ** 2 + (y - cy) ** 2 > r * r: return None
        # mic capsule: rounded rect x 0.40-0.60, y 0.20-0.58
        def capsule(x, y, x0, x1, y0, y1):
            rr = (x1 - x0) / 2; mx = (x0 + x1) / 2
            if y0 + rr <= y <= y1 - rr: return x0 <= x <= x1
            cyy = y0 + rr if y < y0 + rr else y1 - rr
            return (x - mx) ** 2 + (y - cyy) ** 2 <= rr * rr
        if capsule(x, y, 0.40, 0.60, 0.18, 0.58): return fg
        # holder arc: ring centred (0.5, 0.45), radius 0.19..0.235, lower half
        d = ((x - 0.5) ** 2 + (y - 0.45) ** 2) ** 0.5
        if 0.19 <= d <= 0.235 and y >= 0.45: return fg
        if 0.48 <= x <= 0.52 and 0.68 <= y <= 0.80: return fg      # stem
        if 0.38 <= x <= 0.62 and 0.78 <= y <= 0.82: return fg      # base
        return bg
    rows = []
    for py in range(S):
        row = bytearray([0])
        for px in range(S):
            acc = [0, 0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    c = inside((px + (sx + .5) / ss) / S, (py + (sy + .5) / ss) / S)
                    if c: acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; acc[3] += 255
            n = ss * ss; a = acc[3] // n
            row += bytes([acc[0] // max(1, acc[3] // 255), acc[1] // max(1, acc[3] // 255), acc[2] // max(1, acc[3] // 255), a]) if a else b'\0\0\0\0'
        rows.append(bytes(row))
    raw = b''.join(rows)
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    data = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', S, S, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    open(path, 'wb').write(data)

out = sys.argv[1]
png(os.path.join(out, 'icon.png'), 80)
png(os.path.join(out, 'largeIcon.png'), 130)
print('icons written')
