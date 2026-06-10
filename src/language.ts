const LANGUAGE_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;

export function normalizeLanguage(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().replace(/_/g, '-').toLowerCase();
  if (!LANGUAGE_RE.test(normalized)) return null;
  return normalized;
}

export function normalizeLanguages(input: string | string[] | undefined): string[] {
  const raw = Array.isArray(input)
    ? input.flatMap(value => value.split(','))
    : typeof input === 'string'
      ? input.split(',')
      : [];

  return [...new Set(raw
    .map(value => normalizeLanguage(value))
    .filter((value): value is string => Boolean(value)))];
}

export function firstLanguageTag(tags: string[][]): string | null {
  for (const name of ['language', 'lang', 'locale']) {
    const tag = tags.find(entry => entry[0] === name && typeof entry[1] === 'string');
    const normalized = normalizeLanguage(tag?.[1]);
    if (normalized) return normalized;
  }
  return null;
}
