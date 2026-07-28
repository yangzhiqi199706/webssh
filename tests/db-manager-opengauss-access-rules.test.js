'use strict';

const assert = require('assert');
const rules = require('../lib/opengauss-access-rules');

const source = [
  '# local rule is not managed by WebSSH',
  'local all all trust',
  'host all all 0.0.0.0/0 sha256',
  'host dcim dcim 192.168.0.0/24 sha256',
  'host dcim dcim 192.168.50.0/24 sha256',
  'host otherapp otherdb 198.51.100.0/24 scram-sha-256',
  ''
].join('\n');

assert.strictEqual(rules.normalizeIpv4Cidr('192.168.50.0/24'), '192.168.50.0/24');
assert.strictEqual(rules.normalizeIpv4Cidr('0.0.0.0/0'), '0.0.0.0/0');
assert.throws(() => rules.normalizeIpv4Cidr('192.168.50.12/24'), /网络地址/);
assert.throws(() => rules.normalizeIpv4Cidr('192.168.50.0/33'), /CIDR/);
assert.throws(() => rules.normalizeIpv4Cidr('192.168.256.0/24'), /CIDR/);
assert.throws(() => rules.normalizeIpv4Cidr('192.168.50/24'), /CIDR/);
assert.throws(() => rules.normalizeIpv4Cidr('01.2.3.0/24'), /CIDR/);
assert.throws(() => rules.normalizeIpv4Cidr('192.168.0.0/08'), /CIDR/);

const legacy = rules.readManagedRules(source);
assert.deepStrictEqual(legacy.rules, ['192.168.0.0/24', '192.168.50.0/24']);
assert.strictEqual(legacy.hasManagedBlock, false);
assert.strictEqual(legacy.globalAllowWarning, true);
assert.strictEqual(rules.readManagedRules('local all all trust\n').globalAllowWarning, false);

const replaced = rules.writeManagedRules(source, ['192.168.50.0/24', '192.168.50.0/24']);
assert.match(replaced, /# webssh:dcim-cidr-begin/);
assert.match(replaced, /host    dcim    dcim    192\.168\.50\.0\/24    sha256/);
assert.doesNotMatch(replaced, /^host\s+dcim\s+dcim\s+192\.168\.0\.0\/24\s+sha256/m);
assert.match(replaced, /^host\s+all\s+all\s+0\.0\.0\.0\/0\s+sha256/m);
assert.match(replaced, /^host otherapp otherdb 198\.51\.100\.0\/24 scram-sha-256$/m);
assert.deepStrictEqual(rules.readManagedRules(replaced).rules, ['192.168.50.0/24']);

const appended = rules.writeManagedRules(replaced, ['192.168.50.0/24', '192.0.2.0/24']);
assert.deepStrictEqual(rules.readManagedRules(appended).rules, ['192.168.50.0/24', '192.0.2.0/24']);

assert.throws(() => rules.readManagedRules('# webssh:dcim-cidr-begin\n'), /标记块/);
assert.throws(() => rules.readManagedRules('# webssh:dcim-cidr-end\n'), /标记块/);
assert.throws(() => rules.readManagedRules('# webssh:dcim-cidr-begin\n# webssh:dcim-cidr-end\n# webssh:dcim-cidr-begin\n# webssh:dcim-cidr-end\n'), /多个/);
assert.throws(() => rules.readManagedRules('# webssh:dcim-cidr-end\n# webssh:dcim-cidr-begin\n'), /顺序错误/);
assert.throws(() => rules.readManagedRules('# webssh:dcim-cidr-begin\nhost all all 10.0.0.0/8 sha256\n# webssh:dcim-cidr-end\n'), /只允许/);

const spacedMarkers = '  # webssh:dcim-cidr-begin  \n' +
  'host dcim dcim 203.0.113.0/24 sha256\n' +
  '\t# webssh:dcim-cidr-end\t\n';
assert.strictEqual(rules.readManagedRules(spacedMarkers).hasManagedBlock, true);
assert.deepStrictEqual(rules.readManagedRules(spacedMarkers).rules, ['203.0.113.0/24']);
assert.throws(() => rules.readManagedRules(' # webssh:dcim-cidr-begin\n# webssh:dcim-cidr-end\n # webssh:dcim-cidr-begin\n# webssh:dcim-cidr-end\n'), /多个/);
assert.throws(() => rules.writeManagedRules(' # webssh:dcim-cidr-begin\nhost dcim dcim 203.0.113.0/24 sha256\n', ['192.0.2.0/24']), /标记块/);

const crlfSource = 'header comment\r\n' +
  'host dcim dcim 192.168.0.0/24 sha256\r\n' +
  'host otherapp otherdb 198.51.100.0/24 scram-sha-256\r\n\r\n';
const crlfReplaced = rules.writeManagedRules(crlfSource, ['192.0.2.0/24']);
assert.strictEqual(crlfReplaced, 'header comment\r\n' +
  '# webssh:dcim-cidr-begin\r\n' +
  'host    dcim    dcim    192.0.2.0/24    sha256\r\n' +
  '# webssh:dcim-cidr-end\r\n' +
  'host otherapp otherdb 198.51.100.0/24 scram-sha-256\r\n\r\n');

console.log('openGauss access rules: OK');
