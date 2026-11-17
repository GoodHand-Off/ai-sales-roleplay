# Security

Please report security problems privately through GitHub's private vulnerability reporting: open [this repository's **Security** tab](https://github.com/nussbeck-labs/ai-sales-roleplay/security/advisories/new) and choose **Report a vulnerability**. Do not open a public issue.

Known limits, documented in the README under "Limits and their gaps": the per-call budget is an estimate, and once the server decides to end a call, a modified browser can keep starting replies until OpenAI confirms the hang-up: each is cancelled, but its input may be billed (up to $0.0827 at the defaults; billing of replies cancelled that early is unverified). That is normally under a second, but while OpenAI's hang-up keeps failing it lasts up to 290 seconds after the call was requested, and after that only a sweep retries the hang-up, without cancelling, until it succeeds or OpenAI's 60-minute limit ends the call; a modified browser can still ask for single replies with their own instructions and input, up to the call's budget and time cap, and pass the budget by one such reply; and without Redis a server crash forgets the calls that process was watching. With Redis on a serverless host, a call left behind is hung up only when a later call or a new instance starts.

Useful reports for this kit include:

- A way to keep a voice call open past `SESSION_MAX_SECONDS`.
- A way to start calls or scorecards from another website, or to get around the rate limits cheaply.
- Anything that exposes the OpenAI API key or another visitor's transcript.
- A transcript that makes the scorecard model follow instructions instead of scoring.

We aim to acknowledge reports within three business days and to fix confirmed issues in the next release. Supported version: the latest release on `main`.
