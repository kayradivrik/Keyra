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
    entries: VaultEntry[],
    kdbxBase64?: string
  ): Promise<boolean> {
    try {
      // 1. Transfer verisini hazırla (PC'de görüntüleme ve tek tıkla kopyalama için)
      const transferData: WebTransferPayload = {
        vaultFileName,
        entries,
        kdbxBase64,
        syncedAt: new Date().toISOString(),
      };

      const jsonStr = JSON.stringify(transferData);

      // 2. Uçtan uca AES-256-CBC ile şifrele
      const encryptedBase64 = this.encryptPayload(jsonStr, keyHex);

      // 3. Relay üzerinden PC'ye gönder.
      // ntfy.sh 4096 bayttan büyük mesajları otomatik dosya ekine (attachment) dönüştürür
      // ve dosya eklerinde IP bazlı 429 kota hatası verir.
      // Bu yüzden CHUNK_SIZE = 3500 ile parçalayarak düz metin olarak gönderiyoruz.
      const CHUNK_SIZE = 3500;
      if (encryptedBase64.length <= CHUNK_SIZE) {
        const res = await fetch(`https://ntfy.sh/${sessionId}`, {
          method: 'POST',
          headers: {
            'X-Cache': 'no',
            Priority: 'urgent',
          },
          body: encryptedBase64,
        });

        if (!res.ok) {
          throw new Error(`Relay response status: ${res.status}`);
        }
      } else {
        const totalChunks = Math.ceil(encryptedBase64.length / CHUNK_SIZE);
        for (let i = 0; i < totalChunks; i++) {
          const chunkData = encryptedBase64.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
          const chunkMsg = `KEYRA_CHUNK:${i + 1}/${totalChunks}:${chunkData}`;
          const res = await fetch(`https://ntfy.sh/${sessionId}`, {
            method: 'POST',
            headers: {
              'X-Cache': 'no',
              Priority: 'urgent',
            },
            body: chunkMsg,
          });

          if (!res.ok) {
            throw new Error(`Relay chunk ${i + 1} status: ${res.status}`);
          }
          await new Promise((r) => setTimeout(r, 60));
        }
      }

      return true;
    } catch (error) {
      console.error('[WebConnect] sendVaultToWeb failed:', error);
      throw error;
    }
  }
}

export const webConnectService = new WebConnectService();
