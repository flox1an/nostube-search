import { franc, francAll } from 'franc-min';
import langs from 'langs';

import { normalizeLanguage } from '../language.js';

export type LanguageDetectionInput = {
  title: string;
  summary: string;
  content: string | null;
};

export type LanguageDetection = {
  language: string | null;
  confidence: number;
  source: 'local';
};

function compactText(input: LanguageDetectionInput): string {
  return [input.title, input.summary, input.content ?? '']
    .map(value => value.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 2_000);
}

function iso3ToLanguage(iso3: string): string | null {
  const match = langs.where('3', iso3) ?? langs.where('2', iso3);
  return normalizeLanguage(match?.['1'] ?? iso3);
}

export function detectLanguageLocally(input: LanguageDetectionInput): LanguageDetection | null {
  const text = compactText(input);
  if (text.length < 40) return null;

  const language3 = franc(text, { minLength: 40 });
  if (language3 === 'und') return null;

  const ranked = francAll(text, { minLength: 40 });
  const top = ranked[0];
  const second = ranked[1];
  if (!top || top[0] !== language3) return null;

  // franc-min scores are similarity scores: higher is better. Keep only clearly
  // separated winners so short, mixed, or name-heavy metadata stays unclassified.
  const confidence = Math.max(0, Math.min(1, top[1] - (second?.[1] ?? 0)));
  if (confidence < 0.08) return null;

  const language = iso3ToLanguage(language3);
  return language ? { language, confidence, source: 'local' } : null;
}
