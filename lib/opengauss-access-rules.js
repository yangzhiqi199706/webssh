'use strict';

const BEGIN = '# webssh:dcim-cidr-begin';
const END = '# webssh:dcim-cidr-end';
const LEGACY_RE = /^\s*host\s+dcim\s+dcim\s+([0-9.]+\/\d+)\s+sha256\s*$/i;
const GLOBAL_ALLOW_RE = /^\s*host\s+all\s+all\s+0\.0\.0\.0\/0\s+sha256\s*$/im;

function normalizeIpv4Cidr(value) {
  const text = String(value || '').trim();
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(text);
  if (!match) throw new Error('CIDR 必须是 IPv4 网络地址，例如 192.168.50.0/24');

  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (octets.some((part) => part > 255) || prefix > 32) throw new Error('CIDR 非法');

  const address = (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]);
  if (address % Math.pow(2, 32 - prefix) !== 0) {
    throw new Error('CIDR 必须使用网络地址，主机位必须为 0');
  }
  return octets.join('.') + '/' + prefix;
}

function uniqueCidrs(values) {
  const seen = Object.create(null);
  return (values || []).map(normalizeIpv4Cidr).filter((cidr) => {
    if (seen[cidr]) return false;
    seen[cidr] = true;
    return true;
  });
}

function readManagedRules(contents) {
  const text = String(contents || '');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const begins = lines.filter((line) => line === BEGIN).length;
  const ends = lines.filter((line) => line === END).length;
  if ((begins || ends) && (begins !== 1 || ends !== 1)) {
    throw new Error('HBA 受管标记块存在多个或不完整标记');
  }

  const begin = lines.indexOf(BEGIN);
  const end = lines.indexOf(END);
  if (begin >= 0 && begin >= end) throw new Error('HBA 受管标记块顺序错误');

  const candidates = begin >= 0 ? lines.slice(begin + 1, end) : lines;
  const found = [];
  candidates.forEach((line) => {
    if (!line.trim()) return;
    const match = LEGACY_RE.exec(line);
    if (match) found.push(match[1]);
    else if (begin >= 0) throw new Error('HBA 受管标记块只允许 dcim sha256 CIDR 规则');
  });

  return {
    rules: uniqueCidrs(found),
    hasManagedBlock: begin >= 0,
    globalAllowWarning: GLOBAL_ALLOW_RE.test(text)
  };
}

function writeManagedRules(contents, values) {
  const lines = String(contents || '').replace(/\r\n/g, '\n').split('\n');
  const current = readManagedRules(contents);
  const rules = uniqueCidrs(values);
  const block = [BEGIN].concat(rules.map((cidr) => (
    'host    dcim    dcim    ' + cidr + '    sha256'
  )), [END]);

  if (current.hasManagedBlock) {
    const begin = lines.indexOf(BEGIN);
    const end = lines.indexOf(END);
    return lines.slice(0, begin).concat(block, lines.slice(end + 1)).join('\n');
  }

  const retained = lines.filter((line) => !LEGACY_RE.test(line));
  while (retained.length && retained[retained.length - 1] === '') retained.pop();
  return retained.concat([''], block, ['']).join('\n');
}

module.exports = {
  normalizeIpv4Cidr: normalizeIpv4Cidr,
  readManagedRules: readManagedRules,
  writeManagedRules: writeManagedRules
};
