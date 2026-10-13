import type { TranscriptSegment } from '../../../shared/types';

export interface ReadingSegment {
  key: string;
  start: number;
  end: number;
  original?: string;
  translation?: string;
}

export function mergeTranscript(text: string | undefined, segments: TranscriptSegment[] = []): string {
  return text?.trim() ? text : segments.map((segment) => segment.text.trim()).filter(Boolean).join('\n');
}

export function pairSegments(original: TranscriptSegment[], translated: TranscriptSegment[]): ReadingSegment[] {
  const used = new Set<number>();
  const matches = new Map<number, number>();
  const ids = new Map<number, number[]>();
  const times = new Map<string, number[]>();
  const timeKey = (segment: TranscriptSegment): string | undefined => Number.isFinite(segment.start) && Number.isFinite(segment.end)
    ? `${Math.round(segment.start * 1000)}:${Math.round(segment.end * 1000)}` : undefined;
  translated.forEach((segment, index) => {
    const idMatches = ids.get(segment.id);
    if (idMatches) idMatches.push(index); else ids.set(segment.id, [index]);
    const key = timeKey(segment);
    if (key !== undefined) {
      const timeMatches = times.get(key);
      if (timeMatches) timeMatches.push(index); else times.set(key, [index]);
    }
  });
  // Reserve every ID match first. A missing translation must never consume the
  // next segment's matching ID simply because it occupies the same array index.
  original.forEach((segment, index) => {
    const match = ids.get(segment.id)?.find((candidate) => !used.has(candidate));
    if (match !== undefined) { matches.set(index, match); used.add(match); }
  });
  const hasSharedIds = matches.size > 0;
  original.forEach((segment, index) => {
    if (matches.has(index)) return;
    const key = timeKey(segment);
    const match = key === undefined ? undefined : times.get(key)?.find((candidate) => !used.has(candidate));
    if (match !== undefined) { matches.set(index, match); used.add(match); }
  });
  if (!hasSharedIds) original.forEach((_, index) => {
    if (!matches.has(index) && index < translated.length && !used.has(index)) { matches.set(index, index); used.add(index); }
  });
  const rows: ReadingSegment[] = original.map((segment, index) => ({
    key: `original-${segment.id}-${index}`, start: segment.start, end: segment.end,
    original: segment.text, translation: translated[matches.get(index) ?? -1]?.text
  }));
  translated.forEach((segment, index) => {
    if (!used.has(index)) rows.push({ key: `translation-${segment.id}-${index}`, start: segment.start, end: segment.end, original: undefined, translation: segment.text });
  });
  return rows.sort((a, b) => a.start - b.start || a.end - b.end);
}

export function formatTimestamp(seconds: number): string {
  const milliseconds = Math.round((Number.isFinite(seconds) ? Math.max(0, seconds) : 0) * 1000);
  const wholeSeconds = Math.floor(milliseconds / 1000);
  const hour = Math.floor(wholeSeconds / 3600);
  const minute = Math.floor(wholeSeconds / 60) % 60;
  const second = wholeSeconds % 60;
  return `${hour ? `${String(hour).padStart(2, '0')}:` : ''}${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`;
}

export function literalMatches(text: string, query: string): Array<{ start: number; end: number }> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const expression = new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  return Array.from(text.matchAll(expression), (match) => ({ start: match.index, end: match.index + match[0].length }));
}
