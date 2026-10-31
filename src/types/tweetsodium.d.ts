declare module 'tweetsodium' {
  export function seal(message: Uint8Array, key: Uint8Array): Uint8Array;
}

