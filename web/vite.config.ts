// Builds the page. web/ is the root and the result goes to dist-web/ (git-ignored) with a relative base, so that
// the built folder works under any path of any static host.
//
// The page is built as one classic script, not as a module: a browser refuses to load a module script from a
// file:// URL, and the built folder is meant to open by a double click as well. The plugin below rewrites the
// tags Vite writes for a module build.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

import { PEAR_COMMIT } from "../src/index";

const webRoot = fileURLToPath(new URL(".", import.meta.url));

/** Returns what the page calls its build, in its footer and in the first line of its log: the first 7 characters
 * of the commit a GitHub Actions job builds (its environment's GITHUB_SHA), and "dev" for a build made anywhere
 * else. Nothing else of the build's environment reaches the page, and the build runs no other program. */
function buildStamp(): string {
  const commit = (process.env.GITHUB_SHA ?? "").trim();

  return commit === "" ? "dev" : commit.slice(0, 7);
}

/** Makes the built page's script a classic deferred script and drops the cross-origin attributes, which a
 * file:// page cannot satisfy. */
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
  define: {
    __PEARJS_BUILD__: JSON.stringify(buildStamp()),
    // the commit of PEAR the library ports: given to the page as a constant, so that the page's bundle holds only
    // the modules it uses and not all the library's index names
    __PEAR_COMMIT__: JSON.stringify(PEAR_COMMIT),
  },
  build: {
    outDir: resolve(webRoot, "../dist-web"),
    emptyOutDir: true,
    target: "es2022",
    modulePreload: false,
    cssCodeSplit: false, // one style sheet, linked from the page, not injected by the script
    rolldownOptions: {
      input: { index: resolve(webRoot, "index.html") },
      output: { format: "iife" },
    },
  },
  // never opens a browser and never listens beyond this machine
  server: { host: "127.0.0.1", open: false },
  preview: { host: "127.0.0.1", open: false },
});
