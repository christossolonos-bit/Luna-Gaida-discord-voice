export type MemorySource = 'desktop' | 'discord' | 'system';
export type PrivacyClass = 'public' | 'private' | 'secret';

export interface MemoryRecord {
  id: string;
  content: string;
  summary: string | null;
  tags: string[];
  source: MemorySource;
  privacy: PrivacyClass;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

export interface MemoryWriteInput {
  content: string;
  tags?: string[];
  source: MemorySource;
  privacy: PrivacyClass;
  retentionDays?: number | null;
}

export interface MemoryStore {
  write(input: MemoryWriteInput): MemoryRecord | Promise<MemoryRecord>;
  search(query: string, options: { allowPrivate: boolean; limit?: number }): MemoryRecord[] | Promise<MemoryRecord[]>;
  listForContext(surface: 'desktop' | 'discord' | 'browser', limit?: number, tags?: string[]): MemoryRecord[] | Promise<MemoryRecord[]>;
}
