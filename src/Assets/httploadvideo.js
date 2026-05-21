import { createHttpClient } from './httpFactory';
import { videoApiBase } from '../config/endpoints';

const baseURL = `${videoApiBase}/`;

const http = createHttpClient({
  baseURL,
  contentType: 'multipart/form-data;application/json;charset=UTF-8;',
  successCodes: [100, 0, 200],
  fallbackI18nKey: 'http.videoRequestFailed',
  failReturn: 'data',
  withProgress: true,
});

export default http;

