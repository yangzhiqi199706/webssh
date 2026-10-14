#!/usr/bin/env node
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto'), cp = require('child_process');
const root = path.resolve(__dirname, '..');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const stamp = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
const source = path.join(root, 'proto-conv/b-interface-alarm-db.js');
const output = path.join(root, 'dist');
const staging = path.join(root, 'output/b-alarm-db-hotfix', stamp);
fs.mkdirSync(output, { recursive: true });
const artifacts = [];
for (const arch of ['arm64', 'x64']) {
  const release = 'webssh-b-alarm-db-hotfix-linux-' + arch + '-' + stamp;
  const dir = path.join(staging, release);
  fs.mkdirSync(path.join(dir, 'payload'), { recursive: true });
  fs.copyFileSync(source, path.join(dir, 'payload/b-interface-alarm-db.js'));
  fs.copyFileSync(path.join(root, 'scripts/hotfix-b-alarm-db/install.sh'), path.join(dir, 'install.sh'));
  fs.writeFileSync(path.join(dir, 'ARCH'), arch + '\n');
  const readme = fs.readFileSync(path.join(root, 'scripts/hotfix-b-alarm-db/README.md'), 'utf8')
    .split('__ARCH__').join(arch).split('__RELEASE__').join(release);
  fs.writeFileSync(path.join(dir, 'README.md'), readme);
  const manifest = { name: release, architecture: arch, createdAt: new Date().toISOString(),
    changes: ['proto-conv/b-interface-alarm-db.js'], payloadSha256: sha(source),
    runtimeIncluded: false, productionDeployed: false };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const files = ['ARCH', 'README.md', 'install.sh', 'manifest.json', 'payload/b-interface-alarm-db.js'];
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), files.map(file => sha(path.join(dir, file)) + '  ' + file).join('\n') + '\n');
  const archive = path.join(output, release + '.tar.gz');
  cp.execFileSync('tar', ['-czf', archive, '-C', staging, release], { stdio: 'inherit' });
  fs.writeFileSync(archive + '.sha256', sha(archive) + '  ' + path.basename(archive) + '\n');
  // Read the actual archive, not only the staging directory, to verify the delivered payload.
  const packaged = cp.execFileSync('tar', ['-xOf', archive, release + '/payload/b-interface-alarm-db.js']);
  const packagedHash = crypto.createHash('sha256').update(packaged).digest('hex');
  if (packagedHash !== manifest.payloadSha256) throw new Error('归档补丁与源码不一致：' + arch);
  artifacts.push({ archive, sha256: sha(archive), payloadSha256: packagedHash, architecture: arch });
}
if (artifacts[0].payloadSha256 !== artifacts[1].payloadSha256) throw new Error('两种架构的补丁源码不一致');
fs.writeFileSync(path.join(output, 'webssh-b-alarm-db-hotfix-' + stamp + '.verification.json'),
  JSON.stringify({ artifacts, archivePayloadVerified: true, productionDeployed: false }, null, 2) + '\n');
console.log(JSON.stringify(artifacts, null, 2));
