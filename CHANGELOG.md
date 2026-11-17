# Changelog

## 0.1.0 (2026-11-17)

First release.

- Voice role play in the browser over WebRTC with the OpenAI Realtime API.
- The server starts every call (the browser never holds an OpenAI credential) and watches it over OpenAI's sideband connection. It hangs up at `SESSION_MAX_SECONDS` (counted from the request) or when the session is tampered with. It allows one reply at a time, reserves the most each reply can cost (8,000 tokens of conversation in, 1,024 out, at the dearest rates), and ends the call while one more reply still fits under `MAX_CALL_COST_USD`; it refuses a budget too small for two such replies. Until OpenAI confirms the hang-up it cancels every reply that starts and keeps automatic turns and transcription off, retrying for at least a minute. With Redis, a restarted server hangs up calls its predecessor was watching.
- The preflight `GET /api/session` is origin-checked and rate-limited like the POST.
- A preflight before the microphone opens checks the key and each model with OpenAI (free).
- Coaching scorecard from a strict JSON schema, requested with a one-time token per call: trust score, outcome, what worked, the biggest fix, a line to try instead, objections.
- Three homeowners: Sarah Chen (five-stage storm restoration program), Gary Lindqvist (HVAC replace or repair) and Priya Raman (window replacement price objection).
- AI disclosure and microphone consent before the mic opens; a setup notice that names any missing or invalid setting.
- Origin allow-list, sliding-window limits per visitor, a daily cap for the whole app, and IPs trusted only on Vercel or with `TRUST_PROXY`.
