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

export interface DesktopSyncAction {
  action: 'ADD_ENTRY' | 'UPDATE_ENTRY' | 'DELETE_ENTRY';
  entry: VaultEntry;
  timestamp: string;
}

class WebConnectService {
  private activePollingInterval: any = null;
  private lastProcessedTime = Math.floor(Date.now() / 1000);
  private processedMessageIds = new Set<string>();
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
   * Decrypt incoming AES-256-CBC payload from Keyra Desktop.
   */
  decryptPayload(base64Payload: string, keyHex: string): string {
    const combined = Buffer.from(base64Payload, 'base64');
    const iv = combined.subarray(0, 16);
    const ciphertext = combined.subarray(16);
    const key = Buffer.from(keyHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  }

  /**
   * Start listening for reverse updates (Desktop -> Mobile) via secure channel.
   */
  startListeningForDesktopUpdates(
    sessionId: string,
    keyHex: string,
    onAction: (action: DesktopSyncAction) => void
  ) {
    this.stopListeningForDesktopUpdates();
    this.lastProcessedTime = Math.floor(Date.now() / 1000) - 5;
    this.processedMessageIds.clear();

    const topic = `${sessionId}_to_mobile`;

    this.activePollingInterval = setInterval(async () => {
      try {
        const res = await fetch(`https://ntfy.sh/${topic}/json?poll=1&since=${this.lastProcessedTime}`);
        if (!res.ok) return;

        const text = await res.text();
        if (!text || text.trim().length === 0) return;

        const lines = text.trim().split('\n');
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.event === 'message' && parsed.message && !this.processedMessageIds.has(parsed.id)) {
              this.processedMessageIds.add(parsed.id);
              if (parsed.time && parsed.time >= this.lastProcessedTime) {
                this.lastProcessedTime = parsed.time;
              }

              // Decrypt payload
              const decryptedStr = this.decryptPayload(parsed.message.trim(), keyHex);
              const actionData = JSON.parse(decryptedStr) as DesktopSyncAction;
              if (actionData && actionData.action && actionData.entry) {
                onAction(actionData);
              }
            }
          } catch (itemErr) {
            console.warn('[WebConnect] Error parsing item:', itemErr);
          }
        }
      } catch (pollErr) {
        // Sessizce yut, bir sonraki poll deneyecek
      }
    }, 1800);
  }

  /**
   * Stop listening for reverse updates.
   */
  stopListeningForDesktopUpdates() {
    if (this.activePollingInterval) {
      clearInterval(this.activePollingInterval);
      this.activePollingInterval = null;
    }
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
