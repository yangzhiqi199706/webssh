const RUNTIME_ENDPOINTS = (typeof window !== 'undefined' && window.__RUNTIME_ENDPOINTS__) || {};

const DEV_MODE = process.env.NODE_ENV === 'development';
const PROTOCOL = typeof window !== 'undefined' ? window.location.protocol : 'http:';
const HOSTNAME = typeof window !== 'undefined' ? window.location.hostname : 'localhost';

const APP_PORT = process.env.REACT_APP_APP_PORT || RUNTIME_ENDPOINTS.appPort || '8081';
const MAIN_API_PORT = process.env.REACT_APP_MAIN_API_PORT || RUNTIME_ENDPOINTS.mainApiPort || '8086';
const VIDEO_API_PORT = process.env.REACT_APP_VIDEO_API_PORT || RUNTIME_ENDPOINTS.videoApiPort || '18080';

function normalizeHost(host) {
  return String(host || HOSTNAME)
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    .split(':')[0];
}

function buildOrigin(host, port) {
  return `${PROTOCOL}//${normalizeHost(host)}:${port}`;
}

function joinUrl(base, path) {
  const cleanBase = String(base || '').replace(/\/+$/, '');
  const cleanPath = String(path || '').replace(/^\/+/, '');
  if (!cleanPath) return `${cleanBase}/`;
  return `${cleanBase}/${cleanPath}`;
}

export const appBase = buildOrigin(HOSTNAME, APP_PORT);
export const mainApiBase = buildOrigin(HOSTNAME, MAIN_API_PORT);
export const videoApiBase = buildOrigin(HOSTNAME, VIDEO_API_PORT);

export const localApiBase = process.env.REACT_APP_LOCAL_API_BASE
  || RUNTIME_ENDPOINTS.localApiBase
  || (DEV_MODE ? '/api/local/' : joinUrl(mainApiBase, 'api/local'));

export function buildMainApiUrl(path, host = HOSTNAME) {
  return joinUrl(buildOrigin(host, MAIN_API_PORT), path);
}

