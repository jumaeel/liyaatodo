/* ============================================================
   Liyaatodo · Firebase configuration
   ------------------------------------------------------------
   Fill this in ONCE to turn on Google sign-in + cloud save.
   It's free and takes about 5 minutes.

   1. Go to https://console.firebase.google.com  →  "Add project"
      (any name, e.g. "liyaatodo"). You can skip Google Analytics.

   2. Inside the project, click the  </>  (Web) icon to "Add app".
      Give it a nickname, click "Register app". Firebase shows a
      snippet like:  const firebaseConfig = { apiKey: "...", ... }
      Copy those values into the object below (replace every
      PASTE_… placeholder). These keys are safe to be public.

   3. Left menu → Build → Authentication → Get started →
      under "Sign-in method" enable  Google  → Save.

   4. Left menu → Build → Firestore Database → Create database →
      Start in production mode. Then open the "Rules" tab and paste
      the contents of  firestore.rules  (in this repo) → Publish.
      Those rules let each person read/write ONLY their own data.

   5. Authentication → Settings → "Authorized domains" → Add domain →
      add your live site domain (e.g.  jumaeel.github.io ).
      localhost is already allowed for local testing.

   Until this is filled in, the app keeps working in local-only mode
   (saved in this browser only) and the sign-in button stays hidden.
   ============================================================ */

window.firebaseConfig = {
  apiKey: "PASTE_API_KEY",
  authDomain: "PASTE_PROJECT.firebaseapp.com",
  projectId: "PASTE_PROJECT_ID",
  appId: "PASTE_APP_ID",
};
