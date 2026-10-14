'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const { checkDependencies } = require('../scripts/build-fullstack-arm64');
const base = path.resolve('output/arm-release-20261014'), root = path.join(base,'native-fixture-' + process.pid);
fs.mkdirSync(path.join(root,'node_modules/sax'),{recursive:true}); fs.mkdirSync(path.join(root,'node_modules/ssh2/util'),{recursive:true});
fs.writeFileSync(path.join(root,'node_modules/sax/package.json'),'{}'); fs.writeFileSync(path.join(root,'node_modules/ssh2/util/pagent.exe'),'windows-helper');
const file = path.join(root,'node_modules/fixture.node');
try {
  const arm = Buffer.alloc(24); arm.write('ELF',1,'ascii'); arm[0] = 127; arm[5] = 1; arm.writeUInt16LE(183,18); fs.writeFileSync(file,arm);
  checkDependencies(root); assert.ok(!fs.existsSync(path.join(root,'node_modules/ssh2/util/pagent.exe')));
  arm.writeUInt16LE(62,18); fs.writeFileSync(file,arm); assert.throws(()=>checkDependencies(root),/不兼容原生/);
  fs.unlinkSync(file); fs.unlinkSync(path.join(root,'node_modules/sax/package.json')); assert.throws(()=>checkDependencies(root),/sax/);
  console.log('PASS ARM dependencies: aarch64 native validation, x86 rejection, Windows helper omission, mandatory sax');
} finally {
  if(path.dirname(fs.realpathSync(root)) !== fs.realpathSync(base)) throw new Error('Unsafe fixture cleanup target');
  fs.rmSync(root,{recursive:true,force:true});
}
