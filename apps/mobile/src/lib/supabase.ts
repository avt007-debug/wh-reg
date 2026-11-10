/**
 * Supabase client for the app.
 * Session tokens are encrypted at rest: a random AES-256 key lives in the OS
 * keystore (expo-secure-store, ~2 KB limit) and the encrypted session JSON in
 * AsyncStorage — the pattern recommended by Supabase for React Native.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import aesjs from 'aes-js';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { AppState, Platform } from 'react-native';

class LargeSecureStore {
  private async encrypt(key: string, value: string) {
    const encryptionKey = Crypto.getRandomBytes(256 / 8);
    const cipher = new aesjs.ModeOfOperation.ctr(encryptionKey, new aesjs.Counter(1));
    const encrypted = cipher.encrypt(aesjs.utils.utf8.toBytes(value));
    await SecureStore.setItemAsync(key, aesjs.utils.hex.fromBytes(encryptionKey));
    return aesjs.utils.hex.fromBytes(encrypted);
  }
  private async decrypt(key: string, value: string) {
    const hexKey = await SecureStore.getItemAsync(key);
    if (!hexKey) return null;
    const cipher = new aesjs.ModeOfOperation.ctr(aesjs.utils.hex.toBytes(hexKey), new aesjs.Counter(1));
    return aesjs.utils.utf8.fromBytes(cipher.decrypt(aesjs.utils.hex.toBytes(value)));
  }
  async getItem(key: string) {
    const encrypted = await AsyncStorage.getItem(key);
    return encrypted ? this.decrypt(key, encrypted) : null;
  }
  async setItem(key: string, value: string) {
    await AsyncStorage.setItem(key, await this.encrypt(key, value));
  }
  async removeItem(key: string) {
    await AsyncStorage.removeItem(key);
    await SecureStore.deleteItemAsync(key);
  }
}

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const key = process.env.EXPO_PUBLIC_SUPABASE_KEY;        // publishable key (sb_publishable_…) — safe to ship
if (!url || !key) throw new Error('Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_KEY (see apps/mobile/.env.example)');

export const supabase = createClient(url, key, {
  auth: {
    // Phones: encrypted keystore-backed store. Browser: supabase-js default (localStorage).
    ...(Platform.OS === 'web' ? {} : { storage: new LargeSecureStore() }),
    autoRefreshToken: true, persistSession: true, detectSessionInUrl: false,
  },
});

// Refresh tokens only while the app is in the foreground (Supabase RN guidance).
if (Platform.OS !== 'web') AppState.addEventListener('change', (state) => {
  if (state === 'active') void supabase.auth.startAutoRefresh();
  else void supabase.auth.stopAutoRefresh();
});

/** Staff type a User ID; Supabase Auth needs an e-mail. Keep in sync with LOGIN_EMAIL_DOMAIN in Edge Functions. */
export const loginEmail = (loginId: string) =>
  `${loginId.trim().toLowerCase()}@${process.env.EXPO_PUBLIC_LOGIN_EMAIL_DOMAIN ?? 'staff.whreg.app'}`;

export const productImageUrl = (path: string | null) =>
  path ? supabase.storage.from('product-images').getPublicUrl(path).data.publicUrl : null;
