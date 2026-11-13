/** Current position (phone GPS / browser location). Resolves null when not allowed or not available. */
export interface Position { lat: number; lng: number; accuracy: number }
export function currentPosition(timeoutMs = 12_000): Promise<Position | null> {
  const geo = (globalThis as { navigator?: { geolocation?: { getCurrentPosition: (ok: (p: { coords: { latitude: number; longitude: number; accuracy: number } }) => void, err: () => void, o: object) => void } } }).navigator?.geolocation;
  if (!geo) return Promise.resolve(null);
  return new Promise((resolve) => {
    geo.getCurrentPosition(
      (p) => resolve({ lat: Math.round(p.coords.latitude * 1e6) / 1e6, lng: Math.round(p.coords.longitude * 1e6) / 1e6, accuracy: Math.round(p.coords.accuracy) }),
      () => resolve(null), { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 });
  });
}
export const mapLink = (lat: number, lng: number) => `https://www.google.com/maps?q=${lat},${lng}`;
