import type { ResearchQueueEntry, ResearchQueueFile } from "../contracts/schemas.js"

export function enqueueResearch(
  file: ResearchQueueFile,
  entry: ResearchQueueEntry,
  dailyCap: number,
): ResearchQueueFile {
  const dedupeKey = entry.subject.toLowerCase()
  if (file.entries.some((e) => e.subject.toLowerCase() === dedupeKey)) {
    return file
  }
  if (file.entries.length >= dailyCap * 10) {
    return file
  }
  return {
    schema: 1,
    entries: [...file.entries, entry].sort((a, b) => b.priority - a.priority),
  }
}

export function dequeueDue(
  file: ResearchQueueFile,
  nowIso: string,
  limit: number,
): { next: ResearchQueueFile; due: ResearchQueueEntry[] } {
  const now = Date.parse(nowIso)
  const due: ResearchQueueEntry[] = []
  const remain: ResearchQueueEntry[] = []
  for (const entry of file.entries) {
    if (due.length < limit && Date.parse(entry.expiresAt) >= now) {
      due.push(entry)
    } else if (Date.parse(entry.expiresAt) >= now) {
      remain.push(entry)
    }
  }
  return { next: { schema: 1, entries: remain }, due }
}

export function expireQueue(file: ResearchQueueFile, nowIso: string): ResearchQueueFile {
  const now = Date.parse(nowIso)
  return {
    schema: 1,
    entries: file.entries.filter((e) => Date.parse(e.expiresAt) >= now),
  }
}
