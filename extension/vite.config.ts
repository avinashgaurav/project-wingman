import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { cpSync, existsSync, copyFileSync, readFileSync, writeFileSync } from "fs";

// Localhost host_permissions are kept OUT of the committed manifest (issue
// #37: shipping them in a production extension grants any visited page the
// ability to reach the user's local FastAPI / Ollama). They get injected
// here at build time only when running `vite build --mode development`.
const DEV_LOCALHOST_HOSTS = [
  "http://localhost:8000/*",
  "http://localhost:11434/*",
];

// The committed manifest is a TEMPLATE. These two placeholders are deployment-
// specific, so they are filled in at build time from extension/.env rather than
// committed. A fresh clone that skipped setup would otherwise ship
// YOUR_GOOGLE_CLIENT_ID to chrome.identity.getAuthToken (Google sign-in fails
// with a useless error) and leave the self-hoster's own backend absent from
// host_permissions (every fetch to it blocked by MV3).
const CLIENT_ID_PLACEHOLDER = "YOUR_GOOGLE_CLIENT_ID";
const BACKEND_HOST_PLACEHOLDER = "https://your-backend.railway.app/*";

/** `https://api.example.com/v1` -> `https://api.example.com/*`, or null if unusable. */
function hostPermissionFor(backendUrl: string): string | null {
  try {
    const { protocol, host } = new URL(backendUrl);
    // localhost is handled by DEV_LOCALHOST_HOSTS on dev builds only; a
    // production bundle must never grant page access to the user's machine.
    if (protocol !== "https:") return null;
    return `${protocol}//${host}/*`;
  } catch {
    return null;
  }
}

function copyStaticAssets(mode: string, env: Record<string, string>) {
  return {
    name: "copy-static-assets",
    closeBundle() {
      const root = resolve(__dirname);
      const out = resolve(__dirname, "dist");
      const manifestPath = resolve(out, "manifest.json");
      cpSync(resolve(root, "manifest.json"), manifestPath);

      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      const hosts = new Set<string>(manifest.host_permissions || []);

      // Real Google OAuth client ID, read from extension/.env.
      const clientId = env.VITE_GOOGLE_CLIENT_ID?.trim();
      if (clientId) {
        manifest.oauth2 = { ...manifest.oauth2, client_id: clientId };
      }

      // Real backend host replaces the placeholder entry.
      const backendHost = hostPermissionFor(env.VITE_BACKEND_URL?.trim() || "");
      if (backendHost) {
        hosts.delete(BACKEND_HOST_PLACEHOLDER);
        hosts.add(backendHost);
      }

      if (mode === "development") {
        // Dev build: inject localhost host_permissions so unpacked extension
        // can talk to localhost:8000 (backend) and localhost:11434 (Ollama).
        for (const h of DEV_LOCALHOST_HOSTS) hosts.add(h);
        // A localhost backend needs no https host entry; drop the placeholder
        // so the dev bundle does not advertise a host nobody owns.
        if (!backendHost) hosts.delete(BACKEND_HOST_PLACEHOLDER);
      }

      manifest.host_permissions = Array.from(hosts);
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

      // Two placeholders, two different severities.
      //
      // The backend host is fatal: without a matching host_permissions entry,
      // MV3 blocks every fetch to the backend and nothing in the product works.
      //
      // The OAuth client ID is NOT fatal. It is only read by
      // chrome.identity.getAuthToken, which only Google Slides/Docs/Drive export
      // (background/google-writer.ts) and Calendar sync
      // (meeting-copilot/integrations/google-calendar.ts) call. Sign-in does not
      // depend on it: the sidebar provisions a local admin user, and Zoho uses
      // launchWebAuthFlow, which builds its own auth URL. So a deployment that
      // does not want Google export is legitimately fine without one.
      if (mode === "production") {
        if (manifest.host_permissions.includes(BACKEND_HOST_PLACEHOLDER)) {
          throw new Error(
            "host_permissions still contains " +
              BACKEND_HOST_PLACEHOLDER +
              ".\nSet VITE_BACKEND_URL in extension/.env to your https backend URL." +
              "\nWithout it, MV3 blocks every request the extension makes to your backend.",
          );
        }
        if (manifest.oauth2?.client_id?.includes(CLIENT_ID_PLACEHOLDER)) {
          console.warn(
            "\n[manifest] oauth2.client_id is unset (still " +
              CLIENT_ID_PLACEHOLDER +
              ").\n" +
              "          Google Slides/Docs/Drive export and Calendar sync will not work.\n" +
              "          Everything else, including pitch generation, live mode and Zoho, is unaffected.\n" +
              "          Set VITE_GOOGLE_CLIENT_ID in extension/.env if you want those features.\n",
          );
        }
      }

      if (existsSync(resolve(root, "icons"))) {
        cpSync(resolve(root, "icons"), resolve(out, "icons"), { recursive: true });
      }
      // AudioWorklet processor — must be served as a plain script at the
      // extension root so chrome.runtime.getURL('audio-processor.js') resolves.
      // Vite does not bundle it (AudioWorklet scripts can't have ESM imports).
      const audioProc = resolve(root, "src/offscreen/audio-processor.js");
      if (existsSync(audioProc)) {
        copyFileSync(audioProc, resolve(out, "audio-processor.js"));
      }
    },
  };
}

// Wrap meet-transponder.js in an IIFE so re-injecting it (via
// chrome.scripting.executeScript when the original copy was loaded by a now-
// reloaded extension instance) doesn't crash with
// "Identifier 'X' has already been declared" — re-running the bundle in the
// same isolated world otherwise collides on its top-level let/const.
//
// Strategy: IIFE-scope every declaration so each injection's lets are
// independent, and clean up any stale DOM/styles from the previous instance
// so we don't end up with two transponder UIs side-by-side.
function idempotentTransponder() {
  return {
    name: "idempotent-transponder",
    generateBundle(_opts: unknown, bundle: Record<string, { type: string; code?: string }>) {
      const file = bundle["meet-transponder.js"];
      if (file && file.type === "chunk" && file.code) {
        const cleanup =
          "try{var __o=document.getElementById('clientlens-transponder');if(__o)__o.remove();" +
          "var __p=document.getElementById('clientlens-start-prompt');if(__p)__p.remove();" +
          "var __s=document.getElementById('clientlens-transponder-css');if(__s)__s.remove();" +
          "var __f=document.getElementById('clientlens-fonts');if(__f)__f.remove();}catch(_){}";
        file.code = "(function(){" + cleanup + "\n" + file.code + "\n})();";
      }
    },
  };
}


export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    // Third arg "" loads every var, not just the VITE_ prefix, so the manifest
    // transform can read values the client bundle never sees.
    copyStaticAssets(mode, loadEnv(mode, __dirname, "")),
    idempotentTransponder(),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        sidebar: resolve(__dirname, "sidebar.html"),
        popup: resolve(__dirname, "popup.html"),
        offscreen: resolve(__dirname, "offscreen.html"),
        background: resolve(__dirname, "src/background/service-worker.ts"),
        content: resolve(__dirname, "src/content/content-script.ts"),
        "meet-transponder": resolve(__dirname, "src/content/meet-transponder.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify(mode),
  },
}));
