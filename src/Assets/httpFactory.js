import axios from 'axios';
import { message } from 'antd';
import NProgress from 'nprogress';
import 'nprogress/nprogress.css';
import { t } from '../i18n';

let needLoadingRequestCount = 0;

function hideLoading() {
  needLoadingRequestCount -= 1;
  needLoadingRequestCount = Math.max(needLoadingRequestCount, 0);
  if (needLoadingRequestCount === 0) {
    NProgress.done();
  }
}

export function createHttpClient({
  baseURL,
  contentType,
  successCodes = [100],
  fallbackI18nKey = 'http.requestFailed',
  failReturn = 'data',
  withProgress = true,
}) {
  const http = axios.create({
    baseURL,
    timeout: 300000,
    crossDomain: true,
  });

  if (contentType) {
    http.defaults.headers.post['Content-Type'] = contentType;
  }

  if (withProgress) {
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
  }

  http.interceptors.response.use(
    (response) => {
      if (withProgress && response.config.headers.showLoading !== false) {
        hideLoading();
      }
      if (response.data && response.data.code === 300) {
        message.error(t('auth.sessionExpired'));
        return null;
      }
      if (response.data && successCodes.includes(response.data.code)) {
        return response.data;
      }
      message.error((response.data && response.data.msg) || t(fallbackI18nKey));
      return failReturn === 'null' ? null : response.data;
    },
    (error) => {
      if (withProgress) {
        hideLoading();
      }
      if (error.response && error.response.status) {
        return Promise.reject(error.response);
      }
      return Promise.reject(error.response);
    }
  );

  return http;
}
