// @ts-ignore
import crypto from 'crypto-browserify';
import { Buffer } from 'buffer';
import { VaultEntry } from '../types/kdbx';
import { kdbxService } from './KdbxService';

export interface WebPairingPayload {
  type: 'KEYRA_WEB_PAIR';
  sessionId: string;
  keyHex: string;
}

export interface WebTransferPayload {
  vaultFileName: string;
  entries: VaultEntry[];
  kdbxBase64?: string;
  syncedAt: string;
}

class WebConnectService {
  /**
   * Parse QR code scanned from Keyra Web on PC screen.
   */
  parseWebPairingQr(qrText: string): WebPairingPayload | null {
    try {
      const parsed = JSON.parse(qrText);
      if (
        parsed &&
        parsed.type === 'KEYRA_WEB_PAIR' &&
        typeof parsed.sessionId === 'string' &&
        typeof parsed.keyHex === 'string' &&
        parsed.keyHex.length === 64
      ) {
        return parsed as WebPairingPayload;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Encrypt payload with AES-256-CBC using the ephemeral key from the QR code.
   * Returns base64 string of IV (16 bytes) + Ciphertext.
   */
  encryptPayload(plainText: string, keyHex: string): string {
    const key = Buffer.from(keyHex, 'hex');
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const combined = Buffer.concat([iv, encrypted]);
    return combined.toString('base64');
  }

  /**
   * Transmit encrypted vault to Keyra Web on PC via secure zero-knowledge relay.
   */
  async sendVaultToWeb(
    sessionId: string,
    keyHex: string,
    vaultFileName: string,
    entries: VaultEntry[]
  ): Promise<boolean> {
    try {
      // 1. Raw .kdbx dosyasını al (PC'de tek tıkla .kdbx indirme imkanı için)
      let kdbxBase64: string | undefined = undefined;
      try {
        const rawAb = await kdbxService.getCurrentVaultBuffer();
        if (rawAb) {
          kdbxBase64 = Buffer.from(rawAb).toString('base64');
        }
      } catch (err) {
        console.warn('[WebConnect] Raw KDBX buffer could not be extracted:', err);
      }

      // 2. Transfer verisini hazırla
      const transferData: WebTransferPayload = {
        vaultFileName,
        entries,
        kdbxBase64,
        syncedAt: new Date().toISOString(),
      };

      const jsonStr = JSON.stringify(transferData);

      // 3. Uçtan uca AES-256-CBC ile şifrele
      const encryptedBase64 = this.encryptPayload(jsonStr, keyHex);

      // 4. Relay üzerinden PC'ye gönder (X-Cache: no ile sunucu kaydı tutulmaz)
      const res = await fetch(`https://ntfy.sh/${sessionId}`, {
        method: 'POST',
        headers: {
          Filename: 'vault.enc',
          'X-Cache': 'no',
          Title: 'Keyra Web Sync',
          Priority: 'urgent',
        },
        body: encryptedBase64,
      });

      if (!res.ok) {
        throw new Error(`Relay response status: ${res.status}`);
      }

      return true;
    } catch (error) {
      console.error('[WebConnect] sendVaultToWeb failed:', error);
      throw error;
    }
  }
}

export const webConnectService = new WebConnectService();
