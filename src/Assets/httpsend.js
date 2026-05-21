import axios from 'axios';
import request from '../Assets/httpload';
import requestnode from '../Assets/httploadnode';
import httploadvideo from '../Assets/httploadvideo';
import { appBase, mainApiBase } from '../config/endpoints';
import { t } from '../i18n';

const VIDEO_TOKEN_KEY = 'videoToken';
const VIDEO_LOGIN_PATH = 'api/user/login';
let videoTokenCache = '';

function getStoredVideoToken() {
  if (videoTokenCache) return videoTokenCache;
  const token = sessionStorage.getItem(VIDEO_TOKEN_KEY) || localStorage.getItem(VIDEO_TOKEN_KEY) || '';
  videoTokenCache = token;
  return token;
}

function setStoredVideoToken(token) {
  const val = String(token || '').trim();
  if (!val) return;
  videoTokenCache = val;
  sessionStorage.setItem(VIDEO_TOKEN_KEY, val);
}

function extractVideoToken(res) {
  var data = (res && res.data) ? res.data : null;
  var candidates = [
    res && res.videoToken,
    res && res.token,
    res && res.accessToken,
    res && res['access-token'],
    data && data.videoToken,
    data && data.token,
    data && data.accessToken,
    data && data['access-token'],
  ];

  for (var i = 0; i < candidates.length; i++) {
    var v = candidates[i];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

export default {
  mainURL() {
    return `${appBase}/`;
  },
  viewURL() {
    return `${mainApiBase}/`;
  },
  getData(url, data) {
    return request({
      url,
      method: 'post',
      data,
    });
  },
  getDataLocal(url, data) {
    return requestnode({
      url,
      method: 'post',
      data,
    }).then((res) => {
      if (!res || url !== 'imgData') return res;
      const action = data && data.action;
      if (action !== 'upload' && action !== 'system') return res;
      if (!Array.isArray(res.data)) return res;
      return {
        ...res,
        data: res.data.filter((item) => item && typeof item.imgUrl === 'string' && item.imgUrl.trim() !== ''),
      };
    });
  },
  getDataVideo(url, data, config = {}) {
    const isLogin = String(url || '').includes(VIDEO_LOGIN_PATH);
    const headers = { ...(config.headers || {}) };

    if (!isLogin) {
      const token = getStoredVideoToken();
      if (token) headers['access-token'] = token;
    }

    return httploadvideo({
      url,
      method: 'get',
      data,
      ...config,
      headers,
    }).then((res) => {
      if (isLogin) {
        const token = extractVideoToken(res);
        if (token) setStoredVideoToken(token);
      }
      return res;
    });
  },
  async handlePostSubmit(url, formData) {
    try {
      const result = await axios.post(url, formData, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });
      return result.data;
    } catch (err) {
      console.error(t('http.postError'), err);
      return false;
    }
  },
};

