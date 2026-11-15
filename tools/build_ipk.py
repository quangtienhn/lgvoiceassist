#!/usr/bin/env python3
"""Builds the webOS .ipk for LG TV Assist from ./app (no ares-cli needed).

Layout inside data.tar.gz:
  usr/palm/applications/<appId>/...      (web UI)
  usr/palm/services/<serviceId>/...      (luna service + daemon)
  usr/palm/packages/<appId>/packageinfo.json
"""
import io, json, os, sys, tarfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, 'app')
OUT = os.path.join(ROOT, 'dist')

appinfo = json.load(open(os.path.join(APP, 'appinfo.json')))
APP_ID, VERSION = appinfo['id'], appinfo['version']
SVC_DIR = os.path.join(APP, 'services')
services = sorted(os.listdir(SVC_DIR))
EXEC = ('.sh',)
EXEC_NAMES = ('voiceconductor-stub',)
MTIME = int(os.environ.get('SOURCE_DATE_EPOCH', time.time()))


def add_tree(tar, src, dst):
    for base, dirs, files in os.walk(src):
        dirs.sort()
        rel = os.path.relpath(base, src)
        arc_dir = dst if rel == '.' else dst + '/' + rel.replace(os.sep, '/')
        add_dir(tar, arc_dir)
        for f in sorted(files):
            p = os.path.join(base, f)
            data = open(p, 'rb').read()
            ti = tarfile.TarInfo(arc_dir + '/' + f)
            ti.size = len(data); ti.mtime = MTIME; ti.uid = ti.gid = 0; ti.uname = ti.gname = 'root'
            ti.mode = 0o755 if (f.endswith(EXEC) or f in EXEC_NAMES) else 0o644
            tar.addfile(ti, io.BytesIO(data))


_dirs = set()
def add_dir(tar, name):
    if name.startswith('./'): name = name[2:]
    parts = name.strip('/').split('/')
    for i in range(1, len(parts) + 1):
        d = './' + '/'.join(parts[:i])
        if d in _dirs: continue
        _dirs.add(d)
        ti = tarfile.TarInfo(d); ti.type = tarfile.DIRTYPE; ti.mode = 0o755; ti.mtime = MTIME; ti.uid = ti.gid = 0
        tar.addfile(ti)


def tar_gz(build):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:gz', format=tarfile.GNU_FORMAT) as t:
        build(t)
    return buf.getvalue()


def data_tar(t):
    app_files = [f for f in os.listdir(APP) if f != 'services']
    add_dir(t, 'usr/palm/applications/' + APP_ID)
    for f in sorted(app_files):
        p = os.path.join(APP, f)
        if os.path.isdir(p): add_tree(t, p, './usr/palm/applications/%s/%s' % (APP_ID, f))
        else:
            data = open(p, 'rb').read()
            ti = tarfile.TarInfo('./usr/palm/applications/%s/%s' % (APP_ID, f))
            ti.size = len(data); ti.mtime = MTIME; ti.mode = 0o644; ti.uid = ti.gid = 0
            t.addfile(ti, io.BytesIO(data))
    for s in services:
        add_tree(t, os.path.join(SVC_DIR, s), './usr/palm/services/' + s)
    pkg = json.dumps({'app': APP_ID, 'id': APP_ID, 'loc_name': appinfo['title'], 'package_format_version': 2,
                      'services': services, 'vendor': appinfo.get('vendor', ''), 'version': VERSION}, indent=1).encode()
    add_dir(t, 'usr/palm/packages/' + APP_ID)
    ti = tarfile.TarInfo('./usr/palm/packages/%s/packageinfo.json' % APP_ID)
    ti.size = len(pkg); ti.mtime = MTIME; ti.mode = 0o644
    t.addfile(ti, io.BytesIO(pkg))


data = tar_gz(data_tar)
size_kb = max(1, len(data) // 1024)
control_txt = ('Package: %s\nVersion: %s\nSection: misc\nPriority: optional\nArchitecture: all\n'
               'Installed-Size: %d\nMaintainer: %s\nDescription: %s\n'
               'webOS-Package-Format-Version: 2\nwebOS-Packager-Version: x.y.x\n') % (
    APP_ID, VERSION, size_kb * 3, appinfo.get('vendor', 'unknown'), appinfo['title'])


def control_tar(t):
    b = control_txt.encode()
    ti = tarfile.TarInfo('./control'); ti.size = len(b); ti.mtime = MTIME; ti.mode = 0o644
    t.addfile(ti, io.BytesIO(b))


control = tar_gz(control_tar)


def ar_member(name, data):
    hdr = '%-16s%-12d%-6d%-6d%-8s%-10d`\n' % (name, MTIME, 0, 0, '100644', len(data))
    return hdr.encode() + data + (b'\n' if len(data) % 2 else b'')


os.makedirs(OUT, exist_ok=True)
out = os.path.join(OUT, '%s_%s_all.ipk' % (APP_ID, VERSION))
with open(out, 'wb') as f:
    f.write(b'!<arch>\n')
    f.write(ar_member('debian-binary', b'2.0\n'))
    f.write(ar_member('control.tar.gz', control))
    f.write(ar_member('data.tar.gz', data))
print(out, os.path.getsize(out), 'bytes')
