import { Buffer } from 'buffer';

export interface QrSyncPayload {
  protocol: 'keyra_qr_sync_v1';
  deviceId: string;
  vaultFileName: string;
  entriesCount: number;
  timestamp: number;
  pin: string;
  dataBase64?: string; // Küçük ve orta boy kasalar için doğrudan şifreli veri aktarımı
}

export class QrSyncService {
  private static instance: QrSyncService;

  private constructor() {}

  public static getInstance(): QrSyncService {
    if (!QrSyncService.instance) {
      QrSyncService.instance = new QrSyncService();
    }
    return QrSyncService.instance;
  }

  /**
   * 6 Haneli rastgele güvenlik PIN kodu üretir.
   */
  public generatePin(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  /**
   * Cihazlar arası güvenli eşleme ve aktarım için QR veri paketi üretir.
   */
  public createSyncPayload(
    vaultFileName: string,
    entriesCount: number,
    arrayBuffer?: ArrayBuffer
  ): { qrString: string; pin: string } {
    const pin = this.generatePin();
    const payload: QrSyncPayload = {
      protocol: 'keyra_qr_sync_v1',
      deviceId: Math.random().toString(36).substring(2, 10),
      vaultFileName,
      entriesCount,
      timestamp: Date.now(),
      pin,
    };

    // Eğer kasa boyutu QR kapasitesine uygunsa (örneğin < 2.5 KB) doğrudan göm
    if (arrayBuffer && arrayBuffer.byteLength < 2600) {
      payload.dataBase64 = Buffer.from(arrayBuffer).toString('base64');
    }

    return {
      qrString: JSON.stringify(payload),
      pin,
    };
  }

  /**
   * Taranan QR kodu çözümler ve doğrular.
   */
  public parseQrPayload(rawScannedText: string): QrSyncPayload | null {
    try {
      const parsed = JSON.parse(rawScannedText) as QrSyncPayload;
      if (parsed.protocol === 'keyra_qr_sync_v1' && parsed.pin) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }
}

export const qrSync = QrSyncService.getInstance();

