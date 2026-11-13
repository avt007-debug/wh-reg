// After `expo export --platform web`: make the website installable on phones
// ("Add to Home screen" / "Install app") with its own icon and full-screen window.
// Usage: node scripts/pwa-head.mjs <dist dir> <base path, e.g. /wh-reg>
import { readFileSync, writeFileSync } from 'node:fs';
const [dist = 'dist', base = ''] = process.argv.slice(2);
const b = base.replace(/\/$/, '');
const file = `${dist}/index.html`;
const tags = `
    <link rel="manifest" href="${b}/manifest.webmanifest" />
    <link rel="icon" type="image/png" href="${b}/favicon.png" />
    <link rel="apple-touch-icon" href="${b}/icons/apple-touch-icon.png" />
    <meta name="theme-color" content="#2563eb" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-title" content="WH Reg" />
    <meta name="apple-mobile-web-app-status-bar-style" content="default" />
    <meta name="application-name" content="WH Reg" />
    <meta name="description" content="Stock, sales, purchases, payments and team for your warehouses" />
  </head>`;
let html = readFileSync(file, 'utf8');
if (!html.includes('rel="manifest"')) html = html.replace('</head>', tags);
// stop iPhones zooming into inputs and respect the notch
html = html.replace('content="width=device-width, initial-scale=1, shrink-to-fit=no"', 'content="width=device-width, initial-scale=1, viewport-fit=cover"');
writeFileSync(file, html);
console.log(`PWA tags added to ${file}`);
