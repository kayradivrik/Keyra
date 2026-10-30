import * as WebBrowser from 'expo-web-browser';
import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import { Buffer } from 'buffer';

WebBrowser.maybeCompleteAuthSession();

const SECURE_STORE_GDRIVE_KEY = 'keyra_gdrive_access_token';
const SECURE_STORE_GDRIVE_EMAIL = 'keyra_gdrive_user_email';
const SECURE_STORE_LAST_SYNC = 'keyra_gdrive_last_sync';

// Google Drive AppData veya Drive.file erişim kapsamı
const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email',
];

export interface GoogleSyncState {
  isConnected: boolean;
  email: string | null;
  lastSyncTime: string | null;
  isSyncing: boolean;
  error: string | null;
}

export class GoogleDriveSyncService {
  private static instance: GoogleDriveSyncService;
  private accessToken: string | null = null;
  private userEmail: string | null = null;

  private constructor() {}

  public static getInstance(): GoogleDriveSyncService {
    if (!GoogleDriveSyncService.instance) {
      GoogleDriveSyncService.instance = new GoogleDriveSyncService();
    }
    return GoogleDriveSyncService.instance;
  }

  /**
   * Cihazda kayıtlı Google oturumunu ve son eşitleme zamanını yükler.
   */
  public async loadState(): Promise<GoogleSyncState> {
    try {
      this.accessToken = await SecureStore.getItemAsync(SECURE_STORE_GDRIVE_KEY);
      this.userEmail = await SecureStore.getItemAsync(SECURE_STORE_GDRIVE_EMAIL);
      const lastSync = await SecureStore.getItemAsync(SECURE_STORE_LAST_SYNC);

      return {
        isConnected: Boolean(this.accessToken),
        email: this.userEmail,
        lastSyncTime: lastSync,
        isSyncing: false,
        error: null,
      };
    } catch {
      return {
        isConnected: false,
        email: null,
        lastSyncTime: null,
        isSyncing: false,
        error: null,
      };
    }
  }

  /**
   * Manuel veya OAuth ile alınan erişim anahtarını kaydeder.
   */
  public async setAuthToken(token: string, email?: string): Promise<void> {
    this.accessToken = token;
    await SecureStore.setItemAsync(SECURE_STORE_GDRIVE_KEY, token);
    if (email) {
      this.userEmail = email;
      await SecureStore.setItemAsync(SECURE_STORE_GDRIVE_EMAIL, email);
    }
  }

  /**
   * Google Drive bağlantısını keser.
   */
  public async disconnect(): Promise<void> {
    this.accessToken = null;
    this.userEmail = null;
    await SecureStore.deleteItemAsync(SECURE_STORE_GDRIVE_KEY);
    await SecureStore.deleteItemAsync(SECURE_STORE_GDRIVE_EMAIL);
  }

  /**
   * Google Drive üzerinde 'Keyra' klasörünü veya dosyasını arar.
   */
  public async findFileInDrive(fileName: string): Promise<{ id: string; modifiedTime: string } | null> {
    if (!this.accessToken) {
      throw new Error('Google Drive bağlantısı bulunamadı.');
    }

    const query = encodeURIComponent(`name = '${fileName}' and trashed = false`);
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,modifiedTime)`,
      {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
      }
    );

    if (!res.ok) {
      if (res.status === 401) {
        await this.disconnect();
        throw new Error('Google oturumu sona erdi. Lütfen tekrar bağlanın.');
      }
      throw new Error(`Google Drive hatası: ${res.statusText}`);
    }

    const data = await res.json();
    if (data.files && data.files.length > 0) {
      return { id: data.files[0].id, modifiedTime: data.files[0].modifiedTime };
    }
    return null;
  }

  /**
   * Google Drive'dan .kdbx dosyasını indirir.
   */
  public async downloadFileFromDrive(fileId: string): Promise<ArrayBuffer> {
    if (!this.accessToken) {
      throw new Error('Google Drive bağlantısı bulunamadı.');
    }

    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
      }
    );

    if (!res.ok) {
      throw new Error('Google Drive dosya indirme başarısız oldu.');
    }

    return await res.arrayBuffer();
  }

  /**
   * Google Drive'a .kdbx dosyasını yükler (Varsa günceller, yoksa oluşturur).
   */
  public async uploadFileToDrive(fileName: string, arrayBuffer: ArrayBuffer): Promise<string> {
    if (!this.accessToken) {
      throw new Error('Google Drive bağlantısı bulunamadı.');
    }

    const existing = await this.findFileInDrive(fileName);
    const u8 = new Uint8Array(arrayBuffer);
    const base64Data = Buffer.from(u8).toString('base64');

    if (existing) {
      // Mevcut dosyanın içeriğini güncelle (PATCH)
      const res = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=media`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            'Content-Type': 'application/octet-stream',
          },
          body: arrayBuffer,
        }
      );
      if (!res.ok) throw new Error('Dosya Drive üzerinde güncellenemedi.');
      await this.updateLastSyncTime();
      return existing.id;
    } else {
      // Yeni dosya oluştur (Multipart Upload)
      const metadata = {
        name: fileName,
        mimeType: 'application/octet-stream',
      };

      const boundary = '-------314159265358979323846';
      const delimiter = `\r\n--${boundary}\r\n`;
      const closeDelimiter = `\r\n--${boundary}--`;

      const multipartBody =
        delimiter +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify(metadata) +
        delimiter +
        'Content-Type: application/octet-stream\r\n' +
        'Content-Transfer-Encoding: base64\r\n\r\n' +
        base64Data +
        closeDelimiter;

      const res = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            'Content-Type': `multipart/related; boundary=${boundary}`,
          },
          body: multipartBody,
        }
      );

      if (!res.ok) throw new Error('Dosya Drive üzerine yüklenemedi.');
      const data = await res.json();
      await this.updateLastSyncTime();
      return data.id;
    }
  }

  private async updateLastSyncTime(): Promise<string> {
    const now = new Date().toLocaleString('tr-TR');
    await SecureStore.setItemAsync(SECURE_STORE_LAST_SYNC, now);
    return now;
  }
}

export const googleDriveSync = GoogleDriveSyncService.getInstance();

