# Property Hub — project instructions

This repository contains a local-first, single-operator property compliance app. Product owner's latest agreed architecture is **v0.3**.

**Read in order:**
1. `docs/OPUS_START_HERE.md` (current executable build mandate).
2. `docs/PROPERTYHUB_UI_DATA_MODEL_V03.md` (authoritative entity hierarchy, screens, links, workflows).
3. `docs/PROPERTYHUB_BUILD_SPEC.md` (legacy v0.2; use only nonconflicting calculation, inspection, reminder details).
4. `data/inspection_template_seed.json` (30 inspection questions, preserve text).

Core hierarchy: Area -> Site -> Room -> Equipment. A Site is a property. Equipment must link to a Room. A Compliance Activity links one Compliance Type to one Area OR Site OR Room, with optional many-to-many Equipment associations. Documents are uploaded once into local private storage and associated via reusable document links.

MVP: Dashboard and filterable registers first; Admin section manages Users/contacts, Core Data, Compliance Types, Settings. One operator initially; others are email recipients, not account holders. Recalculate compliance **manually only** and preview reminders before manual draft export/demo send. Never auto-send emails.

Use React + Vite + TypeScript, Express + TypeScript, SQLite. Fictional demo records only; no real locations or resident data. No hosting or public deployment. No external GitHub writes/pushes or PRs without explicit instruction. Local edits/tests and local commits are fine.
