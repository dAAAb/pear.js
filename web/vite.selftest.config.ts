// Builds web/selftest.html, the page that replays the library's fixtures in a browser, into dist-web/ next to
// the page, as one classic script like the page's own. It is a build of its own: `npm run build:web` does not
// run it, so the self-test is not in what GitHub Pages publishes (it needs tests/fixtures served beside it).
// The browser check's part "selftest" runs it:
//
//   node node_modules/vite/bin/vite.js build --config web/vite.selftest.config.ts
//
// It leaves what is in dist-web/ in place; `npm run build:web` empties the folder.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const webRoot = fileURLToPath(new URL(".", import.meta.url));

function classicScript(): Plugin {
  return {
    name: "pearjs-classic-script",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        return html.replace(/<script type="module" crossorigin/g, "<script defer").replace(/ crossorigin(?=[\s>])/g, "");
      },
    },
  };
}

export default defineConfig({
  root: webRoot,
  base: "./",
  publicDir: false,
  plugins: [classicScript()],
  build: {
    outDir: resolve(webRoot, "../dist-web"),
    emptyOutDir: false,
    target: "es2022",
    modulePreload: false,
    cssCodeSplit: false,
    rolldownOptions: {
      input: { selftest: resolve(webRoot, "selftest.html") },
      output: { format: "iife" },
    },
  },
  server: { host: "127.0.0.1", open: false },
  preview: { host: "127.0.0.1", open: false },
});
