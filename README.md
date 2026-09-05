# Bhumi Setu — Land Record Digitization & Validation System

A concept site for an intelligent land-record digitization and validation
system, built for the Ministry of Rural Development / Department of Land
Resources. This is a **local demo** — a real 3D-animated front end backed
by a small working server, not a production system and not connected to
any real land registry.

## Run it

No `npm install` needed — the server only uses Node's built-in modules.

```
node server.js
```

Then open **http://localhost:3000**.

(If you'd rather just look at the design with no backend, you can still
open `public/index.html` directly in a browser — everything works except
the "Check a record" demo and the contact form, which need the server to
answer their requests.)

## What's here

```
bhumi-setu/
├── server.js          the backend (plain Node http module, no dependencies)
├── package.json
├── data/
│   ├── records.json    sample land parcels the "Check a record" demo reads from
│   └── contacts.json   messages submitted through the contact form land here
└── public/
    └── index.html       the site itself
```

## Try the record-lookup demo

The "Check a record" section on the site calls a real endpoint and runs
real matching logic. Sample parcels to try (also available as clickable
chips on the page):

| Parcel ID     | Owner name          | Survey number | Result you should see |
|---------------|---------------------|---------------|------------------------|
| UP-GZB-0231   | Ram Bahadur Singh   | 118/4         | Validated |
| MH-PUN-1042   | Sunita Deshmukh     | 76/2A         | Needs review (name is a partial match — the record on file has a middle initial) |
| TN-TVL-0087   | Karthik Raja        | 203           | Mismatch found (the survey number on file is `203/1B`) |
| anything else | —                   | —             | Not found |

## API reference

**POST `/api/validate`**
Body: `{ "parcelId": "UP-GZB-0231", "ownerName": "...", "surveyNumber": "..." }`
Returns: `{ status: "validated" | "needs_review" | "mismatch" | "not_found", confidence?, record? }`

**POST `/api/contact`**
Body: `{ "name", "email", "phone", "district", "subject", "message" }`
Returns: `{ id: "BS-XXXXXXXX" }` and appends the message to `data/contacts.json`.

**GET `/api/records`** — list all sample parcels
**GET `/api/records/:parcelId`** — fetch one sample parcel
**GET `/api/contact`** — list submitted messages (demo/admin use — no auth)
**GET `/api/stats`** — parcel/district/message counts

## Extending it

- Swap `data/records.json` for a real database (Postgres/PostGIS is the
  natural fit once GIS boundaries are involved) — everything reading it
  goes through `getRecords()` in `server.js`, so that's the one place to
  change.
- The name/survey-number matching in `compareName` / `compareSurvey` is
  intentionally simple (exact / partial / mismatch) so the demo states are
  easy to reproduce. Real OCR-sourced data will need fuzzier matching —
  edit-distance on names, tolerant parsing of survey-number formats, etc.
- There's no authentication anywhere in this demo. A real deployment would
  need it at minimum on `/api/contact` (to prevent spam) and on any
  endpoint exposing citizen data.
