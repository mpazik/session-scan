# Review corrections with Jev

This optional scanner uses [Jev](https://docs.typesafe.ai/introduction) to flag your corrections, explicitly repeated instructions, and frustration directed at the coding agent. Findings are review signals, not proof that the agent made a mistake.

## Run

Use a repository checkout with `bun install` completed. Obtain a TypeSafe API key and load it into the `TYPESAFE_API_KEY` environment variable using your secret manager. Do not put credentials in source files or command arguments. The scanner uses the official TypeSafe API, not an OpenRouter key.

Start with one session and a small turn window:

```bash
bun src/cli.ts /path/to/session.jsonl --last-turns 10 \
  --scanner ./examples/scanners/jev-corrections.ts
```

To scan recent sessions for a project instead, replace the positional path with `--cwd my-project`. Discovery defaults to the last seven days. A turn limit applies separately to each session, not to the whole run.

Use the default NDJSON output to retain the `finding` fields. Each flagged message includes its original text, event ID, session ID (`sid`), the returned model version, all three probabilities, and the flags whose probability is at least 0.8. A message can have several flags. No findings means no message passed this example's threshold, not that the session was error-free. The threshold has not been validated on your sessions.

`JEV_MODEL` optionally selects a TypeSafe model; the default is `jev-latest`.

## Data sharing and cost

Review the selected transcript before running. Each nonempty selected user message causes one paid request containing three independent Noul questions. Ten messages produce ten requests and thirty answers. There is no total spending cap; consult [TypeSafe](https://typesafe.ai/) for current pricing.

Each request sends your message and the last nonempty assistant reply from the previous turn, when available. Each text is limited to its first 8,000 characters, with truncation recorded in the request and finding. Earlier instructions are not sent, so the repetition question looks for explicit wording rather than comparing the full history. Missing or truncated context can affect accuracy.

The scanner does not send tool arguments, tool results, thinking fields, filesystem paths, or session IDs. Message text itself may still contain secrets or private code. The scanner does not redact them. Findings retain the full original user message locally.

Requests run sequentially with a 30-second timeout and no automatic retries. HTTP errors or malformed answers stop the scan; output already written remains partial. Rerunning makes new paid requests. The core `session-scan` commands still make no model calls unless you explicitly load this scanner.

## Offline tests

```bash
bun test test/integration/jev-corrections.test.ts
```

Tests use a fake HTTP boundary and synthetic messages. They verify integration behavior, not Jev's classification quality. No live evaluation is part of the test suite.
