import axios from 'axios';
import { message } from 'antd';
import NProgress from 'nprogress';
import 'nprogress/nprogress.css';
import { t } from '../i18n';

const baseURL = `${window.location.protocol}//${window.location.hostname}:8086/`;

const http = axios.create({
  baseURL,
  timeout: 300000,
  crossDomain: true,
});

http.defaults.headers.post['Content-Type'] = 'multipart/form-data;application/json;charset=UTF-8;';

let needLoadingRequestCount = 0;

function hideLoading() {
  needLoadingRequestCount -= 1;
  needLoadingRequestCount = Math.max(needLoadingRequestCount, 0);
  if (needLoadingRequestCount === 0) {
    NProgress.done();
  }
}

let tempConfig = {};
http.interceptors.request.use(
  (config) => {
    tempConfig = config;
    tempConfig.url = decodeURI(encodeURI(tempConfig.url).replace('%E2%80%8B', ''));
    return config;
  },
  (err) => {
    if (tempConfig.headers && tempConfig.headers.showLoading !== false) {
      hideLoading();
    }
    message.error(t('http.requestTimeout'));
    return Promise.resolve(err);
  }
);

http.interceptors.response.use(
  (response) => {
    if (response.config.headers.showLoading !== false) {
      hideLoading();
    }
    if (response.data.code === 300) {
      message.error(t('auth.sessionExpired'));
      return null;
    }
    if (response.data.code === 100 || response.data.code === 400) {
      return response.data;
    }
    message.error(response.data.msg || t('http.requestFailed'));
    return null;
  },
  (error) => {
    hideLoading();
    if (error.response && error.response.status) {
      return Promise.reject(error.response);
    }
    return Promise.reject(error.response);
  }
);

export default http;