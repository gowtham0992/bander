# Build Week submission checklist

Current deadline: Tuesday, July 21, 2026 at 5:00 PM Pacific Time.

## Product proof

- [x] One-command local app without an OpenAI API key
- [x] One-time Draft → Card → Band → Permit → Receipt flow
- [x] Changed-world refusal with no partial Calendar/Messages commit
- [x] Authority attack suite and deliberately invalidated test evidence
- [x] Narrow standing Band, adjacent fallback Card, action cap, and visible revocation
- [x] Real OpenClaw Streamable HTTP probe with exactly three tools
- [x] Isolated OpenClaw environment with no downstream credentials
- [x] Optional GPT-5.6 Structured Outputs compiler behind `OPENAI_API_KEY`
- [x] Consumer desktop and responsive visual QA
- [ ] Live GPT-5.6 request with the recording key
- [ ] Final full-suite run on the recording machine

## Required artifacts

- [x] Source-of-truth builder plan
- [x] Public-facing README with setup and boundary claim
- [x] `BUILD_WITH_CODEX.md` evidence ledger
- [x] Private GitHub repository connected as `gowtham0992/bander`
- [ ] Make the repository public for judging
- [ ] Public YouTube video under three minutes with voiceover
- [ ] Explain both Codex and GPT-5.6 use in the video
- [ ] Add the public repository and video URLs to Devpost
- [ ] Run `/feedback` in the build task and save the Session ID
- [ ] Put the `/feedback` Session ID in the required submission field

## Devpost polish

- [ ] Replace the current draft tagline with the final consumer promise
- [ ] Write the final project story: problem, experience, architecture, exact claim, limitations, and next steps
- [ ] Add product screenshots with no secrets or personal data
- [ ] Confirm the project is entered in “Apps for Your Life”
- [ ] Re-read every live submission field and announcement before publishing
- [ ] Submit early enough to verify the public project page, repository, and video

## Final command pass

```bash
npm run check
npm run attack
npm run build
npm audit --audit-level=high
npm run demo
# second terminal
npm run verify:demo
npm run openclaw -- mcp doctor bander --probe
```
