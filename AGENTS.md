# Repository Guidelines

## Project Structure

This repository is an Astro site written in TypeScript. Pages and route components live in `src/pages/`; reusable UI is in `src/components/`; shared data access and provider integrations are in `src/lib/`; and global styles are in `src/styles/`. Static assets are under `public/`. Catalog data and provider mappings are under `data/`. The Cloudflare Worker entry point is `worker/index.ts`, while ingestion, indexing, synchronization, and end-to-end test utilities are in `tools/`.

## Development and Build Commands

- `npm run dev` starts the local Astro development server.
- `npm run build` runs TypeScript checking, builds the site, and creates the Pagefind search index in `dist/`.
- `npm run preview` serves the generated build locally.
- `npm run test:e2e` runs the Node test runner against `tools/e2e.test.ts` via `tsx`.
- `npm run ingest` refreshes catalog data; `npm run build:index` rebuilds its search index.
- `npm run provider:sync` synchronizes provider mappings; `npm run deploy:worker` deploys the Cloudflare Worker.

Use `npm install` to install dependencies. Run the build and relevant tests before submitting changes.

## Code Style and Naming

Use TypeScript for application logic and Astro components for pages and UI. Follow the existing two-space indentation, ESM imports, and strict TypeScript configuration. Use descriptive `camelCase` names for variables and functions, `PascalCase` for components and types, and kebab-case for static asset filenames. Keep route files aligned with Astro's filesystem routing conventions, including bracketed dynamic segments such as `[slug]`.

No formatter or linter is configured in `package.json`; match nearby code and avoid introducing formatting tools without a project need.

## Testing Guidelines

The configured automated test command is `npm run test:e2e`; test code currently lives in `tools/e2e.test.ts` and uses Node's built-in test runner. Name future test files descriptively and use `.test.ts`. The build also type-checks the project. No coverage threshold is configured.

## Commits and Pull Requests

Git history is unavailable in this checkout, so no repository-specific commit convention can be confirmed. Use concise imperative commit subjects (for example, `Fix episode route metadata`). Pull requests should explain the user-visible change, list validation commands and results, link related issues when applicable, and include screenshots for visual changes.

## Configuration and Data

Keep credentials and machine-specific settings out of source control. Review changes to `data/` carefully: generated catalog files and provider mappings may affect site output. Update relevant documentation when changing ingestion or deployment behavior.

