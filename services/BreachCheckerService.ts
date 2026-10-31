// @ts-ignore
import crypto from 'crypto-browserify';

export interface BreachResult {
  isPwned: boolean;
  breachCount: number;
}

class BreachCheckerService {
  /**
   * Check if a password has been leaked in data breaches using HaveIBeenPwned k-Anonymity API.
   * ONLY the first 5 characters of the SHA-1 hash are sent to the remote API.
   * The actual password NEVER leaves the device, guaranteeing 100% privacy.
   */
  async checkPassword(password: string): Promise<BreachResult> {
    if (!password) {
      return { isPwned: false, breachCount: 0 };
    }

    try {
      // 1. SHA-1 hash hesapla (büyük harf hex)
      const sha1 = crypto.createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
      const prefix = sha1.slice(0, 5);
      const suffix = sha1.slice(5);

      // 2. Yalnızca ilk 5 karakteri sorgula (k-Anonymity)
      const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
        headers: {
          'Add-Padding': 'true', // Boyut analizini engellemek için padding
        },
      });

      if (!res.ok) {
        throw new Error(`Sızıntı servisi yanıt vermedi (${res.status})`);
      }

      const text = await res.text();
      const lines = text.split('\n');

      for (const line of lines) {
        const [hashSuffix, countStr] = line.trim().split(':');
        if (hashSuffix === suffix) {
          const breachCount = parseInt(countStr, 10) || 1;
          return { isPwned: true, breachCount };
        }
      }

      return { isPwned: false, breachCount: 0 };
    } catch (err) {
      console.warn('[BreachChecker] check error:', err);
      throw err;
    }
  }
}

export const breachCheckerService = new BreachCheckerService();

