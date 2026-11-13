/** Finger / mouse signature box (browser & home-screen app). Gives back a PNG data URL. */
import { useEffect, useRef } from 'react';
import { Platform, Text, View } from 'react-native';
import { useTheme } from '../theme';
import { SmallButton } from './ui';

export function SignaturePad({ onChange }: { onChange: (dataUrl: string | null) => void }) {
  const t = useTheme();
  const host = useRef<unknown>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const el = host.current as unknown as HTMLElement | null;
    if (!el) return;
    const c = document.createElement('canvas');
    const w = Math.min(el.clientWidth || 340, 600); const h = 180; const dpr = window.devicePixelRatio || 1;
    c.width = w * dpr; c.height = h * dpr; c.style.width = `${w}px`; c.style.height = `${h}px`; c.style.touchAction = 'none';
    c.style.background = '#fff'; c.style.borderRadius = '10px';
    const ctx = c.getContext('2d')!; ctx.scale(dpr, dpr); ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.strokeStyle = '#111';
    let drawing = false; let drawn = false;
    const pt = (e: PointerEvent) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] as const; };
    c.onpointerdown = (e) => { drawing = true; c.setPointerCapture(e.pointerId); const [x, y] = pt(e); ctx.beginPath(); ctx.moveTo(x, y); };
    c.onpointermove = (e) => { if (!drawing) return; const [x, y] = pt(e); ctx.lineTo(x, y); ctx.stroke(); drawn = true; };
    c.onpointerup = () => { drawing = false; if (drawn) onChange(c.toDataURL('image/png')); };
    el.appendChild(c); canvas.current = c;
    return () => { c.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const clear = () => {
    const c = canvas.current; if (!c) return;
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height); onChange(null);
  };
  if (Platform.OS !== 'web') return <Text style={{ color: t.textMuted }}>Signature works in the browser / home-screen app. Take a photo instead.</Text>;
  return (
    <View style={{ gap: 6 }}>
      <View ref={host as never} style={{ width: '100%', minHeight: 180, borderWidth: 1, borderColor: t.border, borderRadius: 10, overflow: 'hidden' }} />
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={{ color: t.textMuted, fontSize: 12 }}>Receiver signs above with a finger</Text>
        <SmallButton title="Clear" onPress={clear} />
      </View>
    </View>
  );
}
