// The page's two languages: which one is shown, and the texts of the markup that carry a key.

import { EN, type TextKey, ZH_TW } from "./texts";

export type Language = "en" | "zh-TW";

const TEXTS: Record<Language, Record<TextKey, string>> = { en: EN, "zh-TW": ZH_TW };
/** What the document's lang attribute says for each language. */
const DOCUMENT_LANGUAGE: Record<Language, string> = { en: "en", "zh-TW": "zh-Hant-TW" };

let current: Language = "en";
const listeners: Array<() => void> = [];

/** Returns the language a page starts in: the one its address asks for (?lang=en, ?lang=zh-TW), else Chinese
 * for a browser whose first language is Chinese, else English. */
export function initialLanguage(search: string, browserLanguages: readonly string[]): Language {
  const asked = new URLSearchParams(search).get("lang")?.toLowerCase();
  if (asked !== undefined) return asked.startsWith("zh") ? "zh-TW" : "en";

  return (browserLanguages[0] ?? "en").toLowerCase().startsWith("zh") ? "zh-TW" : "en";
}

export function language(): Language {
  return current;
}

/** Shows the page in ``next`` and tells whoever renders texts. */
export function setLanguage(next: Language): void {
  current = next;
  document.documentElement.lang = DOCUMENT_LANGUAGE[next];
  applyStaticTexts(document);
  for (const listener of listeners) listener();
}

export function onLanguageChange(listener: () => void): void {
  listeners.push(listener);
}

/** Returns the text ``key`` in the page's language, with each {name} replaced by ``values[name]``. */
export function t(key: TextKey, values: Readonly<Record<string, string | number>> = {}): string {
  return TEXTS[current][key].replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : whole,
  );
}

/** Returns ``names`` as a list in a sentence of the page's language. */
export function listed(names: readonly string[]): string {
  return names.join(current === "zh-TW" ? "、" : ", ");
}

/** Returns ``value`` with the digits grouped as the page's language writes a count. */
export function count(value: number): string {
  return value.toLocaleString(current === "zh-TW" ? "zh-TW" : "en-US");
}

/** Fills every element under ``root`` that names a text: data-i18n for its content, data-i18n-placeholder,
 * data-i18n-aria-label and data-i18n-title for the attribute of that name. */
export function applyStaticTexts(root: ParentNode): void {
  for (const element of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    element.textContent = t(element.dataset.i18n as TextKey);
  }
  for (const [attribute, name] of [
    ["placeholder", "i18nPlaceholder"],
    ["aria-label", "i18nAriaLabel"],
    ["title", "i18nTitle"],
  ] as const) {
    for (const element of root.querySelectorAll<HTMLElement>(`[data-i18n-${attribute}]`)) {
      element.setAttribute(attribute, t(element.dataset[name] as TextKey));
    }
  }
  document.title = t("page.title");
}
