import { createHttpClient } from './httpFactory';
import { mainApiBase } from '../config/endpoints';

const baseURL = `${mainApiBase}/`;

const http = createHttpClient({
  baseURL,
  contentType: 'multipart/form-data;application/json;charset=UTF-8;',
  successCodes: [100],
  fallbackI18nKey: 'http.requestFailed',
  failReturn: 'data',
  withProgress: true,
});

export default http;
