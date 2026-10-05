/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const API = 'http://127.0.0.1:8787'

// GitHub Pages can't send security headers, so the phone build carries its policy in a meta tag.
const PHONE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  // finnhub.io: live prices, only when you add your own key (see src/phone/live.ts)
  "connect-src 'self' https://finnhub.io",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

/** Head tags that make the phone build installable on an iPhone Home Screen. */
function phoneHead(): Plugin {
  return {
    name: 'keystone-phone-head',
    transformIndexHtml(html) {
      return html
        .replace('<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
          '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />')
        .replace('</head>', [
          `    <meta http-equiv="Content-Security-Policy" content="${PHONE_CSP}" />`,
          '    <link rel="manifest" href="./manifest.webmanifest" />',
          '    <link rel="apple-touch-icon" href="./apple-touch-icon.png" />',
          '    <meta name="apple-mobile-web-app-capable" content="yes" />',
          '    <meta name="mobile-web-app-capable" content="yes" />',
          '    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />',
          '    <meta name="apple-mobile-web-app-title" content="Keystone" />',
          '    <meta name="theme-color" content="#0a2240" />',
          '  </head>',
        ].join('\n'))
    },
  }
}

export default defineConfig(({ mode }) => {
  const phone = mode === 'phone'
  return {
    plugins: [react(), tailwindcss(), ...(phone ? [phoneHead()] : [])],
    // The phone app lives under https://<user>.github.io/<repo>/, so paths must be relative.
    base: phone ? './' : '/',
    // When this copy of the app was built, shown in the phone footer so you can tell an update
    // arrived.
    define: { __APP_BUILT__: JSON.stringify(new Date().toISOString()) },
    publicDir: phone ? 'phone-public' : 'public',
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      // Same-origin in dev too: the browser only ever talks to :5173, which proxies /api.
      proxy: { '/api': { target: API, changeOrigin: false } },
    },
    preview: { host: '127.0.0.1', port: 4173, strictPort: true },
    build: { sourcemap: false, target: 'es2022', outDir: phone ? 'dist-phone' : 'dist' },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      restoreMocks: true,
    },
  }
})
