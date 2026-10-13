# The result envelope

Every lifecycle command prints one `legion-flow-result/v1` document under `--json`.

```jsonc
{
  "schema": "legion-flow-result/v1",
  "command": "execute",
  "runId": "run_01j",                      // optional
  "status": "awaiting_decision",           // ok | ready | awaiting_decision | blocked | refused | usage_error
  "phase": "awaiting_decision",            // one of the project phases
  "diagnostics": [{ "code": "proposal_pending", "severity": "warning", "message": "...", "path": "...", "hint": "FIX: ..." }],
  "gates": [],                             // ship only: tri-state verdicts
  "nextAction": { "type": "human_decision", "interruptId": "int_01j", "decisionKind": "approve_action", "run": "legion-flow decide int_01j --approve --approver <id>", "payloadRef": { "path": "...", "sha256": "..." }, "responseSchema": "legion-flow-decision/v1" }
}
```

## Status to exit code

| status | exit | meaning |
|---|---|---|
| `ok`, `ready` | 0 | the command did what it says |
| `refused`, `usage_error` | 2 | a precondition failed; the first diagnostic names it |
| `blocked`, `awaiting_decision` | 3 | the product is working: a gate is unmet or a human must decide |
| (none) | 1 | an unexpected error, or a handler produced an invalid envelope; the message is on stderr |

Three paths print no envelope at all: a sibling product's verb (exit 2, one line on stderr naming the owning tool), a malformed command line (exit 2, usage on stderr), and `mcp` and `help-all`, which own stdout. Read stderr there; everywhere else, parse the document.

## Next action types

| type | fields | what a host agent does |
|---|---|---|
| `command` | `run`, `hint` | run it, if it is a verb you may run |
| `human_decision` | `interruptId`, `decisionKind`, `run`, `responseSchema`, optional `payloadRef` `{ path, sha256 }` | stop; report the interrupt to the human |
| `credential_required` | `variable`, `adapter`, `hint` | stop; report the variable name, never a value |
| `wait` | `until`, `reason` | wait |
| `none` | `reason` | nothing to do |

Diagnostics carry a stable `code` to branch on and a `hint` that is the instruction itself. Facts a human needs (project name, adapter, run id) travel as `info` diagnostics.
