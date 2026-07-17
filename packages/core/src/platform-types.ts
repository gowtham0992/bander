export interface CorePlatform {
  sha256Hex(input: string | Uint8Array): string;
  randomUuid(): string;
  base64UrlToBytes(value: string): Uint8Array;
}
