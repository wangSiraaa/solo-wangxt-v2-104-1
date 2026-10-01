/** Non-cryptographic FNV-1a 64 content hash (hex) for the settings record. */
const MASK = (1n << 64n) - 1n;
const OFFSET = 0xcbf29ce484222325n;
const PRIME = 0x100000001b3n;

export function fnv1a64(bytes: Uint8Array): string {
  let h = OFFSET;
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i]);
    h = (h * PRIME) & MASK;
  }
  return h.toString(16).padStart(16, '0');
}
