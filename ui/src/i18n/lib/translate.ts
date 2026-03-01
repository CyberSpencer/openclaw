import { de } from "../locales/de.ts";
import { en } from "../locales/en.ts";
import { pt_BR } from "../locales/pt-BR.ts";
import { zh_CN } from "../locales/zh-CN.ts";
import { zh_TW } from "../locales/zh-TW.ts";
import type { Locale, TranslationMap } from "./types.ts";

type Subscriber = (locale: Locale) => void;

export const SUPPORTED_LOCALES: ReadonlyArray<Locale> = ["en", "zh-CN", "zh-TW", "pt-BR", "de"];

export function isSupportedLocale(value: string | null | undefined): value is Locale {
  return value !== null && value !== undefined && SUPPORTED_LOCALES.includes(value as Locale);
}

const LOCALE_STORAGE_KEY = "openclaw.i18n.locale";
const BUILTIN_TRANSLATIONS: Record<Locale, TranslationMap> = {
  en,
  "zh-CN": zh_CN,
  "zh-TW": zh_TW,
  "pt-BR": pt_BR,
  de,
};

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function resolveLocalStorage(): StorageLike | null {
  const candidate = (globalThis as { localStorage?: unknown }).localStorage;
  if (!candidate || typeof candidate !== "object") {
    return null;
  }
  const storage = candidate as Partial<StorageLike>;
  if (typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
    return null;
  }
  return storage as StorageLike;
}

function resolveNavigatorLanguage(): string {
  const nav = (globalThis as { navigator?: { language?: unknown } }).navigator;
  return typeof nav?.language === "string" ? nav.language : "en";
}

class I18nManager {
  private locale: Locale = "en";
  private translations: Record<Locale, TranslationMap> = { ...BUILTIN_TRANSLATIONS };
  private subscribers: Set<Subscriber> = new Set();

  constructor() {
    this.loadLocale();
  }

  private resolveInitialLocale(): Locale {
    const storage = resolveLocalStorage();
    const saved = storage?.getItem(LOCALE_STORAGE_KEY);
    if (isSupportedLocale(saved)) {
      return saved;
    }
    const navLang = resolveNavigatorLanguage();
    if (navLang.startsWith("zh")) {
      return navLang === "zh-TW" || navLang === "zh-HK" ? "zh-TW" : "zh-CN";
    }
    if (navLang.startsWith("pt")) {
      return "pt-BR";
    }
    if (navLang.startsWith("de")) {
      return "de";
    }
    return "en";
  }

  private loadLocale() {
    const initialLocale = this.resolveInitialLocale();
    if (initialLocale === "en") {
      this.locale = "en";
      return;
    }
    // Keep locale+dictionary consistent: only switch locale after its bundle is loaded.
    void this.setLocale(initialLocale);
  }

  public getLocale(): Locale {
    return this.locale;
  }

  public async setLocale(locale: Locale) {
    const hadTranslation = Boolean(this.translations[locale]);
    if (!hadTranslation && BUILTIN_TRANSLATIONS[locale]) {
      this.translations[locale] = BUILTIN_TRANSLATIONS[locale];
    }

    const needsTranslationLoad = !this.translations[locale];
    const localeChanged = this.locale !== locale;
    if (!localeChanged && !needsTranslationLoad) {
      return;
    }

    if (needsTranslationLoad) {
      return;
    }

    this.locale = locale;
    resolveLocalStorage()?.setItem(LOCALE_STORAGE_KEY, locale);
    if (localeChanged || needsTranslationLoad) {
      this.notify();
    }
  }

  public registerTranslation(locale: Locale, map: TranslationMap) {
    this.translations[locale] = map;
  }

  public subscribe(sub: Subscriber) {
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  private notify() {
    this.subscribers.forEach((sub) => sub(this.locale));
  }

  public t(key: string, params?: Record<string, string>): string {
    const keys = key.split(".");
    let value: unknown = this.translations[this.locale] || this.translations["en"];

    for (const k of keys) {
      if (value && typeof value === "object") {
        value = (value as Record<string, unknown>)[k];
      } else {
        value = undefined;
        break;
      }
    }

    // Fallback to English
    if (value === undefined && this.locale !== "en") {
      value = this.translations["en"];
      for (const k of keys) {
        if (value && typeof value === "object") {
          value = (value as Record<string, unknown>)[k];
        } else {
          value = undefined;
          break;
        }
      }
    }

    if (typeof value !== "string") {
      return key;
    }

    if (params) {
      return value.replace(/\{(\w+)\}/g, (_, k) => params[k] || `{${k}}`);
    }

    return value;
  }
}

export const i18n = new I18nManager();
export const t = (key: string, params?: Record<string, string>) => i18n.t(key, params);
