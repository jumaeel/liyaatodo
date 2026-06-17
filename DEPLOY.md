# Deploying Liyaatodo

Liyaatodo is a **static PWA** (HTML + Tailwind CDN + vanilla JS). The backend is
**Firebase** (Firestore + Google Auth). There is no build framework — the site is
just the files in this repo's root.

- **Repo:** github.com/jumaeel/liyaatodo (branch `main`)
- **Host:** Cloudflare Pages → **https://liyaatodo.pages.dev**
- **Firebase project:** `liyaatodo`

## Site assets (the only files that get served)

```
index.html  app.js  styles.css  sw.js  manifest.json
logo-mark.svg  firebase-config.js  _headers  preview-dashboard.jpg
```

Everything else (`firebase.json`, `firestore.rules`, `.firebaserc`, `build.sh`,
`DEPLOY.md`, …) is project tooling and must **not** be served.

## Before every deploy

Bump the cache version so clients pick up the new build immediately:

```
# sw.js
const CACHE = 'liyaatodo-vNN';   // increment NN
```

The service worker is network-first for the app shell, so a bump isn't strictly
required, but it keeps offline caches current. `_headers` already sets
`Cache-Control: no-cache` on `index.html` / `sw.js` / `manifest.json` /
`firebase-config.js`.

---

## Option A — Manual deploy (current setup: Direct-Upload project)

Wrangler is logged in (`jumaelmohamed@gmail.com`).

```bash
rm -rf .cf-publish && mkdir -p .cf-publish
cp index.html app.js styles.css sw.js manifest.json \
   logo-mark.svg firebase-config.js _headers preview-dashboard.jpg .cf-publish/
npx wrangler pages deploy .cf-publish \
   --project-name liyaatodo --branch main --commit-dirty=true
rm -rf .cf-publish
```

> ⚠️ **Uploads can be very slow/throttled** depending on the network — a deploy
> may sit at `Uploading... (5/8)` for many minutes (once ~40 min). It is **not
> stuck** — let it finish. **Don't** kill & retry; each retry restarts the upload.

---

## Option B — Git auto-deploy (recommended)

Deploy on every `git push` from Cloudflare's own build infra (no slow local
upload). A Direct-Upload project **cannot** be converted to Git, so create a new
Git-connected project.

**To keep the `liyaatodo.pages.dev` URL (no Firebase change):**

1. Delete the current Direct-Upload project:
   *Workers & Pages → liyaatodo → Settings → Delete project.* (~2 min downtime.)
2. *Workers & Pages → Create → Pages → Connect to Git* → authorize GitHub → pick
   `jumaeel/liyaatodo`, then:
   - **Project name:** `liyaatodo`
   - **Production branch:** `main`
   - **Framework preset:** None
   - **Build command:** `bash build.sh`
   - **Build output directory:** `public`
3. Save & Deploy. `build.sh` stages the site assets into `public/`.

`liyaatodo.pages.dev` is already a Firebase **authorized domain**, so Google
sign-in keeps working. (If you instead use a new project name, add that
`*.pages.dev` domain under **Firebase → Authentication → Authorized domains**.)

---

## Firebase authorized domains (Google sign-in)

Google sign-in only works on domains listed in
**Firebase → Authentication → Settings → Authorized domains**. Currently allowed:
`localhost`, `liyaatodo.firebaseapp.com`, `liyaatodo.web.app`,
`jumaeel.github.io`, `liyaatodo.pages.dev`. Add any new deploy domain there or
sign-in fails with `auth/unauthorized-domain`.
