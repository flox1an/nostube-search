const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'was',
  'one', 'our', 'out', 'get', 'has', 'him', 'his', 'how', 'its', 'new',
  'now', 'see', 'two', 'who', 'did', 'let', 'say', 'she', 'too', 'use',
  'via', 'this', 'that', 'with', 'from', 'have', 'been', 'will', 'they',
  'what', 'when', 'your', 'more', 'than', 'then', 'into', 'some', 'also',
  'about', 'after', 'other', 'their', 'there', 'these', 'which', 'would',
])

export type WordSource = {
  title: string
  tags: string[]
  authorDisplayName: string | null
}

function extractWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length >= 3 && !STOPWORDS.has(w))
}

export function collectWords(docs: WordSource[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const doc of docs) {
    const seen = new Set<string>()
    const sources: string[] = [doc.title, ...doc.tags]
    if (doc.authorDisplayName) sources.push(doc.authorDisplayName)
    for (const src of sources) {
      for (const word of extractWords(src)) {
        if (!seen.has(word)) {
          seen.add(word)
          counts.set(word, (counts.get(word) ?? 0) + 1)
        }
      }
    }
  }
  return counts
}

export function mergeWordCounts(target: Map<string, number>, source: Map<string, number>): void {
  for (const [word, count] of source) {
    target.set(word, (target.get(word) ?? 0) + count)
  }
}
