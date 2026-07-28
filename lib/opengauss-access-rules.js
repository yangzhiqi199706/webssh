'use strict';

const BEGIN = '# webssh:dcim-cidr-begin';
const END = '# webssh:dcim-cidr-end';
const LEGACY_RE = /^\s*host\s+dcim\s+dcim\s+([0-9.]+\/\d+)\s+sha256\s*$/i;
const GLOBAL_ALLOW_RE = /^\s*host\s+all\s+all\s+0\.0\.0\.0\/0\s+sha256(?:\s*(?:#.*)?)?\s*$/im;

function normalizeIpv4Cidr(value) {
  const text = String(value || '').trim();
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(text);
  if (!match) throw new Error('CIDR 必须是 IPv4 网络地址，例如 192.168.50.0/24');

  const parts = match.slice(1);
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (parts.some((part) => part.length > 1 && part.charAt(0) === '0') ||
      octets.some((part) => part > 255) || prefix > 32) {
    throw new Error('CIDR 非法');
  }

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

function splitContents(contents) {
  const text = String(contents || '');
  const eol = text.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  return { text: text, eol: eol, lines: text.split(eol) };
}

function findMarkerIndexes(lines, marker) {
  const indexes = [];
  lines.forEach((line, index) => {
    if (line.trim() === marker) indexes.push(index);
  });
  return indexes;
}

function readManagedRules(contents) {
  const parsed = splitContents(contents);
  const begins = findMarkerIndexes(parsed.lines, BEGIN);
  const ends = findMarkerIndexes(parsed.lines, END);
  if ((begins.length || ends.length) && (begins.length !== 1 || ends.length !== 1)) {
    throw new Error('HBA 受管标记块存在多个或不完整标记');
  }

  const begin = begins.length ? begins[0] : -1;
  const end = ends.length ? ends[0] : -1;
  if (begin >= 0 && begin >= end) throw new Error('HBA 受管标记块顺序错误');

  const candidates = begin >= 0 ? parsed.lines.slice(begin + 1, end) : parsed.lines;
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
    globalAllowWarning: GLOBAL_ALLOW_RE.test(parsed.text)
  };
}

function writeManagedRules(contents, values) {
  const parsed = splitContents(contents);
  const current = readManagedRules(contents);
  const rules = uniqueCidrs(values);
  const block = [BEGIN].concat(rules.map((cidr) => (
    'host    dcim    dcim    ' + cidr + '    sha256'
  )), [END]);

  if (current.hasManagedBlock) {
    const begin = findMarkerIndexes(parsed.lines, BEGIN)[0];
    const end = findMarkerIndexes(parsed.lines, END)[0];
    return parsed.lines.slice(0, begin).concat(block, parsed.lines.slice(end + 1)).join(parsed.eol);
  }

  const legacyIndexes = [];
  parsed.lines.forEach((line, index) => {
    if (LEGACY_RE.test(line)) legacyIndexes.push(index);
  });
  if (!legacyIndexes.length) {
    const hasTrailingEol = parsed.text.slice(-parsed.eol.length) === parsed.eol;
    return parsed.text + (parsed.text && !hasTrailingEol ? parsed.eol : '') + block.join(parsed.eol);
  }

  const firstLegacy = legacyIndexes[0];
  const legacyIndexSet = Object.create(null);
  legacyIndexes.forEach((index) => { legacyIndexSet[index] = true; });
  const result = [];
  parsed.lines.forEach((line, index) => {
    if (index === firstLegacy) result.push.apply(result, block);
    if (!legacyIndexSet[index]) result.push(line);
  });
  return result.join(parsed.eol);
}

module.exports = {
  normalizeIpv4Cidr: normalizeIpv4Cidr,
  readManagedRules: readManagedRules,
  writeManagedRules: writeManagedRules
};
