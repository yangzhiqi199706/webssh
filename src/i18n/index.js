import zhCN from './dictionaries/zh-CN';
import enUS from './dictionaries/en-US';
import auto from './dictionaries/auto';
import autoExtra from './dictionaries/auto-extra';

const dictionaries = {
  'zh-CN': { ...zhCN, auto: { ...(auto['zh-CN'] || {}), ...(autoExtra['zh-CN'] || {}) } },
  'en-US': { ...enUS, auto: { ...(auto['en-US'] || {}), ...(autoExtra['en-US'] || {}) } },
};

const DEFAULT_LOCALE = 'zh-CN';

const isObject = (value) => value !== null && typeof value === 'object';

const getByPath = (source, path) => {
  if (!path) return undefined;
  return path.split('.').reduce((current, segment) => {
    if (!isObject(current)) return undefined;
    return current[segment];
  }, source);
};

const resolveLocale = () => {
  const saved = localStorage.getItem('app_locale');
  if (saved && dictionaries[saved]) {
    return saved;
  }
  return DEFAULT_LOCALE;
};

export const getLocale = () => resolveLocale();

export const setLocale = (locale) => {
  if (dictionaries[locale]) {
    localStorage.setItem('app_locale', locale);
  }
};

export const t = (key, fallback = '') => {
  const locale = resolveLocale();
  const active = dictionaries[locale] || dictionaries[DEFAULT_LOCALE];
  const value = getByPath(active, key);
  if (typeof value === 'string') return value;
  const defaultValue = getByPath(dictionaries[DEFAULT_LOCALE], key);
  if (typeof defaultValue === 'string') return defaultValue;
  return fallback || key;
};

const I18N_TOKEN_PREFIX = '__i18n__.';

export const resolveI18nToken = (value) => {
  if (typeof value !== 'string') return value;
  if (!value.startsWith(I18N_TOKEN_PREFIX)) return value;
  return t(value.slice(I18N_TOKEN_PREFIX.length), value);
};

export const localizeDeep = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => localizeDeep(item));
  }
  if (isObject(value)) {
    const output = {};
    Object.keys(value).forEach((key) => {
      output[key] = localizeDeep(value[key]);
    });
    return output;
  }
  return resolveI18nToken(value);
};

export default t;
