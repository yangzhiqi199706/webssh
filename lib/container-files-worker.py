"""Executed in the selected container; requests arrive on stdin, never in shell arguments."""
import base64
import json
import os
import stat
import sys

LIMIT = 32 * 1024 * 1024


def run(req):
    op = req['op']
    if op == 'probe':
        return True
    p = req.get('path')
    if not isinstance(p, str) or not os.path.isabs(p) or '\0' in p:
        raise ValueError('需要绝对路径')
    p = os.path.normpath(p)
    if op in ('read', 'write'):
        real = os.path.realpath(p)
        if any(real == root or real.startswith(root + '/') for root in ('/dev', '/proc', '/sys')):
            raise ValueError('不支持读写虚拟系统文件或设备文件')
    if op == 'readdir':
        result = []
        with os.scandir(p) as entries:
            for entry in entries:
                s = entry.stat(follow_symlinks=False)
                result.append({'filename': entry.name, 'longname': stat.filemode(s.st_mode),
                               'attrs': {'size': s.st_size, 'mtime': int(s.st_mtime)}})
                if len(result) > 20000:
                    raise ValueError('目录条目超过 20000 项')
        return result
    if op == 'read':
        fd = os.open(p, os.O_RDONLY | getattr(os, 'O_NONBLOCK', 0))
        with os.fdopen(fd, 'rb') as f:
            if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
                raise ValueError('仅支持普通文件')
            data = f.read(LIMIT + 1)
        if len(data) > LIMIT:
            raise ValueError('文件超过 32 MiB')
        return base64.b64encode(data).decode('ascii')
    if op == 'write':
        data = base64.b64decode(req['data'], validate=True)
        if len(data) > LIMIT:
            raise ValueError('文件超过 32 MiB')
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | getattr(os, 'O_NONBLOCK', 0), 0o666)
        with os.fdopen(fd, 'wb') as f:
            if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
                raise ValueError('仅支持普通文件')
            f.truncate(0)
            f.write(data)
    elif op == 'mkdir':
        os.mkdir(p)
    elif op == 'unlink':
        os.unlink(p)
    elif op == 'rename':
        dest = req['dest']
        if not isinstance(dest, str) or not os.path.isabs(dest) or '\0' in dest:
            raise ValueError('需要绝对路径')
        os.rename(p, dest)
    else:
        raise ValueError('未知文件操作')
    return True


try:
    raw = sys.stdin.buffer.read(LIMIT * 2 + 1)
    if len(raw) > LIMIT * 2:
        raise ValueError('请求过大')
    print(json.dumps({'result': run(json.loads(raw))}, ensure_ascii=True))
except Exception as exc:
    print(json.dumps({'error': str(exc)}, ensure_ascii=True))
    sys.exit(1)
