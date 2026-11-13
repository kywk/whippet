import { useCallback, useEffect, useState } from 'react';

const TAGS_STORAGE_KEY = 'whippet.testTags.v1';
const TAGS_EVENT = 'whippet:test-tags-changed';

export type TagsByTest = Record<string, string[]>;

function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#+/, '').trim().slice(0, 32);
}

export function readAllTestTags(): TagsByTest {
  try {
    const raw = localStorage.getItem(TAGS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: TagsByTest = {};
    for (const [testId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        const clean = [...new Set(value.filter((item): item is string => typeof item === 'string').map(normalizeTag).filter(Boolean))];
        if (clean.length > 0) result[testId] = clean;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function writeAllTestTags(next: TagsByTest): void {
  try {
    localStorage.setItem(TAGS_STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent(TAGS_EVENT));
  } catch {
    // Ignore storage quota errors
  }
}

export function useAllTestTags() {
  const [tagsByTest, setTagsByTest] = useState<TagsByTest>(readAllTestTags);

  useEffect(() => {
    const sync = () => setTagsByTest(readAllTestTags());
    window.addEventListener(TAGS_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(TAGS_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const setTagsForTest = useCallback((testId: string, tags: string[]) => {
    const current = readAllTestTags();
    const clean = [...new Set(tags.map(normalizeTag).filter(Boolean))].slice(0, 20);
    const next: TagsByTest = { ...current };
    if (clean.length > 0) next[testId] = clean;
    else delete next[testId];
    writeAllTestTags(next);
    setTagsByTest(next);
  }, []);

  const addTagForTest = useCallback((testId: string, rawInput: string) => {
    const parts = rawInput.split(/[,，\s]+/).map(normalizeTag).filter(Boolean);
    if (parts.length === 0) return;
    const current = readAllTestTags();
    const existing = current[testId] ?? [];
    const merged = [...new Set([...existing, ...parts])].slice(0, 20);
    const next: TagsByTest = { ...current, [testId]: merged };
    writeAllTestTags(next);
    setTagsByTest(next);
  }, []);

  const removeTagForTest = useCallback((testId: string, tagToRemove: string) => {
    const current = readAllTestTags();
    const existing = current[testId] ?? [];
    const filtered = existing.filter((tag) => tag !== tagToRemove);
    const next: TagsByTest = { ...current };
    if (filtered.length > 0) next[testId] = filtered;
    else delete next[testId];
    writeAllTestTags(next);
    setTagsByTest(next);
  }, []);

  return {
    tagsByTest,
    setTagsForTest,
    addTagForTest,
    removeTagForTest,
  };
}
