import json, os, pathlib, subprocess, tarfile, tempfile

installer = pathlib.Path(os.environ['ARM_INSTALLER_SOURCE']).read_text(encoding='utf-8')

def write(path, content, executable=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding='utf-8')
    if executable: path.chmod(0o755)

def scenario(fail=False, wrong_arch=False, late_fail=False):
    with tempfile.TemporaryDirectory(prefix='webssh-arm-fixture-') as temp:
        root = pathlib.Path(temp)
        package, target, units, mocks = [root / n for n in ('package', 'target', 'units', 'mocks')]
        # Rewrite the fixed legacy unit path only inside this isolated fixture.
        write(package / 'scripts/install-all-arm64.sh', installer.replace('/etc/systemd/system', str(units)), True)
        write(package / 'app/server.js', '// new app')
        write(package / 'app/index.html', 'new app')
        (package / 'app/node_modules').mkdir()
        write(package / 'protocol/app/app.py', '# new protocol')
        write(package / 'systemd/webssh.service.template', 'NEW_MAIN __INSTALL_DIR__ __RUN_USER__')
        write(package / 'systemd/webssh-protocol.service.template', 'NEW_PROTO __INSTALL_DIR__ __RUN_USER__')
        (package / 'protocol/wheels').mkdir()
        write(package / 'protocol/wheels/fixture.whl', 'fixture')
        write(root / 'node-src/node-fixture/bin/node', '#!/bin/sh\ncase "$*" in *process.arch*) echo arm64;; *) echo v16.20.2;; esac\n', True)
        write(root / 'py-src/python/bin/python3', '#!/bin/sh\nif [ "$1" = --version ]; then echo "Python 3.11.10"; exit 0; fi\nif [ "$1" = -m ]; then if [ "${ARM_FIXTURE_FAIL:-0}" = 1 ]; then exit 27; fi; exit 0; fi\ncat >/dev/null\n', True)
        for source, archive, mode in [
            (root / 'node-src/node-fixture', package / 'runtime/node-v16.20.2-linux-arm64.tar.xz', 'w:xz'),
            (root / 'py-src/python', package / 'protocol/runtime/cpython-fixture-aarch64-unknown-linux-gnu-install_only.tar.gz', 'w:gz')
        ]:
            archive.parent.mkdir(parents=True, exist_ok=True)
            with tarfile.open(archive, mode) as out: out.add(source, arcname=source.name)
        originals = {
            target / 'app/server.js': 'OLD_APP',
            target / 'app/config/proto-conv.json': 'saved-source',
            target / 'app/config/proto-conv-b-interface.json': 'saved-b-state',
            target / 'protocol/app/app.py': 'OLD_PROTO',
            target / 'protocol/app/uploads/saved.txt': 'USER_UPLOAD',
            target / 'protocol/app/module4_config/j2k2_format_config.json': 'CUSTOM_RULE',
            target / 'runtime/node/bin/node': 'OLD_RUNTIME',
            target / 'config/.env': 'PORT=3010\nPROTOCOL_TARGET=http://127.0.0.1:5000\nCUSTOM=value\n',
            units / 'webssh.service': 'OLD_MAIN_UNIT',
            units / 'webssh-protocol.service': 'OLD_PROTO_UNIT'
        }
        for path, content in originals.items(): write(path, content)
        write(mocks / 'systemctl', '#!/bin/sh\nprintf "%s\\n" "$*" >> "$ARM_FIXTURE_LOG"\ncase "$1" in is-active) echo active;; list-unit-files) printf "webssh.service enabled\\nwebssh-protocol.service enabled\\n";; esac\n', True)
        write(mocks / 'uname', '#!/bin/sh\necho "${ARM_FIXTURE_ARCH:-aarch64}"\n', True)
        write(mocks / 'curl', '#!/bin/sh\ncase "$*" in *http_code*) if [ "${ARM_FIXTURE_HEALTH_FAIL:-0}" = 1 ]; then printf 503; else printf 200; fi;; *) printf \'{"ok":true}\';; esac\n', True)
        write(mocks / 'sleep', '#!/bin/sh\nexit 0\n', True)
        env = dict(os.environ, PATH=str(mocks) + ':' + os.environ['PATH'], INSTALL_DIR=str(target), SERVICE_UNIT_DIR=str(units), ARM_FIXTURE_LOG=str(root / 'service.log'), ARM_FIXTURE_FAIL='1' if fail else '0', ARM_FIXTURE_ARCH='x86_64' if wrong_arch else 'aarch64', ARM_FIXTURE_HEALTH_FAIL='1' if late_fail else '0')
        run = subprocess.run(['bash', str(package / 'scripts/install-all-arm64.sh')], env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, timeout=30)
        if wrong_arch:
            assert run.returncode != 0, 'Wrong architecture accepted'
            assert not (root / 'service.log').exists(), 'Architecture rejection changed services'
            checked = originals
        elif fail or late_fail:
            assert run.returncode != 0, 'Failure fixture unexpectedly passed'
            checked = originals
        else:
            assert run.returncode == 0, run.stdout[-3000:]
            checked = {p:c for p,c in originals.items() if '/app/config/' in str(p) or '/uploads/' in str(p) or '/module4_config/' in str(p)}
        for path, expected in checked.items():
            assert path.exists() and path.read_text(encoding='utf-8') == expected, 'Lost preserved data/control file: ' + str(path.relative_to(root))
        return {'scenario': 'arch-rejection' if wrong_arch else 'late-health-rollback' if late_fail else 'rollback' if fail else 'upgrade-preserve', 'passed': True}

print(json.dumps([scenario(), scenario(fail=True), scenario(wrong_arch=True), scenario(late_fail=True)]))
