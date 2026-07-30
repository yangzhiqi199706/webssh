'use strict';

function firstText(values) {
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function normalizeToken(value) {
  const token = firstText([value]);
  return /^Bearer\s+/i.test(token) ? token.replace(/^Bearer\s+/i, '').trim() : token;
}

function objectLevels(payload) {
  const levels = [];
  let current = payload;
  for (let i = 0; i < 3 && current && typeof current === 'object' && !Array.isArray(current); i += 1) {
    levels.push(current);
    current = current.data;
  }
  return levels;
}

function extractLoginSession(payload) {
  const levels = objectLevels(payload);
  const tokenValues = [];
  const userLshValues = [];
  levels.forEach(function (data) {
    tokenValues.push(data.token, data.Token, data.auth, data.Auth, data.authorization, data.Authorization);
    userLshValues.push(data.UserLsh, data.userLsh, data.userlsh, data.userId, data.UserId);
  });
  return {
    token: normalizeToken(firstText(tokenValues)),
    userLsh: firstText(userLshValues),
  };
}

function buildSessionHeaders(token) {
  const normalized = normalizeToken(token);
  // 8086 的 FastCGI 链路不会透传 Authorization，但会保留 token 请求头。
  return normalized ? { token: normalized } : {};
}

function isSessionExpired(payload) {
  return !!(payload && typeof payload === 'object' && Number(payload.code) === 300);
}

function shouldRetryLoginWithPlain(payload) {
  return !!(
    payload && typeof payload === 'object' &&
    Object.prototype.hasOwnProperty.call(payload, 'code') &&
    Number(payload.code) >= 300
  );
}

module.exports = {
  extractLoginSession: extractLoginSession,
  buildSessionHeaders: buildSessionHeaders,
  isSessionExpired: isSessionExpired,
  shouldRetryLoginWithPlain: shouldRetryLoginWithPlain,
};
