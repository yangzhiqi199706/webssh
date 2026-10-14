import base64
import hashlib
import json
import os
import pathlib
import re
import shutil
import sys
import tempfile
import time
try:
    import fcntl
except ImportError:
    fcntl = None

FILES = ['feature_flags.json', 'services.json', 'http_services.json', 'crontab_tasks.json', 'logging.json', 'runtime_env.json', 'sms_gateways.json', 'i18n_zh_cn.json', 'architecture_boundaries.json', 'legacy_module_map.json', 'service_launchers.json']
READONLY = {'architecture_boundaries.json', 'legacy_module_map.json', 'service_launchers.json'}
SECRET = re.compile(r'password|passwd|secret|token|credential|api.?key', re.I)


def target(root, name):
    if name not in FILES:
        raise ValueError('不允许访问此配置文件')
    p = root / name
    if p.is_symlink() or p.resolve().parent != root.resolve():
        raise ValueError('配置文件路径异常')
    if p.stat().st_size > 1024 * 1024:
        raise ValueError('配置文件超过大小限制')
    return p


def fields(value, path=None):
    result = []
    for key, item in value.items():
        current = (path or []) + [key]
        if isinstance(item, dict):
            result.extend(fields(item, current))
        else:
            secret = bool(SECRET.search(key))
            kind = 'boolean' if isinstance(item, bool) else 'number' if isinstance(item, (int, float)) else 'array' if isinstance(item, list) else 'string' if isinstance(item, str) else 'null'
            result.append({'path': current, 'value': '' if secret else item, 'secret': secret, 'hasValue': bool(item) if secret else False, 'type': kind})
    return result


def read_file(root, name):
    raw = target(root, name).read_bytes()
    value = json.loads(raw.decode('utf-8-sig'))
    if not isinstance(value, dict):
        raise ValueError('配置根节点必须为对象')
    return {'name': name, 'revision': hashlib.sha256(raw).hexdigest(), 'readonly': name in READONLY, 'fields': fields(value)}


def validate(key, old, value):
    if type(old) is not type(value) and not (type(old) is float and type(value) is int):
        raise ValueError('字段类型不匹配：' + key)
    if isinstance(value, str) and (len(value) > 8192 or '\x00' in value):
        raise ValueError('文本长度或内容无效：' + key)
    if type(value) in (int, float):
        if not __import__('math').isfinite(value) or value < 0 or value > 1e9:
            raise ValueError('数字超出允许范围：' + key)
        if key.lower().endswith('port') and (not isinstance(value, int) or not 1 <= value <= 65535):
            raise ValueError('端口必须为1至65535的整数')
    if isinstance(value, list):
        if len(value) > 1000 or any(type(x) not in (str, int, float, bool) for x in value):
            raise ValueError('数组只允许简单值，最多1000项')
        if 'backoff' in key and any(type(x) not in (int, float) or x < 0 for x in value):
            raise ValueError('退避时间必须为非负数字')
    if key == 'time' and isinstance(value, str) and not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', value):
        raise ValueError('时间格式必须为HH:MM')
    if key == 'minute' and (type(value) is not int or not 0 <= value <= 59):
        raise ValueError('分钟必须为0至59')


def save_file(root, name, revision, changes):
    if name in READONLY:
        raise ValueError('程序结构配置只读')
    p = target(root, name)
    if not isinstance(changes, list) or len(changes) > 500:
        raise ValueError('修改数量无效')
    lock = root / '.webssh-settings.lock'
    fd = None
    try:
        flags = os.O_CREAT | os.O_WRONLY | getattr(os, 'O_NOFOLLOW', 0)
        fd = os.open(str(lock), flags if fcntl else flags | os.O_EXCL, 0o600)
        if fcntl:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (FileExistsError, BlockingIOError):
        if fd is not None:
            os.close(fd)
        raise ValueError('另一个配置操作正在进行，请稍后重试')
    temp = None
    try:
        raw = p.read_bytes()
        if hashlib.sha256(raw).hexdigest() != revision:
            raise ValueError('配置已被其他操作修改，请刷新后重试')
        data = json.loads(raw.decode('utf-8-sig'))
        for change in changes:
            keys = change.get('path')
            if not isinstance(keys, list) or not keys or not all(isinstance(k, str) for k in keys):
                raise ValueError('字段路径无效')
            parent = data
            for key in keys[:-1]:
                if not isinstance(parent, dict) or key not in parent:
                    raise ValueError('字段不存在')
                parent = parent[key]
            key = keys[-1]
            if not isinstance(parent, dict) or key not in parent or isinstance(parent[key], dict):
                raise ValueError('字段不存在或不可编辑')
            value = change.get('value')
            if SECRET.search(key) and value == '':
                continue
            validate(key, parent[key], value)
            parent[key] = value
        backups = root / '.webssh-backups'
        backups.mkdir(mode=0o700, exist_ok=True)
        if backups.is_symlink():
            raise ValueError('备份目录异常')
        backup = backups / (name + '.' + str(time.time_ns()))
        backup.write_bytes(raw)
        os.chmod(str(backup), 0o600)
        temp_fd, temp = tempfile.mkstemp(prefix='.webssh-', dir=str(root))
        with os.fdopen(temp_fd, 'w', encoding='utf-8') as out:
            json.dump(data, out, ensure_ascii=False, indent=2, allow_nan=False)
            out.write('\n')
            out.flush()
            os.fsync(out.fileno())
        shutil.copymode(str(p), temp)
        if hasattr(os, 'chown'):
            st = p.stat()
            os.chown(temp, st.st_uid, st.st_gid)
        if p.read_bytes() != raw:
            raise ValueError('配置保存期间发生外部修改，请刷新后重试')
        os.replace(temp, str(p))
        temp = None
        result = read_file(root, name)
        result['backup'] = backup.name
        result['restartRequired'] = True
        return result
    finally:
        if temp:
            os.unlink(temp)
        os.close(fd)
        if not fcntl:
            lock.unlink()


def snapshot(root):
    versions = {}
    # 仅检查目录内普通JSON文件，不读取备份、锁文件或符号链接目标。
    paths = sorted(root.glob('*.json'))
    if len(paths) > 500:
        raise ValueError('配置文件过多，无法检查变化')
    for p in paths:
        if p.is_symlink():
            versions[p.name] = 'symlink'
            continue
        if not p.is_file():
            versions[p.name] = 'not-regular-file'
            continue
        try:
            with p.open('rb') as stream:
                raw = stream.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise ValueError('配置文件过大，无法检查变化')
            versions[p.name] = hashlib.sha256(raw).hexdigest()
        except FileNotFoundError:
            continue
    return {'versions': versions}


def main(request):
    root = pathlib.Path(request['directory'])
    if not root.is_dir():
        raise ValueError('目标配置目录不存在')
    if request['action'] == 'snapshot':
        return snapshot(root)
    if request['action'] == 'list':
        return {'files': [{'name': n, 'exists': (root / n).is_file(), 'readonly': n in READONLY} for n in FILES]}
    if request['action'] == 'read':
        return read_file(root, request['name'])
    if request['action'] == 'save':
        return save_file(root, request['name'], request['revision'], request['changes'])
    raise ValueError('未知操作')


if __name__ == '__main__':
    try:
        print(json.dumps({'ok': True, 'data': main(json.loads(base64.b64decode(sys.argv[1])))}, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({'ok': False, 'message': str(exc) if isinstance(exc, ValueError) else '配置读取或写入失败，请检查目录、文件权限及JSON格式'}, ensure_ascii=False))
