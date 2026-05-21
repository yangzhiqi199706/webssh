import { createHttpClient } from './httpFactory';
import { localApiBase } from '../config/endpoints';

const baseURL = localApiBase;

const http = createHttpClient({
  baseURL,
  contentType: 'application/json;charset=UTF-8',
  successCodes: [100, 400],
  fallbackI18nKey: 'http.requestFailed',
  failReturn: 'data',
  withProgress: false,
});

export default http;
