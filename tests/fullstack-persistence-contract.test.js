'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const installers = [
  path.join(root, 'scripts', 'install-all.sh'),
  path.join(root, 'scripts', 'install-all-arm64.sh'),
];

installers.forEach(function (installerPath) {
  const script = fs.readFileSync(installerPath, 'utf8');
  assert.match(script, /PERSISTED_SERIAL_BRIDGE_CONFIG/, path.basename(installerPath) + ' must preserve serial bridge config');
  assert.match(script, /PROTOCOL_RUNTIME_DIRS=/, path.basename(installerPath) + ' must preserve protocol runtime folders');
  assert.match(script, /protocol-runtime-data/, path.basename(installerPath) + ' must stage protocol runtime data during upgrades');
});

console.log('fullstack persistence contract: passed');
