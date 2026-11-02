# Identities

Which account to act as, per service, decided by the repo's path — never by whatever the shell
happens to have active.

## GitHub (`gh`) and GitLab (`glab`)

| Repo path | Account | Kind |
|---|---|---|
| `~/Workspace/<Company>/**` | `<company-account>` | company |
| everything else | `<personal-account>` | personal |

- `gh` write (PR, issue, comment, merge): prefix each call with `GH_TOKEN=$(gh auth token --user
  <acct>)`; never `gh auth switch` — it is global and parallel sessions flip it.

Other services: no row, no default: ask.
