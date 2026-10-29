# 5. Exercise 2: An Authenticated TCP Loopback Client with Session Immutability and Reconnection Semantics — solution

The worked answer to Exercise 2: a raw JSON-Lines control client for
PhotoCraft's loopback channel. The first frame on every connection is `auth`;
the session view is an immutable snapshot; every command is written to an
append-only ledger before it goes on the wire; and reconnect reconciles the
ledger against the server's history instead of replaying a command that may
already have landed.

## What it does

`JsonlLedger` appends one JSON object per issue and one per acknowledgement,
flushing and `fsync`ing each line. `ControlClient.connect()` authenticates and
adopts the server's active document into a fresh `SessionSnapshot`.
`execute()` writes the issue before the frame leaves and appends the ack only
after the reply arrives. A dropped reply therefore leaves exactly one unacked
entry.

`ControlClient.recover()` opens a fresh socket, authenticates again, asks
`session.list`, reconciles the unacked entries against `document.inspect`,
re-activates the prior document, and returns a *new* snapshot with `epoch + 1`.
The `recover()` combinator is pure: the prior dataclass is never mutated.
`ReconnectFSM` applies exponential backoff with jitter and raises
`TokenRotationRequired` after three consecutive auth rejections with the same
token.

## The listings

| file | what it is |
| --- | --- |
| `02_an-authenticated-tcp-loopback-client-with-session-immutability-and-reconnection-semantics.py` | the worked client, ledger, pure recovery combinator and reconnect FSM |
| `_stub_server.py` | a protocol-faithful loopback stub that can drop a reply mid-command |
| `run_ex2.py` | the acceptance harness — eight checks plus the saved evidence |

## Run it

```bash
cd chapter5/solutions_and_explanations/exercise_2_an-authenticated-tcp-loopback-client-with-session-immutability-and-reconnection-/files
PY=$("../../../../tools/pick_python.sh")
"$PY" run_ex2.py
```

```
authenticated control channel

PASS a wrong token fails closed
PASS connect() adopts the server's active document
PASS execute() records an issue and an ack
PASS a lost reply leaves the command unacked
PASS recover() acks from history instead of replaying
PASS recover() is pure: the prior snapshot is untouched
PASS the FSM escalates after three auth rejections
PASS the JSONL ledger replays with every command acknowledged

8/8 checks passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/ledger/ledger.jsonl` | the append-only issue/ack ledger from the run |
| `output/session/initial.json` | the snapshot adopted by `connect()`, token redacted |
| `output/session/recovered.json` | the new snapshot returned by `recover()` |
| `output/reconciliation/history.json` | the stub's command history and execution counts |
| `output/reconciliation/ledger-records.json` | the same ledger, parsed into readable JSON |
| `output/report.json` | all eight results, snapshot epochs and ledger counts |
| `output/run_ex2.log` | the harness log — eight checks and their tally |

The run demonstrates the important negative result too: `report.json` records
`"replayed": false`, because recovery marked the in-flight `paint.stroke` as
acked from history without re-issuing it.

## Notes

- **Python 3.10+.** The solution uses frozen slotted dataclasses, PEP 604
  unions and `asyncio`; `tools/pick_python.sh` prefers the repository's
  `.venv` and falls back to the newest `python3.x`.
- **No engine binary is required.** The stub binds `127.0.0.1:0`, so the OS
  picks a free port and the run can be repeated immediately.
- The stub is test infrastructure, not part of the production client. It
  speaks the same auth-first framing so the harness can exercise a dropped
  reply deterministically.
- Tokens are redacted from the saved snapshots and report; only a short
  fingerprint remains for correlation.
