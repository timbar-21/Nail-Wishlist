# Krista's Nail Journal

A mobile-first photo journal for manicures and nail designs, plus a separate
wishlist for designs to try (with links to Pinterest and elsewhere).

Static single-page app, no build step — open `index.html` or host the folder
as-is (e.g. GitHub Pages). State is local-first (`localStorage`) and mirrors
to Firebase Firestore once configured, so it works offline and syncs across
devices when online.

## Views

- **Gallery** — photo grid with filter chips (occasion / season / color /
  rating) and sort by date or rating.
- **Design detail** — full photo, tags, rating, notes; if the design started
  from a wishlist item, shows the inspo photo next to the actual result.
- **Add / Edit design** — photo capture or upload, tag pickers, rating,
  notes.
- **Wishlist** — separate list, "add via link" form, "mark as tried" (which
  promotes the item into a Gallery entry and auto-fills its tags).
- **Salons** — a salon finder plus a saved-salon shortlist:
  - *What you're after* — a nail profile learned from history: each
    design votes for its technique, shape, and any styles its notes
    mention (chrome, French, nail art…), weighted by rating (Love 3,
    Like 2, Meh 0.5, Skip −1, +1 if "would repeat"); wishlist titles and
    notes vote for styles too. The top technique and style are
    preselected as search terms; every chip can be toggled.
  - *Near* — a saved home neighborhood, "where I am" (lets the Maps app
    use the phone's location — no permission prompt here), or anywhere
    else; plus free-text extras and an "open now" toggle.
  - The search opens Google Maps with the built query (plus one-term
    searches when several terms are picked). There's no Places API key
    or billing involved — ratings and reviews are read in Maps itself.
    Search criteria are remembered per device and don't sync.
  - *My salons* — save a place as Want to try / Tried / Favorite with
    its Maps link and notes. Designs whose Location matches a saved
    salon's name show up on that salon (the design form suggests saved
    names), and logging a design at a "want to try" salon marks it tried.

## Setting up cross-device sync (Firebase)

Sync is off by default — the app runs entirely on-device until you fill in a
real Firebase config. To turn it on:

1. Create a **new** Firebase project at
   [console.firebase.google.com](https://console.firebase.google.com) —
   use a separate project from any other app, per the build spec. The
   free **Spark** plan is enough; no billing/credit card required.
2. In the project, add a **Web app** (the `</>` icon on the project
   overview page) and copy the `firebaseConfig` object it gives you.
3. Enable **Firestore** (Build → Firestore Database → Create database,
   start in production mode — the rules below replace the defaults).
   That's the only Firebase product this app uses — deliberately not
   Firebase Storage, since Cloud Storage now requires the paid Blaze
   plan even at zero usage. Photos are compressed client-side and
   embedded directly in the Firestore document instead (see "Data
   model" below), which keeps everything on the free tier.
4. Open `app.js` and replace the placeholder `FIREBASE_CONFIG` values near
   the top of the file with the real ones from step 2.
5. Deploy the security rules: paste the contents of `firestore.rules`
   into Firestore → Rules in the console and publish.

   (Or with the Firebase CLI: `firebase deploy --only firestore:rules`
   from a project initialized against your new Firebase project.)
6. Commit and redeploy the site. `FIREBASE_ENABLED` flips on automatically
   once the config no longer contains placeholder `YOUR_...` values, and the
   passcode lock screen will start appearing (`REQUIRE_PASSCODE` is `true`
   in this app, unlike the wine-cellar app it's modeled on).

**⚠️ Manual check needed:** rules can't be verified from client code. After
publishing `firestore.rules`, open the Firebase console (Firestore → Rules)
and confirm the **published** ruleset matches what's in this repo — not the
wide-open defaults Firestore starts new projects with. The whole security
model here rests on the passcode's SHA-256 hash being unguessable, so also
pick a passcode that isn't a dictionary word or a short PIN.

### How the passcode gate works

The passcode is never sent anywhere — only its SHA-256 hash is, and that
hash becomes the Firestore path prefix (`passcodes/{hash}/...`). A device
that doesn't know the passcode can't compute a matching path, so
`firestore.rules` denies it by construction rather than by checking a
stored secret. This is the same model
[Kev's Cellar](https://github.com/kristaamc-lab/Kevs-Cellar) uses, just
turned on by default here.

## Data model

- `designs` — one Firestore document per logged manicure: photo (embedded
  as a compressed base64 `data:` URL — see below), date, occasion/season/
  colors tags, technique, location, artist name/handle, shape, rating
  tier, would-repeat flag, optional `wishlistId` back-link, notes.
- `wishlist` — one document per saved inspo: title, source link, optional
  thumbnail (same embedded-photo approach), same occasion/season/colors
  taxonomy, notes, status (`saved`/`tried`), and `resultDesignId` once
  marked tried.
- `salons` — one document per saved salon: name, neighborhood, optional
  Google Maps link, status (`want`/`tried`/`favorite`), notes. Linked to
  designs by name via the design's `location`, not by ID.

**Upgrading an existing deploy:** the `salons` subcollection needs the
updated `firestore.rules` published (`firebase deploy --only
firestore:rules`, or paste it into the console). Until then designs and
wishlist keep syncing as before and saved salons stay on each device.

Photos are compressed client-side (resized to ~800px long edge, JPEG ~0.6
quality, shrinking further in a couple of steps if needed) and embedded
directly in the document as a `data:` URL, comfortably under Firestore's
1MiB-per-document limit. This trades a small amount of per-photo overhead
(base64 is ~33% bigger than raw bytes) for staying entirely on Firestore's
free Spark tier — no Firebase Storage, no Blaze plan, no credit card.

## Local development

No build step — just serve the folder statically, e.g.:

```
python3 -m http.server 8000
```

Then open `http://localhost:8000`. Camera capture (`capture="environment"`)
only works on a real mobile browser or over HTTPS; on desktop the file
input falls back to a normal file picker.
