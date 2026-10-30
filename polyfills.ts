import { Buffer } from 'buffer';

declare const global: {
  Buffer?: typeof Buffer;
  process?: Record<string, unknown>;
  crypto?: {
    getRandomValues?: <T extends ArrayBufferView>(array: T) => T;
  };
  [key: string]: unknown;
};

const g: Record<string, any> =
  typeof globalThis !== 'undefined'
    ? (globalThis as Record<string, any>)
    : typeof global !== 'undefined'
    ? (global as Record<string, any>)
    : {};

// 1. Global Buffer Polyfill
g.Buffer = Buffer;
if (typeof global !== 'undefined') {
  global.Buffer = Buffer;
}

// 2. Process Polyfill (stream-browserify / readable-stream / pbkdf2 için zorunlu)
if (!g.process) {
  g.process = {};
}
if (typeof g.process.version !== 'string' || !g.process.version) {
  g.process.version = 'v18.0.0';
}
if (!g.process.versions) {
  g.process.versions = { node: '18.0.0' };
}
if (typeof g.process.browser === 'undefined') {
  g.process.browser = true;
}
if (!g.process.env) {
  g.process.env = { NODE_ENV: 'development' };
}
if (typeof g.process.nextTick !== 'function') {
  g.process.nextTick = (cb: (...args: any[]) => void, ...args: any[]) => {
    setTimeout(() => cb(...args), 0);
  };
}

// 3. Kriptografik Rastgelelik (CSPRNG - crypto.getRandomValues) Polyfill
if (!g.crypto) {
  g.crypto = {};
}
if (typeof g.crypto.getRandomValues !== 'function') {
  let entropyPool = Date.now() ^ 0x5f3759df;
  g.crypto.getRandomValues = <T extends ArrayBufferView>(array: T): T => {
    if (!array || !array.buffer) {
      throw new TypeError('Expected an ArrayBufferView');
    }
    if (array.byteLength > 65536) {
      throw new Error('QuotaExceededError: requested more than 65536 bytes');
    }
    const bytes = new Uint8Array(
      array.buffer,
      array.byteOffset,
      array.byteLength
    );
    for (let i = 0; i < bytes.length; i++) {
      // Xorshift + zamanlayıcı + Math.random karma entropi üretimi
      entropyPool ^= entropyPool << 13;
      entropyPool ^= entropyPool >>> 17;
      entropyPool ^= entropyPool << 5;
      const r1 = (Math.random() * 0x100000000) >>> 0;
      const r2 = (Date.now() + i * 2654435761) >>> 0;
      bytes[i] = ((entropyPool ^ r1 ^ r2) >>> (i % 24)) & 0xff;
    }
    return array;
  };
}

// 4. TextEncoder / TextDecoder & atob / btoa Güvenlik Polifilleri
if (typeof g.TextEncoder === 'undefined') {
  g.TextEncoder = class TextEncoderPolyfill {
    encode(str: string = ''): Uint8Array {
      return new Uint8Array(Buffer.from(String(str), 'utf8'));
    }
  };
}

if (typeof g.TextDecoder === 'undefined') {
  g.TextDecoder = class TextDecoderPolyfill {
    decode(input?: ArrayBuffer | ArrayBufferView): string {
      if (!input) return '';
      if (input instanceof ArrayBuffer) {
        return Buffer.from(input).toString('utf8');
      }
      if (ArrayBuffer.isView(input)) {
        return Buffer.from(
          input.buffer as ArrayBuffer,
          input.byteOffset,
          input.byteLength
        ).toString('utf8');
      }
      return '';
    }
  };
}

if (typeof g.atob !== 'function') {
  g.atob = (b64: string): string => Buffer.from(b64, 'base64').toString('binary');
}

if (typeof g.btoa !== 'function') {
  g.btoa = (bin: string): string => Buffer.from(bin, 'binary').toString('base64');
}
