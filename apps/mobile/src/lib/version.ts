/** Build stamp of this copy of the app (set by the website workflow; 'dev' locally). */
export const BUILD_ID = process.env.EXPO_PUBLIC_BUILD_ID ?? 'dev';
/** e.g. "13 Nov 2026 · 4a7c2e1" */
export const versionLabel = () => {
  const [stamp, sha] = BUILD_ID.split('-');
  if (!stamp || !sha || stamp.length !== 12) return BUILD_ID;
  const d = new Date(Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8), +stamp.slice(8, 10), +stamp.slice(10, 12)));
  return `${d.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })} · ${sha}`;
};
