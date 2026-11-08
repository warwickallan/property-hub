# Property Hub

A lightweight **single-operator property compliance tracker**: property register, document and certificate records, manual PPM/compliance recalculation, colour-coded due dates, simple inspections and reviewable email reminder drafts.

**Status:** Specification / development kickoff. The application is **not built or deployed** yet.

## Intended first cut

- A mobile-friendly web application using React/Next.js and SQLite with persistent local data.
- One operator maintains records. Team leaders only receive reminders; they do not log into Property Hub.
- Compliance statuses update when the operator clicks **Recalculate Compliance**, not through a background scheduler.
- Preview reminder messages before sending; never send real email during prototyping.
- A 30-item visual-inspection template imported from `data/inspection_template_seed.json`.
- Certificates and inspection evidence belong to properties, with configurable check frequencies.
- Service charge management is deferred until requirements are clarified.

## Begin development

1. Read [Opus kickoff](docs/OPUS_START_HERE.md).
2. Read [full product specification](docs/PROPERTYHUB_BUILD_SPEC.md).
3. Import the [inspection checklist seed](data/inspection_template_seed.json).
4. Build against **fictional properties and synthetic test data**.
5. Demonstrate: Dashboard → Property → Inspection/evidence → Remedial action → Recalculate → Reminder preview.

The repository is source control, **not a document vault**. Do not commit real property addresses, personal information, credentials, uploads, or a live SQLite database.

## Development boundaries

The repo and initial document commit are authorised. Further pushes, external deployments, real email sends and use of live organisational information require explicit project-owner instruction.
