# Contributing

Thanks for helping. New homeowners for other trades are the most useful contribution; see "Write your own homeowner" in the README.

## Ground rules

- **npm only.** Install with `npm ci`. Do not commit a `yarn.lock`, `pnpm-lock.yaml` or `bun.lock`.
- **Tests are required.** New behavior comes with a Vitest test in `test/`. New personas must pass `npm test` unchanged.
- **Run the full check before a pull request:**
  ```bash
  npm run check
  ```
- **No secrets.** Never commit a real key, a `.env.local` file or a call recording. CI runs a secret scan.
- **No real people.** Personas are fictional. Do not base one on a real customer, and do not add photos of real people.
- **Persona text is CC BY 4.0.** By contributing a persona you agree to license it under CC BY 4.0, and code under Apache-2.0.

## Sign your commits (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/) instead of a CLA. Add a `Signed-off-by` line to every commit to certify you wrote the change or have the right to submit it. CI checks every commit in a pull request:

```bash
git commit -s -m "Add a gutter guard homeowner"
```

## Checking the UI

Unit tests cover the server code and the browser call client (`lib/`), not the React components. For a change to `components/` or `app/`, run `npm run build && npm start`, then check in a Chromium-based browser: a full call, the scorecard, keyboard-only use (Tab to the homeowner cards and the Start and End buttons), a 390-pixel-wide window, and an empty browser console. Mute the tab or use headphones.

## Reporting problems

Bugs and persona requests go in GitHub issues. Security problems go through the private process in [SECURITY.md](SECURITY.md).
