'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
module.exports = function (dir) {
  const resolved = path.resolve(dir), base = path.resolve(os.tmpdir());
  if (!resolved.startsWith(base + path.sep) || !/^b-(?:forward|routes|soap-http|server)-/.test(path.basename(resolved))) throw new Error('Unexpected B interface fixture directory');
  if (fs.rmSync) fs.rmSync(resolved, { recursive: true, force: true });
  else fs.rmdirSync(resolved, { recursive: true });
};
