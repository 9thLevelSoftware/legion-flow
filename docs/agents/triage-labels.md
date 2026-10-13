# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the label strings for this repo's issue tracker (`issue-tracker.md`). The two columns are equal: the tracker is local markdown and no issue has been filed yet, so no other vocabulary exists to map to.

| Role                       | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

The right-hand column changes only if the tracker moves to a service with its own label vocabulary.
