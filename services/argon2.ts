// Pure TypeScript RFC 9106 Argon2 (Argon2d, Argon2i, Argon2id) + Blake2b implementation
// Plus Native C Argon2 acceleration on Android/iOS via @sonnetstationsolutions/expo-argon2.

let expoArgon2: typeof import('@sonnetstationsolutions/expo-argon2') | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  expoArgon2 = require('@sonnetstationsolutions/expo-argon2');
} catch {
  expoArgon2 = null;
}

const BLAKE2B_IV32 = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85,
  0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c,
  0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
]);

const BLAKE2B_SIGMA = new Uint8Array([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
  11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4,
  7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8,
  9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13,
  2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9,
  12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11,
  13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10,
  6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5,
  10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
]);

function add64(v: Uint32Array, a: number, b: number): void {
  const o0 = (v[a] + v[b]) >>> 0;
  const c = o0 < v[a] >>> 0 ? 1 : 0;
  v[a] = o0;
  v[a + 1] = (v[a + 1] + v[b + 1] + c) >>> 0;
}

function add32To64(v: Uint32Array, a: number, bLo: number, bHi: number): void {
  const o0 = (v[a] + (bLo >>> 0)) >>> 0;
  const c = o0 < v[a] >>> 0 ? 1 : 0;
  v[a] = o0;
  v[a + 1] = (v[a + 1] + (bHi >>> 0) + c) >>> 0;
}

function b2bG(
  v: Uint32Array,
  a: number,
  b: number,
  c: number,
  d: number,
  m: Uint32Array,
  ix: number,
  iy: number
): void {
  add64(v, a, b);
  add32To64(v, a, m[ix], m[ix + 1]);

  let x0 = v[d] ^ v[a];
  let x1 = v[d + 1] ^ v[a + 1];
  v[d] = x1;
  v[d + 1] = x0;

  add64(v, c, d);

  x0 = v[b] ^ v[c];
  x1 = v[b + 1] ^ v[c + 1];
  v[b] = (x0 >>> 24) ^ (x1 << 8);
  v[b + 1] = (x1 >>> 24) ^ (x0 << 8);

  add64(v, a, b);
  add32To64(v, a, m[iy], m[iy + 1]);

  x0 = v[d] ^ v[a];
  x1 = v[d + 1] ^ v[a + 1];
  v[d] = (x0 >>> 16) ^ (x1 << 16);
  v[d + 1] = (x1 >>> 16) ^ (x0 << 16);

  add64(v, c, d);

  x0 = v[b] ^ v[c];
  x1 = v[b + 1] ^ v[c + 1];
  v[b] = (x1 >>> 31) ^ (x0 << 1);
  v[b + 1] = (x0 >>> 31) ^ (x1 << 1);
}

class Blake2b {
  private h = new Uint32Array(16);
  private b = new Uint8Array(128);
  private c = 0;
  private t0 = 0;
  private t1 = 0;
  private outlen: number;
  private v = new Uint32Array(32);
  private m = new Uint32Array(32);

  constructor(outlen = 64) {
    this.outlen = outlen;
    this.h.set(BLAKE2B_IV32);
    this.h[0] ^= 0x01010000 ^ outlen;
  }

  update(input: Uint8Array): this {
    for (let i = 0; i < input.length; i++) {
      if (this.c === 128) {
        this.t0 = (this.t0 + 128) >>> 0;
        if (this.t0 < 128) this.t1 = (this.t1 + 1) >>> 0;
        this.compress(false);
        this.c = 0;
      }
      this.b[this.c++] = input[i];
    }
    return this;
  }

  updateUint32LE(val: number): this {
    const buf = new Uint8Array(4);
    buf[0] = val & 0xff;
    buf[1] = (val >>> 8) & 0xff;
    buf[2] = (val >>> 16) & 0xff;
    buf[3] = (val >>> 24) & 0xff;
    return this.update(buf);
  }

  digest(): Uint8Array {
    this.t0 = (this.t0 + this.c) >>> 0;
    if (this.t0 < this.c) this.t1 = (this.t1 + 1) >>> 0;
    while (this.c < 128) {
      this.b[this.c++] = 0;
    }
    this.compress(true);
    const out = new Uint8Array(this.outlen);
    for (let i = 0; i < this.outlen; i++) {
      out[i] = (this.h[i >>> 2] >>> (8 * (i & 3))) & 0xff;
    }
    return out;
  }

  private compress(last: boolean): void {
    const v = this.v;
    const m = this.m;
    v.set(this.h, 0);
    v.set(BLAKE2B_IV32, 16);
    v[24] ^= this.t0;
    v[25] ^= this.t1;
    if (last) {
      v[28] = ~v[28];
      v[29] = ~v[29];
    }
    for (let i = 0; i < 32; i++) {
      const o = i * 4;
      m[i] =
        (this.b[o] |
          (this.b[o + 1] << 8) |
          (this.b[o + 2] << 16) |
          (this.b[o + 3] << 24)) >>>
        0;
    }
    for (let r = 0; r < 12; r++) {
      const s = r * 16;
      b2bG(v, 0, 8, 16, 24, m, BLAKE2B_SIGMA[s + 0] * 2, BLAKE2B_SIGMA[s + 1] * 2);
      b2bG(v, 2, 10, 18, 26, m, BLAKE2B_SIGMA[s + 2] * 2, BLAKE2B_SIGMA[s + 3] * 2);
      b2bG(v, 4, 12, 20, 28, m, BLAKE2B_SIGMA[s + 4] * 2, BLAKE2B_SIGMA[s + 5] * 2);
      b2bG(v, 6, 14, 22, 30, m, BLAKE2B_SIGMA[s + 6] * 2, BLAKE2B_SIGMA[s + 7] * 2);
      b2bG(v, 0, 10, 20, 30, m, BLAKE2B_SIGMA[s + 8] * 2, BLAKE2B_SIGMA[s + 9] * 2);
      b2bG(v, 2, 12, 22, 24, m, BLAKE2B_SIGMA[s + 10] * 2, BLAKE2B_SIGMA[s + 11] * 2);
      b2bG(v, 4, 14, 16, 26, m, BLAKE2B_SIGMA[s + 12] * 2, BLAKE2B_SIGMA[s + 13] * 2);
      b2bG(v, 6, 8, 18, 28, m, BLAKE2B_SIGMA[s + 14] * 2, BLAKE2B_SIGMA[s + 15] * 2);
    }
    for (let i = 0; i < 16; i++) {
      this.h[i] ^= v[i] ^ v[i + 16];
    }
  }
}

function blake2bLong(input: Uint8Array, outlen: number): Uint8Array {
  const out = new Uint8Array(outlen);
  if (outlen <= 64) {
    const b = new Blake2b(outlen);
    b.updateUint32LE(outlen);
    b.update(input);
    return b.digest();
  }
  const r = Math.ceil(outlen / 32) - 2;
  let v = new Blake2b(64).updateUint32LE(outlen).update(input).digest();
  out.set(v.subarray(0, 32), 0);
  let pos = 32;
  for (let i = 1; i < r; i++) {
    v = new Blake2b(64).update(v).digest();
    out.set(v.subarray(0, 32), pos);
    pos += 32;
  }
  const lastLen = outlen - 32 * r;
  v = new Blake2b(lastLen).update(v).digest();
  out.set(v, pos);
  return out;
}

function gBlaMka(
  block: Uint32Array,
  a: number,
  b: number,
  c: number,
  d: number
): void {
  // 1. fBlaMka(a, b)
  let xL = block[a], yL = block[b];
  let p0 = (xL & 0xffff) * (yL & 0xffff);
  let p1 = (xL & 0xffff) * (yL >>> 16) + (p0 >>> 16);
  let p2 = (xL >>> 16) * (yL & 0xffff) + (p1 & 0xffff);
  let lo = ((p2 & 0xffff) << 16) | (p0 & 0xffff);
  let hi = (xL >>> 16) * (yL >>> 16) + (p1 >>> 16) + (p2 >>> 16);
  let mLo = (lo << 1) >>> 0, mHi = ((hi << 1) | (lo >>> 31)) >>> 0;
  let sLo = (xL + yL) >>> 0, sHi = (block[a + 1] + block[b + 1] + (sLo < xL >>> 0 ? 1 : 0)) >>> 0;
  let rLo = (sLo + mLo) >>> 0;
  block[a] = rLo;
  block[a + 1] = (sHi + mHi + (rLo < sLo ? 1 : 0)) >>> 0;

  // 2. rotr64(d, a, 32)
  let t0 = block[d] ^ block[a], t1 = block[d + 1] ^ block[a + 1];
  block[d] = t1; block[d + 1] = t0;

  // 3. fBlaMka(c, d)
  xL = block[c]; yL = block[d];
  p0 = (xL & 0xffff) * (yL & 0xffff);
  p1 = (xL & 0xffff) * (yL >>> 16) + (p0 >>> 16);
  p2 = (xL >>> 16) * (yL & 0xffff) + (p1 & 0xffff);
  lo = ((p2 & 0xffff) << 16) | (p0 & 0xffff);
  hi = (xL >>> 16) * (yL >>> 16) + (p1 >>> 16) + (p2 >>> 16);
  mLo = (lo << 1) >>> 0; mHi = ((hi << 1) | (lo >>> 31)) >>> 0;
  sLo = (xL + yL) >>> 0; sHi = (block[c + 1] + block[d + 1] + (sLo < xL >>> 0 ? 1 : 0)) >>> 0;
  rLo = (sLo + mLo) >>> 0;
  block[c] = rLo;
  block[c + 1] = (sHi + mHi + (rLo < sLo ? 1 : 0)) >>> 0;

  // 4. rotr64(b, c, 24)
  t0 = block[b] ^ block[c]; t1 = block[b + 1] ^ block[c + 1];
  block[b] = (t0 >>> 24) ^ (t1 << 8); block[b + 1] = (t1 >>> 24) ^ (t0 << 8);

  // 5. fBlaMka(a, b)
  xL = block[a]; yL = block[b];
  p0 = (xL & 0xffff) * (yL & 0xffff);
  p1 = (xL & 0xffff) * (yL >>> 16) + (p0 >>> 16);
  p2 = (xL >>> 16) * (yL & 0xffff) + (p1 & 0xffff);
  lo = ((p2 & 0xffff) << 16) | (p0 & 0xffff);
  hi = (xL >>> 16) * (yL >>> 16) + (p1 >>> 16) + (p2 >>> 16);
  mLo = (lo << 1) >>> 0; mHi = ((hi << 1) | (lo >>> 31)) >>> 0;
  sLo = (xL + yL) >>> 0; sHi = (block[a + 1] + block[b + 1] + (sLo < xL >>> 0 ? 1 : 0)) >>> 0;
  rLo = (sLo + mLo) >>> 0;
  block[a] = rLo;
  block[a + 1] = (sHi + mHi + (rLo < sLo ? 1 : 0)) >>> 0;

  // 6. rotr64(d, a, 16)
  t0 = block[d] ^ block[a]; t1 = block[d + 1] ^ block[a + 1];
  block[d] = (t0 >>> 16) ^ (t1 << 16); block[d + 1] = (t1 >>> 16) ^ (t0 << 16);

  // 7. fBlaMka(c, d)
  xL = block[c]; yL = block[d];
  p0 = (xL & 0xffff) * (yL & 0xffff);
  p1 = (xL & 0xffff) * (yL >>> 16) + (p0 >>> 16);
  p2 = (xL >>> 16) * (yL & 0xffff) + (p1 & 0xffff);
  lo = ((p2 & 0xffff) << 16) | (p0 & 0xffff);
  hi = (xL >>> 16) * (yL >>> 16) + (p1 >>> 16) + (p2 >>> 16);
  mLo = (lo << 1) >>> 0; mHi = ((hi << 1) | (lo >>> 31)) >>> 0;
  sLo = (xL + yL) >>> 0; sHi = (block[c + 1] + block[d + 1] + (sLo < xL >>> 0 ? 1 : 0)) >>> 0;
  rLo = (sLo + mLo) >>> 0;
  block[c] = rLo;
  block[c + 1] = (sHi + mHi + (rLo < sLo ? 1 : 0)) >>> 0;

  // 8. rotr64(b, c, 63)
  t0 = block[b] ^ block[c]; t1 = block[b + 1] ^ block[c + 1];
  block[b] = (t1 >>> 31) ^ (t0 << 1); block[b + 1] = (t0 >>> 31) ^ (t1 << 1);
}

function pRound(
  block: Uint32Array,
  v0: number,
  v1: number,
  v2: number,
  v3: number,
  v4: number,
  v5: number,
  v6: number,
  v7: number,
  v8: number,
  v9: number,
  v10: number,
  v11: number,
  v12: number,
  v13: number,
  v14: number,
  v15: number
): void {
  gBlaMka(block, v0, v4, v8, v12);
  gBlaMka(block, v1, v5, v9, v13);
  gBlaMka(block, v2, v6, v10, v14);
  gBlaMka(block, v3, v7, v11, v15);
  gBlaMka(block, v0, v5, v10, v15);
  gBlaMka(block, v1, v6, v11, v12);
  gBlaMka(block, v2, v7, v8, v13);
  gBlaMka(block, v3, v4, v9, v14);
}

function fillBlock(
  prev: Uint32Array,
  ref: Uint32Array,
  next: Uint32Array,
  withXor: boolean,
  tmpBlockR: Uint32Array,
  tmpBlockZ: Uint32Array
): void {
  for (let i = 0; i < 256; i++) {
    const x = prev[i] ^ ref[i];
    tmpBlockR[i] = x;
    tmpBlockZ[i] = x;
  }

  // Row-wise P rounds (8 rows of 16 uint64s = 32 uint32s each)
  for (let i = 0; i < 8; i++) {
    const b = i * 32;
    pRound(
      tmpBlockZ,
      b + 0, b + 2, b + 4, b + 6,
      b + 8, b + 10, b + 12, b + 14,
      b + 16, b + 18, b + 20, b + 22,
      b + 24, b + 26, b + 28, b + 30
    );
  }

  // Column-wise P rounds (8 columns of 2 uint64s per row)
  for (let i = 0; i < 8; i++) {
    const b = i * 4;
    pRound(
      tmpBlockZ,
      b + 0, b + 2, b + 32, b + 34,
      b + 64, b + 66, b + 96, b + 98,
      b + 128, b + 130, b + 160, b + 162,
      b + 192, b + 194, b + 224, b + 226
    );
  }

  if (withXor) {
    for (let i = 0; i < 256; i++) {
      next[i] ^= tmpBlockR[i] ^ tmpBlockZ[i];
    }
  } else {
    for (let i = 0; i < 256; i++) {
      next[i] = tmpBlockR[i] ^ tmpBlockZ[i];
    }
  }
}

function mul32Hi(x: number, y: number): number {
  const x0 = x & 0xffff;
  const x1 = x >>> 16;
  const y0 = y & 0xffff;
  const y1 = y >>> 16;
  const p0 = x0 * y0;
  const p1 = x0 * y1 + (p0 >>> 16);
  const p2 = x1 * y0 + (p1 & 0xffff);
  return (x1 * y1 + (p1 >>> 16) + (p2 >>> 16)) >>> 0;
}

function indexAlpha(
  pass: number,
  slice: number,
  index: number,
  pseudoRand: number,
  sameLane: boolean,
  laneLength: number,
  segmentLength: number
): number {
  let refAreaSize: number;
  if (pass === 0) {
    if (slice === 0) {
      refAreaSize = index - 1;
    } else if (sameLane) {
      refAreaSize = slice * segmentLength + index - 1;
    } else {
      refAreaSize = slice * segmentLength + (index === 0 ? -1 : 0);
    }
  } else if (sameLane) {
    refAreaSize = laneLength - segmentLength + index - 1;
  } else {
    refAreaSize = laneLength - segmentLength + (index === 0 ? -1 : 0);
  }

  if (refAreaSize <= 0) return 0;

  // relativePosition = (J1^2 / 2^32) -> (refAreaSize * rel) / 2^32
  const j1 = pseudoRand >>> 0;
  const sqHi = mul32Hi(j1, j1);
  const rel = mul32Hi(refAreaSize >>> 0, sqHi);
  const relativePos = refAreaSize - 1 - rel;

  let startPos = 0;
  if (pass !== 0) {
    startPos = slice === 3 ? 0 : (slice + 1) * segmentLength;
  }
  return (startPos + relativePos) % laneLength;
}

export async function argon2Hash(
  password: ArrayBuffer | Uint8Array,
  salt: ArrayBuffer | Uint8Array,
  memoryKiB: number,
  iterations: number,
  hashLength: number,
  parallelism: number,
  type: number, // 0 = Argon2d, 1 = Argon2i, 2 = Argon2id
  version: number = 0x13,
  onProgress?: (percent: number) => void
): Promise<ArrayBuffer> {
  const passBytes =
    password instanceof Uint8Array ? password : new Uint8Array(password);
  const saltBytes =
    salt instanceof Uint8Array ? salt : new Uint8Array(salt);

  // 1. Ultra-hızlı Native C/C++ Motoru (Android / iOS)
  if (expoArgon2 && typeof expoArgon2.hashRaw === 'function') {
    try {
      if (onProgress) onProgress(50);
      const nativeResult = await expoArgon2.hashRaw({
        password: passBytes,
        salt: saltBytes,
        memory: Math.max(1, memoryKiB | 0),
        iterations: Math.max(1, iterations | 0),
        parallelism: Math.max(1, parallelism | 0),
        hashLength,
        type: type as any,
        version,
      });
      if (onProgress) onProgress(100);
      return nativeResult.buffer.slice(
        nativeResult.byteOffset,
        nativeResult.byteOffset + nativeResult.byteLength
      ) as ArrayBuffer;
    } catch {
      // Native bağlayıcı mevcut değilse (Node testi / web) pure JS ile devam et
    }
  }

  const lanes = Math.max(1, parallelism | 0);
  const tCost = Math.max(1, iterations | 0);
  let mBlocks = Math.max(8 * lanes, memoryKiB | 0);
  const segmentLength = Math.floor(mBlocks / (4 * lanes));
  const laneLength = segmentLength * 4;
  mBlocks = laneLength * lanes;

  // Step 1: Initial H0 (64-byte Blake2b)
  const h0Hash = new Blake2b(64);
  h0Hash
    .updateUint32LE(lanes)
    .updateUint32LE(hashLength)
    .updateUint32LE(memoryKiB)
    .updateUint32LE(tCost)
    .updateUint32LE(version)
    .updateUint32LE(type)
    .updateUint32LE(passBytes.byteLength)
    .update(passBytes)
    .updateUint32LE(saltBytes.byteLength)
    .update(saltBytes)
    .updateUint32LE(0) // secret length
    .updateUint32LE(0); // ad length
  const h0 = h0Hash.digest();

  // Allocate flat memory: each block is 256 uint32s (1024 bytes)
  const memory = new Uint32Array(mBlocks * 256);
  const blockBuf = new Uint8Array(72);
  blockBuf.set(h0, 0);

  for (let l = 0; l < lanes; l++) {
    for (let b = 0; b < 2; b++) {
      blockBuf[64] = b & 0xff;
      blockBuf[65] = (b >>> 8) & 0xff;
      blockBuf[66] = (b >>> 16) & 0xff;
      blockBuf[67] = (b >>> 24) & 0xff;
      blockBuf[68] = l & 0xff;
      blockBuf[69] = (l >>> 8) & 0xff;
      blockBuf[70] = (l >>> 16) & 0xff;
      blockBuf[71] = (l >>> 24) & 0xff;
      const initialBlockBytes = blake2bLong(blockBuf, 1024);
      const destOffset = (l * laneLength + b) * 256;
      const view32 = new Uint32Array(
        initialBlockBytes.buffer,
        initialBlockBytes.byteOffset,
        256
      );
      memory.set(view32, destOffset);
    }
  }

  const tmpR = new Uint32Array(256);
  const tmpZ = new Uint32Array(256);
  const zeroBlock = new Uint32Array(256);
  const inputBlock = new Uint32Array(256);
  const addressBlock = new Uint32Array(256);
  const tmpAddrR = new Uint32Array(256);
  const tmpAddrZ = new Uint32Array(256);

  const nextAddressBlock = () => {
    inputBlock[12] = (inputBlock[12] + 1) >>> 0;
    if (inputBlock[12] === 0) {
      inputBlock[13] = (inputBlock[13] + 1) >>> 0;
    }
    fillBlock(zeroBlock, inputBlock, addressBlock, false, tmpAddrR, tmpAddrZ);
    fillBlock(zeroBlock, addressBlock, addressBlock, false, tmpAddrR, tmpAddrZ);
  };

  const totalSteps = tCost * 4 * lanes * segmentLength;
  let stepCounter = 0;

  for (let pass = 0; pass < tCost; pass++) {
    const withXor = pass !== 0 && version === 0x13;
    for (let slice = 0; slice < 4; slice++) {
      const dataIndependent =
        type === 1 || (type === 2 && pass === 0 && slice < 2);

      for (let l = 0; l < lanes; l++) {
        if (dataIndependent) {
          inputBlock.fill(0);
          inputBlock[0] = pass;
          inputBlock[2] = l;
          inputBlock[4] = slice;
          inputBlock[6] = mBlocks;
          inputBlock[8] = tCost;
          inputBlock[10] = type;
          nextAddressBlock();
        }

        const startIdx = pass === 0 && slice === 0 ? 2 : 0;
        for (let idx = startIdx; idx < segmentLength; idx++) {
          if (dataIndependent && idx % 128 === 0 && idx > 0) {
            nextAddressBlock();
          }

          const currInLane = slice * segmentLength + idx;
          const prevInLane =
            currInLane === 0 ? laneLength - 1 : currInLane - 1;
          const currOffset = (l * laneLength + currInLane) * 256;
          const prevOffset = (l * laneLength + prevInLane) * 256;

          let j1: number;
          let j2: number;
          if (dataIndependent) {
            const addrOffset = (idx % 128) * 2;
            j1 = addressBlock[addrOffset];
            j2 = addressBlock[addrOffset + 1];
          } else {
            j1 = memory[prevOffset];
            j2 = memory[prevOffset + 1];
          }

          const refLane =
            pass === 0 && slice === 0 ? l : (j2 >>> 0) % lanes;
          const refIndex = indexAlpha(
            pass,
            slice,
            idx,
            j1,
            refLane === l,
            laneLength,
            segmentLength
          );
          const refOffset = (refLane * laneLength + refIndex) * 256;

          fillBlock(
            memory.subarray(prevOffset, prevOffset + 256),
            memory.subarray(refOffset, refOffset + 256),
            memory.subarray(currOffset, currOffset + 256),
            withXor,
            tmpR,
            tmpZ
          );

          stepCounter++;
          if ((stepCounter & 2047) === 0) {
            if (onProgress && totalSteps > 0) {
              const pct = Math.min(99, Math.round((stepCounter / totalSteps) * 100));
              onProgress(pct);
            }
            await new Promise<void>((r) => setTimeout(r, 0));
          }
        }
      }
    }
  }

  if (onProgress) {
    onProgress(100);
  }

  // Finalize: XOR last blocks of all lanes
  const finalBlock = new Uint32Array(256);
  const lastInLane0 = (0 * laneLength + (laneLength - 1)) * 256;
  finalBlock.set(memory.subarray(lastInLane0, lastInLane0 + 256));

  for (let l = 1; l < lanes; l++) {
    const lastOffset = (l * laneLength + (laneLength - 1)) * 256;
    for (let i = 0; i < 256; i++) {
      finalBlock[i] ^= memory[lastOffset + i];
    }
  }

  const finalBytes = new Uint8Array(1024);
  for (let i = 0; i < 256; i++) {
    const w = finalBlock[i];
    const o = i * 4;
    finalBytes[o] = w & 0xff;
    finalBytes[o + 1] = (w >>> 8) & 0xff;
    finalBytes[o + 2] = (w >>> 16) & 0xff;
    finalBytes[o + 3] = (w >>> 24) & 0xff;
  }

  const result = blake2bLong(finalBytes, hashLength);
  return result.buffer.slice(
    result.byteOffset,
    result.byteOffset + result.byteLength
  ) as ArrayBuffer;
}
