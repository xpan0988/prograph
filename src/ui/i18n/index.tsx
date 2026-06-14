import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { en, type TranslationKey } from "./en";
import { zhCN } from "./zh-CN";

export type Locale = "en" | "zh-CN";
export type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

const STORAGE_KEY = "prograph.language";
const dictionaries: Record<Locale, Record<TranslationKey, string>> = { en, "zh-CN": zhCN };

export function detectLanguage(language?: string | null): Locale {
  return language?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function initialLanguage(storage?: Pick<Storage, "getItem">, browserLanguage?: string | null): Locale {
  const saved = typeof storage?.getItem === "function" ? storage.getItem(STORAGE_KEY) : undefined;
  if (saved === "en" || saved === "zh-CN") return saved;
  return detectLanguage(browserLanguage);
}

export function translate(locale: Locale, key: string, values: Record<string, string | number> = {}): string {
  const fallback = en[key as TranslationKey];
  const template = dictionaries[locale][key as TranslationKey] ?? fallback ?? key;
  return Object.entries(values).reduce((value, [name, replacement]) => value.replaceAll(`{${name}}`, String(replacement)), template);
}

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Translate;
}

const I18nContext = createContext<I18nValue>({
  locale: "en",
  setLocale: () => undefined,
  t: (key, values) => translate("en", key, values),
});

export function I18nProvider({ children, language }: { children: React.ReactNode; language?: Locale | undefined }): React.ReactElement {
  const [locale, setLocale] = useState<Locale>(() => language ?? initialLanguage(
    typeof localStorage === "undefined" ? undefined : localStorage,
    typeof navigator === "undefined" ? undefined : navigator.language,
  ));

  useEffect(() => {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, locale);
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale;
      document.title = translate(locale, "app.title");
    }
  }, [locale]);

  const value = useMemo<I18nValue>(() => ({
    locale,
    setLocale,
    t: (key, values) => translate(locale, key, values),
  }), [locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
