export type EntryCategory = 'logins' | 'servers' | 'tokens' | 'notes';

export type AuthScreenMode = 'welcome' | 'create' | 'unlock';

export interface VaultProfile {
  ownerName: string;
  activeVaultFile: string;
  knownVaults: string[];
  autoLockOnBackground: boolean;
}

export interface VaultEntry {
  id: string;
  title: string;
  username: string;
  password: string;
  url?: string;
  notes?: string;
  monogram?: string;
  tag?: string;
  category?: EntryCategory;
  updatedAt: Date;
}

export interface VaultState {
  isUnlocked: boolean;
  filePath: string | null;
  fileName: string;
  ownerName: string;
  entries: VaultEntry[];
}

export const FILTERS: { id: 'all' | EntryCategory; label: string }[] = [
  { id: 'all', label: 'Tümü' },
  { id: 'logins', label: 'Girişler' },
  { id: 'servers', label: 'Sunucular' },
  { id: 'tokens', label: 'Tokenlar' },
  { id: 'notes', label: 'Notlar' },
];
