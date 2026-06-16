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
