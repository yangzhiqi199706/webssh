'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.resolve(__dirname, '..', 'scripts', 'install-all.sh'),
  'utf8'
);

assert.match(
  source,
  /VC="\$VC" SECRET="\$SECRET" python3 - <<'PYUPD'/,
  '更新已有视频配置时必须将 VC 和 SECRET 显式传给 Python 进程'
);

console.log('install video config environment: OK');
