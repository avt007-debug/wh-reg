import { Linking } from 'react-native';

/** Opens WhatsApp (app or web) with a ready-to-send message. Indian numbers get +91. */
export function openWhatsApp(phone: string | null | undefined, text: string) {
  const digits = (phone ?? '').replace(/\D/g, '').slice(-10);
  const to = digits.length === 10 ? `91${digits}` : '';
  return Linking.openURL(`https://wa.me/${to}?text=${encodeURIComponent(text)}`);
}
