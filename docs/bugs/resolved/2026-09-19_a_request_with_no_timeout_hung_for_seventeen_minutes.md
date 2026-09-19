# A catalogue request with no timeout hung for seventeen minutes

## What was expected

`findRecordingDetail` makes one HTTP request to MusicBrainz. Observed
latency is 165–460ms. A bulk pass over 1,167 recordings, paced at 1.2s
between requests, should take about twenty-three minutes.

## What actually happened

The pass processed **30 rows in 2,238 seconds — 75 seconds per row**, against
a 1.2-second sleep. Projected over 1,167 rows that is **24 hours**.

Instrumenting the client call per row found the cause immediately:

```
  0196a897  451ms      work=no
  d0492d6f  163ms      work=yes
  5c0814e4  267ms      ERROR TypeError fetch failed
  16b8dd94  408ms      work=no
  cd066610  216ms      work=no
  2dbf791e  1022647ms  ERROR TypeError fetch failed
```

**One request took 1,022,647 milliseconds — seventeen minutes — and then
failed.** Five neighbours averaged 300ms.

## The cause

`requestJson` in `src/catalogue/musicbrainz_client.ts` calls `fetch` with no
`signal`:

```ts
const response = await fetcher(`${MUSICBRAINZ_API_BASE}${path}`, {
  headers: { "User-Agent": MUSICBRAINZ_USER_AGENT, Accept: "application/json" },
});
```

**Node's `fetch` has no default timeout.** A connection that is accepted and
then never answered hangs until the OS gives up, which on macOS can be many
minutes. `listenbrainz_client.ts` has the same gap.

The Worker is not exposed to this — Cloudflare caps a request's wall time
independently — but every command-line script that imports these clients is,
and that is how bulk passes are run.

## Why three diagnoses were wrong before this one

Each was a plausible cause that the evidence did not actually support, and
each was reached by testing something *adjacent* to the failing code rather
than the failing code itself:

1. **"One row retrying forever."** A bounded retry was written and committed.
   But `gaveUp` was 0 in every run — if retries were exhausting, it would not
   be. A hang is not a 503, so the retry path never executed at all.
2. **"MusicBrainz is throttling this client."** `curl` was tested three times
   and returned 200 in 0.4s; a sustained 15-request run at the script's own
   spacing returned `ok=15 busy503=0`. There was never any throttling.
3. **"The script is stalled and still running."** The pid inspected was the
   `/bin/zsh` wrapper at 0.0% CPU with no open sockets; the `tsx` process had
   already exited. Process state was read from the wrong process.

The lesson is narrower than "test more": **a slow aggregate hides a bimodal
distribution.** 75 seconds per row was never any row's actual cost — it was
twenty-nine rows at 300ms and one at seventeen minutes. Averages describe a
population that may not exist, and every theory above was an attempt to
explain a 75-second request that never happened.

## Proposed fix

A timeout on every outbound request in both catalogue clients, via
`AbortSignal.timeout`. A request that has not completed in a bounded time is
not going to; failing it fast turns a seventeen-minute hang into one counted
error and lets the pass continue.

The timeout belongs in the clients rather than in each script, because the
scripts are not the only callers and a per-caller timeout is a rule enforced
by remembering.

## Regression test

A test that calls a client with an injected fetcher which never resolves, and
asserts the call rejects rather than hanging. It fails today by never
returning — which is itself the symptom, so the test needs its own outer
bound.

## Verified 2026-09-19

`AbortSignal.timeout(10_000)` added to every request in both catalogue
clients. The same 30 rows that took 2,238 seconds:

```
  30 rows in 168s   (was 2238s)
  DONE 30: 2 works, 28 without, 0 gave up
```

**A 13x improvement.** 168s is still above the theoretical 36s (30 rows at
1.2s spacing), so a few requests are reaching the ten-second bound — but that
is the timeout working rather than a hang, and it turns a 24-hour projection
into about 109 minutes.

Three regression tests in
`tests/catalogue/catalogue_requests_time_out.source.test.ts`, verified to fail
when the signal is removed: `x gives a MusicBrainz request an abort signal`.
