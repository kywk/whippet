import { useEffect, useState } from 'react';

const TAGS_STORAGE_KEY = 'whippet.testTags.v1';
export const MAX_TEST_TAGS = 20;

type TagsByTest = Record<string, string[]>;

function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#+/, '').trim().slice(0, 32);
}

export function parseTagInput(raw: string): string[] {
  return raw.split(/[,，\s]+/).map(normalizeTag).filter(Boolean);
}

function readLegacyTestTags(): TagsByTest {
  try {
    const raw = localStorage.getItem(TAGS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: TagsByTest = {};
    for (const [testId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        const clean = [...new Set(value.filter((item): item is string => typeof item === 'string').map(normalizeTag).filter(Boolean))];
        if (clean.length > 0) result[testId] = clean.slice(0, MAX_TEST_TAGS);
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function useLegacyTestTags() {
  const [tagsByTest, setTagsByTest] = useState(readLegacyTestTags);

  useEffect(() => {
    const sync = () => setTagsByTest(readLegacyTestTags());
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  return tagsByTest;
}
