import '../polyfills';
import { Buffer } from 'buffer';
import * as kdbxweb from 'kdbxweb';
import { File as ExpoFile } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { EntryCategory, VaultEntry, VaultProfile } from '../types/kdbx';
import { argon2Hash } from './argon2';

declare const global: {
  Buffer?: typeof Buffer;
  [key: string]: unknown;
};

global.Buffer = Buffer;

// Eski sürümde oluşturulmuş kasalar için geri dönüş (legacy fallback) fonksiyonu
async function legacyArgon2Fallback(
  password: ArrayBuffer,
  salt: ArrayBuffer,
  _memory: number,
  iterations: number,
  length: number
): Promise<ArrayBuffer> {
  const passBytes = new Uint8Array(password);
  const saltBytes = new Uint8Array(salt);
  const out = new Uint8Array(length);
  const combined = new Uint8Array(passBytes.length + saltBytes.length);
  combined.set(passBytes, 0);
  combined.set(saltBytes, passBytes.length);

  let state: ArrayBuffer = combined.buffer;
  const rounds = Math.max(1, Math.min(iterations * 16, 256));
  for (let r = 0; r < rounds; r++) {
    state = await kdbxweb.CryptoEngine.sha512(state);
  }

  const hashBytes = new Uint8Array(state);
  for (let i = 0; i < length; i++) {
    out[i] = hashBytes[i % hashBytes.length];
  }
  return out.buffer;
}

// Standart RFC 9106 Argon2 (Argon2d / Argon2i / Argon2id) motorunu varsayılan olarak etkinleştir
kdbxweb.CryptoEngine.setArgon2Impl(
  (password, salt, memory, iterations, length, parallelism, type, version) =>
    argon2Hash(
      password,
      salt,
      memory,
      iterations,
      length,
      parallelism,
      type,
      version
    )
);

const DEFAULT_VAULT_FILENAME = 'Personal.kdbx';
const PROFILE_FILENAME = 'airvault_profile.json';

export function deriveMonogram(title: string): string {
  const cleaned = title.trim();
  if (!cleaned) return 'AV';
  const parts = cleaned.split(/[\s\-_.]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return cleaned.slice(0, 2).toUpperCase();
}

export function formatVaultFileName(input: string): string {
  let decoded = input;
  try {
    decoded = decodeURIComponent(input);
  } catch {
    decoded = input;
  }
  const baseName = decoded.split(/[\\/:]+/).pop() || decoded;
  const cleaned = baseName
    .trim()
    .replace(/[\\/:*?"<>|%]+/g, '')
    .replace(/\s+/g, '_');
  if (!cleaned || cleaned.toLowerCase() === '.kdbx') {
    return DEFAULT_VAULT_FILENAME;
  }
  return cleaned.toLowerCase().endsWith('.kdbx') ? cleaned : `${cleaned}.kdbx`;
}

function getSecureStoreKey(fileName: string): string {
  const normalized = formatVaultFileName(fileName);
  const safeKey = normalized.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `airvault_bio_${safeKey}`;
}

export class KdbxService {
  private static instance: KdbxService;
  private db: kdbxweb.Kdbx | null = null;
  private masterPassword: string | null = null;
  private currentFilePath: string | null = null;
  private activeFileName: string = DEFAULT_VAULT_FILENAME;
  private ownerName: string = '';
  private knownVaults: string[] = [];
  private autoLockOnBackground: boolean = true;
  private memoryFallbackStore: Record<string, string> = {};
  private memorySecureStore: Record<string, string> = {};

  private constructor() {}

  public static getInstance(): KdbxService {
    if (!KdbxService.instance) {
      KdbxService.instance = new KdbxService();
    }
    return KdbxService.instance;
  }

  public getActiveFileName(): string {
    return this.activeFileName;
  }

  public setActiveFileName(fileName: string): void {
    const normalized = formatVaultFileName(fileName);
    this.activeFileName = normalized;
  }

  public getOwnerName(): string {
    return this.ownerName;
  }

  public getKnownVaults(): string[] {
    return [...this.knownVaults];
  }

  public getAutoLockOnBackground(): boolean {
    return this.autoLockOnBackground;
  }

  public getCurrentFilePath(): string | null {
    return this.currentFilePath;
  }

  public isVaultUnlocked(): boolean {
    return this.db !== null && this.masterPassword !== null;
  }

  private resolveFilePath(fileName?: string): string {
    const targetName = fileName
      ? formatVaultFileName(fileName)
      : this.activeFileName;
    const baseDir = FileSystem.documentDirectory ?? '';
    return `${baseDir}${targetName}`;
  }

  private getProfilePath(): string {
    const baseDir = FileSystem.documentDirectory ?? '';
    return `${baseDir}${PROFILE_FILENAME}`;
  }

  /**
   * Cihazın biyometrik doğrulama (Parmak İzi / FaceID) desteğini kontrol eder.
   */
  public async isBiometricSupported(): Promise<boolean> {
    try {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      if (!hasHardware) return false;
      const isEnrolled = await LocalAuthentication.isEnrolledAsync();
      return isEnrolled;
    } catch {
      return false;
    }
  }

  /**
   * Belirtilen kasa için kayıtlı biyometrik anahtar olup olmadığını döner.
   */
  public async isBiometricEnabledForVault(fileName?: string): Promise<boolean> {
    const target = fileName || this.activeFileName;
    const key = getSecureStoreKey(target);
    try {
      const stored = await SecureStore.getItemAsync(key);
      return Boolean(stored);
    } catch {
      return Boolean(this.memorySecureStore[key]);
    }
  }

  /**
   * Açık olan kasanın anahtarını SecureStore'a kaydeder veya siler.
   */
  public async setBiometricForCurrentVault(enable: boolean): Promise<boolean> {
    const key = getSecureStoreKey(this.activeFileName);

    if (!enable) {
      try {
        await SecureStore.deleteItemAsync(key);
      } catch {
        // Ignore
      }
      delete this.memorySecureStore[key];
      return false;
    }

    if (!this.masterPassword) {
      throw new Error('Biyometrik kayıt için kasanın açık olması gerekir.');
    }

    const supported = await this.isBiometricSupported();
    if (!supported) {
      throw new Error(
        'Cihazınızda aktif parmak izi veya yüz tanıma bulunamadı.'
      );
    }

    const auth = await LocalAuthentication.authenticateAsync({
      promptMessage: `${this.activeFileName} için biyometrik girişi doğrula`,
      cancelLabel: 'İptal',
    });

    if (!auth.success) {
      throw new Error('Biyometrik doğrulama iptal edildi.');
    }

    try {
      await SecureStore.setItemAsync(key, this.masterPassword);
    } catch {
      this.memorySecureStore[key] = this.masterPassword;
    }
    return true;
  }

  /**
   * Belirli bir kasa ve şifre için doğrudan biyometrik anahtarı kaydeder.
   */
  public async saveBiometricKeyDirect(
    fileName: string,
    password: string
  ): Promise<void> {
    const key = getSecureStoreKey(fileName);
    try {
      await SecureStore.setItemAsync(key, password);
    } catch {
      this.memorySecureStore[key] = password;
    }
  }

  /**
   * Parmak İzi / FaceID doğrulaması yaparak kasayı açar.
   */
  public async unlockWithBiometrics(fileName?: string): Promise<VaultEntry[]> {
    const targetFile = formatVaultFileName(fileName || this.activeFileName);
    const key = getSecureStoreKey(targetFile);

    let savedPassword: string | null = null;
    try {
      savedPassword = await SecureStore.getItemAsync(key);
    } catch {
      savedPassword = this.memorySecureStore[key] ?? null;
    }

    if (!savedPassword) {
      throw new Error(
        'Bu kasa için biyometrik giriş etkinleştirilmemiş. Lütfen şifrenizle girin.'
      );
    }

    const auth = await LocalAuthentication.authenticateAsync({
      promptMessage: `${targetFile} kasasını aç`,
      cancelLabel: 'Şifre ile Gir',
    });

    if (!auth.success) {
      throw new Error('Biyometrik doğrulama başarısız oldu.');
    }

    return this.openVault(savedPassword, targetFile);
  }

  /**
   * Kullanıcı profilini (isim, son kullanılan kasa ve cihazdaki .kdbx dosyaları) yükler.
   */
  public async loadProfile(): Promise<VaultProfile> {
    let savedOwner = this.ownerName;
    let savedActive = this.activeFileName;
    let savedAutoLock = this.autoLockOnBackground;
    const vaultSet = new Set<string>();

    const profilePath = this.getProfilePath();

    if (FileSystem.documentDirectory) {
      try {
        // Tek seferde dizin listesini alıp disk I/O tur sayısını 1'e indiriyoruz
        const dirFiles = (typeof FileSystem.readDirectoryAsync === 'function')
          ? await FileSystem.readDirectoryAsync(FileSystem.documentDirectory)
          : [];
        const existingFileSet = new Set(dirFiles.map((f) => f.toLowerCase()));

        if (existingFileSet.has(PROFILE_FILENAME.toLowerCase())) {
          try {
            const rawJson = await FileSystem.readAsStringAsync(profilePath);
            const parsed = JSON.parse(rawJson) as Partial<VaultProfile>;
            if (typeof parsed.ownerName === 'string') {
              savedOwner = parsed.ownerName;
            }
            if (
              typeof parsed.activeVaultFile === 'string' &&
              parsed.activeVaultFile.trim()
            ) {
              savedActive = formatVaultFileName(parsed.activeVaultFile);
            }
            if (typeof parsed.autoLockOnBackground === 'boolean') {
              savedAutoLock = parsed.autoLockOnBackground;
            }
            if (Array.isArray(parsed.knownVaults)) {
              for (const v of parsed.knownVaults) {
                if (typeof v === 'string' && v.trim()) {
                  const candidate = formatVaultFileName(v);
                  if (existingFileSet.has(candidate.toLowerCase())) {
                    vaultSet.add(candidate);
                  }
                }
              }
            }
          } catch {
            // Profil JSON parse hatasını yoksay
          }
        }

        // Keşfedilen tüm .kdbx dosyalarını ekle
        for (const f of dirFiles) {
          const lower = f.toLowerCase();
          if (lower.endsWith('.kdbx')) {
            vaultSet.add(f);
          }
        }
      } catch {
        // Dizin tarama hatasını yoksay
      }
    } else if (this.memoryFallbackStore[profilePath]) {
      try {
        const parsed = JSON.parse(
          this.memoryFallbackStore[profilePath]
        ) as Partial<VaultProfile>;
        if (typeof parsed.ownerName === 'string') savedOwner = parsed.ownerName;
        if (typeof parsed.activeVaultFile === 'string') {
          savedActive = formatVaultFileName(parsed.activeVaultFile);
        }
        if (typeof parsed.autoLockOnBackground === 'boolean') {
          savedAutoLock = parsed.autoLockOnBackground;
        }
        if (Array.isArray(parsed.knownVaults)) {
          parsed.knownVaults.forEach((v) =>
            vaultSet.add(formatVaultFileName(v))
          );
        }
      } catch {
        // Ignore
      }
    } else {
      for (const v of this.knownVaults) {
        if (await this.vaultExists(v)) {
          vaultSet.add(v);
        }
      }
    }

    this.ownerName = savedOwner;
    this.autoLockOnBackground = savedAutoLock;
    this.knownVaults = Array.from(vaultSet);
    if (
      this.knownVaults.length > 0 &&
      !this.knownVaults.includes(savedActive)
    ) {
      const ownerCandidate = savedOwner
        ? formatVaultFileName(savedOwner)
        : null;
      if (ownerCandidate && this.knownVaults.includes(ownerCandidate)) {
        savedActive = ownerCandidate;
      } else {
        savedActive = this.knownVaults[0];
      }
    }
    this.activeFileName = savedActive;

    return {
      ownerName: this.ownerName,
      activeVaultFile: this.activeFileName,
      knownVaults: [...this.knownVaults],
      autoLockOnBackground: this.autoLockOnBackground,
    };
  }

  /**
   * Kullanıcı adını, otomatik kilit ayarını ve aktif kasa bilgisini diske kaydeder.
   */
  public async saveProfile(
    updates: Partial<VaultProfile>
  ): Promise<VaultProfile> {
    if (updates.ownerName !== undefined) {
      this.ownerName = updates.ownerName.trim();
    }
    if (
      updates.activeVaultFile !== undefined &&
      updates.activeVaultFile.trim()
    ) {
      this.activeFileName = formatVaultFileName(updates.activeVaultFile);
    }
    if (typeof updates.autoLockOnBackground === 'boolean') {
      this.autoLockOnBackground = updates.autoLockOnBackground;
    }
    if (Array.isArray(updates.knownVaults)) {
      const merged = new Set<string>([
        ...this.knownVaults,
        ...updates.knownVaults.map(formatVaultFileName),
      ]);
      this.knownVaults = Array.from(merged);
    }

    const profile: VaultProfile = {
      ownerName: this.ownerName,
      activeVaultFile: this.activeFileName,
      knownVaults: [...this.knownVaults],
      autoLockOnBackground: this.autoLockOnBackground,
    };

    const profilePath = this.getProfilePath();
    const serialized = JSON.stringify(profile);

    try {
      if (FileSystem.documentDirectory) {
        await FileSystem.writeAsStringAsync(profilePath, serialized);
      } else {
        this.memoryFallbackStore[profilePath] = serialized;
      }
    } catch {
      // Yazma hatası durumunda bellek içi profil korunur
    }

    return profile;
  }

  /**
   * Dosyanın diskte var olup olmadığını kontrol eder.
   */
  public async vaultExists(fileName?: string): Promise<boolean> {
    const filePath = this.resolveFilePath(fileName);
    if (!FileSystem.documentDirectory) {
      return Boolean(this.memoryFallbackStore[filePath]);
    }
    try {
      const info = await FileSystem.getInfoAsync(filePath);
      if (info.exists) return true;
      const tmpInfo = await FileSystem.getInfoAsync(`${filePath}.tmp`);
      return tmpInfo.exists;
    } catch {
      return false;
    }
  }

  /**
   * ArrayBuffer çıktısını Base64'e çevirip doğrudan diske yazar.
   */
  private async saveToDiskAtomic(
    targetPath: string,
    arrayBuffer: ArrayBuffer
  ): Promise<void> {
    const base64Data = Buffer.from(arrayBuffer).toString('base64');

    if (!FileSystem.documentDirectory) {
      this.memoryFallbackStore[targetPath] = base64Data;
      return;
    }

    await FileSystem.writeAsStringAsync(targetPath, base64Data, {
      encoding: FileSystem.EncodingType.Base64,
    });
  }

  /**
   * Cihazın dosya seçicisini açarak harici bir .kdbx dosyasını uygulama içine yükler.
   */
  public async importVaultFromDevice(): Promise<{
    fileName: string;
    filePath: string;
  } | null> {
    const picked = await ExpoFile.pickFileAsync({
      multipleFiles: false,
      mimeTypes: '*/*',
    });

    if (picked.canceled || !picked.result) {
      return null;
    }

    const pickedFile = picked.result;
    const rawName = pickedFile.name || pickedFile.uri || 'Imported.kdbx';
    const safeName = formatVaultFileName(rawName);

    let exactBuffer: ArrayBuffer | null = null;

    // 1. Yöntem: ExpoFile.bytes() veya arrayBuffer()
    try {
      if (typeof pickedFile.bytes === 'function') {
        const bytes = await pickedFile.bytes();
        if (bytes && bytes.byteLength > 0) {
          exactBuffer = bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength
          ) as ArrayBuffer;
        }
      }
      if (!exactBuffer && typeof pickedFile.arrayBuffer === 'function') {
        const ab = await pickedFile.arrayBuffer();
        if (ab && ab.byteLength > 0) {
          exactBuffer = ab;
        }
      }
    } catch {
      // Fallback'e geç
    }

    // 2. Yöntem: ExpoFile.base64() veya FileSystem.readAsStringAsync
    if (!exactBuffer && pickedFile.uri) {
      try {
        const b64 =
          typeof pickedFile.base64 === 'function'
            ? await pickedFile.base64()
            : await FileSystem.readAsStringAsync(pickedFile.uri, {
                encoding: FileSystem.EncodingType.Base64,
              });
        if (b64) {
          const buf = Buffer.from(b64.trim(), 'base64');
          exactBuffer = buf.buffer.slice(
            buf.byteOffset,
            buf.byteOffset + buf.byteLength
          ) as ArrayBuffer;
        }
      } catch {
        // Ignore
      }
    }

    if (!exactBuffer || exactBuffer.byteLength < 64) {
      throw new Error('Seçilen dosya geçerli bir KDBX veritabanı değil.');
    }

    this.activeFileName = safeName;
    const targetPath = this.resolveFilePath(safeName);
    await this.saveToDiskAtomic(targetPath, exactBuffer);

    await this.saveProfile({
      activeVaultFile: safeName,
      knownVaults: [safeName],
    });

    return {
      fileName: safeName,
      filePath: targetPath,
    };
  }

  /**
   * Aktif .kdbx dosyasını işletim sisteminin paylaşım/önizleme ekranıyla dışa aktarır.
   */
  public async exportCurrentVault(): Promise<void> {
    const pathToExport =
      this.currentFilePath || this.resolveFilePath(this.activeFileName);
    const exists = await this.vaultExists(this.activeFileName);
    if (!exists) {
      throw new Error('Dışa aktarılacak bir kasa dosyası bulunamadı.');
    }

    const fileInstance = new ExpoFile(pathToExport);
    await fileInstance.preview({
      title: this.activeFileName,
      mimeType: 'application/octet-stream',
    });
  }

  /**
   * Belirtilen .kdbx kasa dosyasını diskten ve bilinen kasalar listesinden siler.
   */
  public async deleteVaultFile(fileName: string): Promise<VaultProfile> {
    const normalized = formatVaultFileName(fileName);
    const targetPath = this.resolveFilePath(normalized);

    if (this.currentFilePath === targetPath) {
      this.lockVault();
    }

    if (FileSystem.documentDirectory) {
      try {
        await FileSystem.deleteAsync(targetPath, { idempotent: true });
      } catch {
        // Ignore
      }
      try {
        await FileSystem.deleteAsync(`${targetPath}.tmp`, { idempotent: true });
      } catch {
        // Ignore
      }
    } else {
      delete this.memoryFallbackStore[targetPath];
    }

    const bioKey = getSecureStoreKey(normalized);
    try {
      await SecureStore.deleteItemAsync(bioKey);
    } catch {
      // Ignore
    }
    delete this.memorySecureStore[bioKey];

    this.knownVaults = this.knownVaults.filter((v) => v !== normalized);
    if (this.activeFileName === normalized) {
      this.activeFileName = this.knownVaults[0] || DEFAULT_VAULT_FILENAME;
    }

    const profile: VaultProfile = {
      ownerName: this.ownerName,
      activeVaultFile: this.activeFileName,
      knownVaults: [...this.knownVaults],
      autoLockOnBackground: this.autoLockOnBackground,
    };

    const profilePath = this.getProfilePath();
    try {
      if (FileSystem.documentDirectory) {
        await FileSystem.writeAsStringAsync(
          profilePath,
          JSON.stringify(profile)
        );
      } else {
        this.memoryFallbackStore[profilePath] = JSON.stringify(profile);
      }
    } catch {
      // Ignore
    }

    return profile;
  }

  /**
   * Açık olan kasanın Master Password'ünü (ana şifresini) değiştirir ve yeniden şifreleyerek kaydeder.
   */
  public async changeMasterPassword(
    currentPassword: string,
    newPassword: string
  ): Promise<void> {
    if (!this.db || !this.currentFilePath || !this.masterPassword) {
      throw new Error('Açık bir kasa oturumu bulunamadı.');
    }
    if (
      currentPassword !== this.masterPassword &&
      currentPassword.trim() !== this.masterPassword.trim()
    ) {
      throw new Error('Mevcut kasa şifrenizi yanlış girdiniz.');
    }
    if (!newPassword || newPassword.trim().length < 4) {
      throw new Error('Yeni şifre en az 4 karakter olmalıdır.');
    }

    this.db.credentials.setPassword(
      kdbxweb.ProtectedValue.fromString(newPassword)
    );

    const savedBuffer = await this.db.save();
    await this.saveToDiskAtomic(this.currentFilePath, savedBuffer);
    this.masterPassword = newPassword;

    const hasBio = await this.isBiometricEnabledForVault(this.activeFileName);
    if (hasBio) {
      await this.saveBiometricKeyDirect(this.activeFileName, newPassword);
    }
  }

  /**
   * Yeni ve tamamen temiz (sahte/örnek kayıt içermeyen) bir KDBX4 veritabanı oluşturur.
   */
  public async createVault(
    masterPassword: string,
    fileName?: string,
    ownerName?: string
  ): Promise<{ path: string; fileName: string; entries: VaultEntry[] }> {
    if (!masterPassword || !masterPassword.trim()) {
      throw new Error('Master Password boş olamaz.');
    }

    const cleanOwner =
      ownerName !== undefined ? ownerName.trim() : this.ownerName;
    if (cleanOwner) {
      this.ownerName = cleanOwner;
    }

    if (fileName && fileName.trim()) {
      this.setActiveFileName(fileName);
    } else if (cleanOwner) {
      this.setActiveFileName(`${cleanOwner}.kdbx`);
    }

    const credentials = new kdbxweb.Credentials(
      kdbxweb.ProtectedValue.fromString(masterPassword)
    );
    const vaultTitle = cleanOwner
      ? `${cleanOwner} Keyra`
      : this.activeFileName.replace(/\.kdbx$/i, '') || 'Keyra';
    const db = kdbxweb.Kdbx.create(credentials, vaultTitle);

    if (cleanOwner) {
      db.meta.defaultUser = cleanOwner;
    }

    db.setKdf(kdbxweb.Consts.KdfId.Aes);
    if (db.header.kdfParameters) {
      db.header.kdfParameters.set(
        'R',
        kdbxweb.VarDictionary.ValueType.UInt64,
        kdbxweb.Int64.from(2500)
      );
    }

    const filePath = this.resolveFilePath(this.activeFileName);
    const savedBuffer = await db.save();
    await this.saveToDiskAtomic(filePath, savedBuffer);

    this.db = db;
    this.masterPassword = masterPassword;
    this.currentFilePath = filePath;

    await this.saveProfile({
      ownerName: this.ownerName,
      activeVaultFile: this.activeFileName,
      knownVaults: [this.activeFileName],
    });

    return {
      path: filePath,
      fileName: this.activeFileName,
      entries: this.extractEntries(db),
    };
  }

  /**
   * Verilen ArrayBuffer ve şifre ile KDBX veritabanını yüklemeyi dener.
   * Hem standart RFC 9106 Argon2 (KeePass/KeePassXC/KeePassDX), hem AES-KDF,
   * hem klavye boşluk düzeltmesi, hem de eski sürüm Argon2 geri dönüşünü destekler.
   */
  private async tryLoadKdbxBuffer(
    exactArrayBuffer: ArrayBuffer,
    masterPassword: string,
    onProgress?: (status: string) => void
  ): Promise<{ db: kdbxweb.Kdbx; usedPassword: string; upgradedLegacy: boolean }> {
    const candidates = [masterPassword];
    if (masterPassword.trim() && masterPassword.trim() !== masterPassword) {
      candidates.push(masterPassword.trim());
    }

    // 1. Aşama: Standart RFC 9106 Argon2d / Argon2id + AES-KDF ile dene
    kdbxweb.CryptoEngine.setArgon2Impl(
      (password, salt, memory, iterations, length, parallelism, type, version) =>
        argon2Hash(
          password,
          salt,
          memory,
          iterations,
          length,
          parallelism,
          type,
          version,
          (pct) => {
            if (onProgress) onProgress(`Anahtar çözülüyor... %${pct}`);
          }
        )
    );

    let lastError: unknown = null;

    for (const candidatePw of candidates) {
      try {
        if (onProgress) onProgress('Kasa doğrulanıyor...');
        const creds = new kdbxweb.Credentials(
          kdbxweb.ProtectedValue.fromString(candidatePw)
        );
        const db = await kdbxweb.Kdbx.load(exactArrayBuffer.slice(0), creds);
        return { db, usedPassword: candidatePw, upgradedLegacy: false };
      } catch (err) {
        lastError = err;
      }
    }

    // 2. Aşama: Eski sürüm SHA-512 Argon2 fallback ile oluşturulmuş kasalar için dene
    kdbxweb.CryptoEngine.setArgon2Impl(legacyArgon2Fallback);
    try {
      for (const candidatePw of candidates) {
        try {
          const creds = new kdbxweb.Credentials(
            kdbxweb.ProtectedValue.fromString(candidatePw)
          );
          const db = await kdbxweb.Kdbx.load(exactArrayBuffer.slice(0), creds);
          return { db, usedPassword: candidatePw, upgradedLegacy: true };
        } catch (err) {
          lastError = err;
        }
      }
    } finally {
      // Her zaman standart RFC 9106 Argon2 motoruna geri dön
      kdbxweb.CryptoEngine.setArgon2Impl(
        (
          password,
          salt,
          memory,
          iterations,
          length,
          parallelism,
          type,
          version
        ) =>
          argon2Hash(
            password,
            salt,
            memory,
            iterations,
            length,
            parallelism,
            type,
            version
          )
      );
    }

    throw lastError || new Error('InvalidKey');
  }

  /**
   * Diskteki .kdbx dosyasının varlığını kontrol eder, Base64 olarak okur, ArrayBuffer'a çevirir ve kilidini açar.
   */
  public async openVault(
    masterPassword: string,
    fileName?: string,
    onProgress?: (status: string) => void
  ): Promise<VaultEntry[]> {
    if (!masterPassword) {
      throw new Error('Kasayı açmak için şifre girilmelidir.');
    }

    if (fileName && fileName.trim()) {
      this.setActiveFileName(fileName);
    }

    let filePath = this.resolveFilePath(this.activeFileName);
    let base64Data: string;

    if (onProgress) onProgress('Dosya okunuyor...');

    if (FileSystem.documentDirectory) {
      let fileInfo = await FileSystem.getInfoAsync(filePath);

      // Eğer .kdbx yoksa ama .kdbx.tmp varsa kurtar
      if (!fileInfo.exists) {
        const tmpInfo = await FileSystem.getInfoAsync(`${filePath}.tmp`);
        if (tmpInfo.exists) {
          const tmpB64 = await FileSystem.readAsStringAsync(`${filePath}.tmp`, {
            encoding: FileSystem.EncodingType.Base64,
          });
          await FileSystem.writeAsStringAsync(filePath, tmpB64, {
            encoding: FileSystem.EncodingType.Base64,
          });
          fileInfo = await FileSystem.getInfoAsync(filePath);
        }
      }

      // Eğer seçili dosya hâlâ yoksa (örn. varsayılan Personal.kdbx seçili kalmış ama diskte Kuzey.kdbx varsa)
      if (!fileInfo.exists) {
        await this.loadProfile();
        const ownerCandidate = this.ownerName
          ? formatVaultFileName(this.ownerName)
          : null;
        if (ownerCandidate && this.knownVaults.includes(ownerCandidate)) {
          this.activeFileName = ownerCandidate;
          filePath = this.resolveFilePath(this.activeFileName);
          fileInfo = await FileSystem.getInfoAsync(filePath);
        } else if (this.knownVaults.length > 0) {
          this.activeFileName = this.knownVaults[0];
          filePath = this.resolveFilePath(this.activeFileName);
          fileInfo = await FileSystem.getInfoAsync(filePath);
        }
      }

      if (!fileInfo.exists) {
        throw new Error(
          `Cihazda "${this.activeFileName}" adında bir kasa bulunamadı. Lütfen "Yeni Kasa" sekmesinden kasa oluşturun veya "+ Dosya Seç" ile .kdbx dosyanızı yükleyin.`
        );
      }

      base64Data = await FileSystem.readAsStringAsync(filePath, {
        encoding: FileSystem.EncodingType.Base64,
      });
    } else {
      if (!this.memoryFallbackStore[filePath]) {
        const availableKeys = Object.keys(this.memoryFallbackStore).filter((k) =>
          k.toLowerCase().endsWith('.kdbx')
        );
        if (availableKeys.length > 0) {
          filePath = availableKeys[0];
          this.activeFileName = formatVaultFileName(filePath);
        } else {
          throw new Error(
            `"${this.activeFileName}" bulunamadı. Lütfen önce yeni kasa oluşturun veya dosya yükleyin.`
          );
        }
      }
      base64Data = this.memoryFallbackStore[filePath];
    }

    // Base64 -> Buffer -> Kesin sınırlı ArrayBuffer dönüşümü
    const rawBuffer = Buffer.from(base64Data.trim(), 'base64');
    const exactArrayBuffer = rawBuffer.buffer.slice(
      rawBuffer.byteOffset,
      rawBuffer.byteOffset + rawBuffer.byteLength
    ) as ArrayBuffer;

    try {
      const { db, usedPassword, upgradedLegacy } = await this.tryLoadKdbxBuffer(
        exactArrayBuffer,
        masterPassword,
        onProgress
      );

      // Eski sürüm fallback ile açıldıysa standart formata yükselterek kaydet
      if (upgradedLegacy) {
        db.setKdf(kdbxweb.Consts.KdfId.Aes);
        if (db.header.kdfParameters) {
          db.header.kdfParameters.set(
            'R',
            kdbxweb.VarDictionary.ValueType.UInt64,
            kdbxweb.Int64.from(2500)
          );
        }
        const savedBuffer = await db.save();
        await this.saveToDiskAtomic(filePath, savedBuffer);
      }

      this.db = db;
      this.masterPassword = usedPassword;
      this.currentFilePath = filePath;

      if (!this.ownerName && db.meta.defaultUser) {
        this.ownerName = db.meta.defaultUser;
      }

      await this.saveProfile({
        ownerName: this.ownerName,
        activeVaultFile: this.activeFileName,
        knownVaults: [this.activeFileName],
      });

      return this.extractEntries(db);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'InvalidKey') {
        throw new Error(
          `"${this.activeFileName}" kasası için girdiğiniz ana şifre hatalı.`
        );
      }
      throw new Error(
        `"${this.activeFileName}" kasası açılamadı: Şifre hatalı veya .kdbx dosyası bozuk.`
      );
    }
  }

  /**
   * Açık olan veritabanının kök grubuna yeni bir KdbxEntry ekler ve diske yazar.
   */
  public async addEntry(
    entryData: Omit<VaultEntry, 'id' | 'updatedAt'>
  ): Promise<VaultEntry> {
    if (!this.db || !this.currentFilePath) {
      throw new Error('Açık bir kasa oturumu bulunamadı.');
    }

    const rootGroup = this.db.getDefaultGroup();
    const kdbxEntry = this.db.createEntry(rootGroup);

    const cleanTitle = entryData.title.trim();
    const cleanUser = entryData.username.trim();
    const monogram =
      entryData.monogram?.trim() || deriveMonogram(cleanTitle);
    const tag = entryData.tag?.trim() || 'AES-256';
    const category: EntryCategory = entryData.category || 'logins';

    kdbxEntry.fields.set('Title', cleanTitle);
    kdbxEntry.fields.set('UserName', cleanUser);
    kdbxEntry.fields.set(
      'Password',
      kdbxweb.ProtectedValue.fromString(entryData.password)
    );
    kdbxEntry.fields.set('Monogram', monogram);
    kdbxEntry.fields.set('Tag', tag);
    kdbxEntry.fields.set('Category', category);

    if (entryData.url !== undefined && entryData.url.trim()) {
      kdbxEntry.fields.set('URL', entryData.url.trim());
    }
    if (entryData.notes !== undefined && entryData.notes.trim()) {
      kdbxEntry.fields.set('Notes', entryData.notes.trim());
    }

    kdbxEntry.times.update();

    const savedBuffer = await this.db.save();
    await this.saveToDiskAtomic(this.currentFilePath, savedBuffer);

    return this.mapKdbxEntry(kdbxEntry);
  }

  /**
   * Mevcut bir kaydı UUID üzerinden bulup günceller ve diske kaydeder.
   */
  public async updateEntry(
    entryId: string,
    updatedData: Omit<VaultEntry, 'id' | 'updatedAt'>
  ): Promise<VaultEntry> {
    if (!this.db || !this.currentFilePath) {
      throw new Error('Açık bir kasa oturumu bulunamadı.');
    }

    const kdbxEntry = this.findEntryInGroup(
      this.db.getDefaultGroup(),
      entryId
    );
    if (!kdbxEntry) {
      throw new Error('Güncellenecek kayıt veritabanında bulunamadı.');
    }

    const cleanTitle = updatedData.title.trim();
    const cleanUser = updatedData.username.trim();
    const monogram =
      updatedData.monogram?.trim() || deriveMonogram(cleanTitle);
    const category: EntryCategory = updatedData.category || 'logins';

    kdbxEntry.fields.set('Title', cleanTitle);
    kdbxEntry.fields.set('UserName', cleanUser);
    kdbxEntry.fields.set(
      'Password',
      kdbxweb.ProtectedValue.fromString(updatedData.password)
    );
    kdbxEntry.fields.set('Monogram', monogram);
    kdbxEntry.fields.set('Category', category);

    if (updatedData.url !== undefined && updatedData.url.trim()) {
      kdbxEntry.fields.set('URL', updatedData.url.trim());
    } else {
      kdbxEntry.fields.delete('URL');
    }

    if (updatedData.notes !== undefined && updatedData.notes.trim()) {
      kdbxEntry.fields.set('Notes', updatedData.notes.trim());
    } else {
      kdbxEntry.fields.delete('Notes');
    }

    kdbxEntry.times.update();

    const savedBuffer = await this.db.save();
    await this.saveToDiskAtomic(this.currentFilePath, savedBuffer);

    return this.mapKdbxEntry(kdbxEntry);
  }

  /**
   * UUID üzerinden kaydı bulur, veritabanından siler ve dosyayı diske kaydeder.
   */
  public async deleteEntry(entryId: string): Promise<void> {
    if (!this.db || !this.currentFilePath) {
      throw new Error('Açık bir kasa oturumu bulunamadı.');
    }

    const removed = this.removeEntryFromGroup(
      this.db.getDefaultGroup(),
      entryId
    );
    if (!removed) {
      throw new Error('Silinecek kayıt veritabanında bulunamadı.');
    }

    const savedBuffer = await this.db.save();
    await this.saveToDiskAtomic(this.currentFilePath, savedBuffer);
  }

  /**
   * Bellekteki veritabanı referansını ve şifreyi sıfırlar.
   */
  public lockVault(): void {
    this.db = null;
    this.masterPassword = null;
    this.currentFilePath = null;
  }

  private findEntryInGroup(
    group: kdbxweb.KdbxGroup,
    entryId: string
  ): kdbxweb.KdbxEntry | null {
    const found = group.entries.find((e) => e.uuid.id === entryId);
    if (found) return found;

    for (const subGroup of group.groups) {
      const subFound = this.findEntryInGroup(subGroup, entryId);
      if (subFound) return subFound;
    }
    return null;
  }

  private removeEntryFromGroup(
    group: kdbxweb.KdbxGroup,
    entryId: string
  ): boolean {
    const index = group.entries.findIndex((e) => e.uuid.id === entryId);
    if (index !== -1) {
      group.entries.splice(index, 1);
      return true;
    }

    for (const subGroup of group.groups) {
      if (this.removeEntryFromGroup(subGroup, entryId)) {
        return true;
      }
    }
    return false;
  }

  private extractEntries(db: kdbxweb.Kdbx): VaultEntry[] {
    const result: VaultEntry[] = [];
    const recycleBinId = db.meta.recycleBinUuid?.id;

    const traverse = (group: kdbxweb.KdbxGroup) => {
      if (recycleBinId && group.uuid.id === recycleBinId) {
        return;
      }

      for (const entry of group.entries) {
        result.push(this.mapKdbxEntry(entry));
      }

      for (const subGroup of group.groups) {
        traverse(subGroup);
      }
    };

    traverse(db.getDefaultGroup());
    return result.sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()
    );
  }

  private mapKdbxEntry(entry: kdbxweb.KdbxEntry): VaultEntry {
    const readField = (key: string): string => {
      const field = entry.fields.get(key);
      if (!field) return '';
      return field instanceof kdbxweb.ProtectedValue
        ? field.getText()
        : typeof field === 'string'
        ? field
        : '';
    };

    const title = readField('Title') || 'Untitled';
    const username = readField('UserName');
    const password = readField('Password');
    const url = readField('URL');
    const notes = readField('Notes');
    const monogram = readField('Monogram') || deriveMonogram(title);
    const tag = readField('Tag') || 'KDBX4';
    const rawCat = readField('Category') as EntryCategory;
    const validCategories: EntryCategory[] = [
      'logins',
      'servers',
      'tokens',
      'notes',
    ];
    const category: EntryCategory = validCategories.includes(rawCat)
      ? rawCat
      : notes && !username
      ? 'notes'
      : 'logins';
    const lastMod = entry.times.lastModTime;

    return {
      id: entry.uuid.id,
      title,
      username,
      password,
      url: url || undefined,
      notes: notes || undefined,
      monogram,
      tag,
      category,
      updatedAt: lastMod instanceof Date ? lastMod : new Date(),
    };
  }
}

export const kdbxService = KdbxService.getInstance();
