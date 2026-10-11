---
name: release
description: Publish a new GitHub release of SkyTeam (which deploys it to production). Use when the user asks to release, cut/publish a release, ship, or deploy a new version. Takes an optional argument - "minor", "major", or an exact tag like v0.2.0; defaults to a patch bump.
---

# Release

Publishing a full (non-pre-)release of `martinjakubec/skyteam` triggers
`.github/workflows/deploy.yml`, which deploys to https://skyteam.mjakubec.eu.
So nothing is published until the user has seen the proposal and said yes.

The release is created with GitHub's REST API and `curl`; the GitHub MCP server
can read releases but not create them. The token is `$GITHUB_PERSONAL_ACCESS_TOKEN`
(fine-grained, Contents: read and write). Never print it, echo it, or put it in
a file.

## 1. Check

Git over SSH may not work in this shell (no key), so the remote's state comes
from the API, with the token. A helper for the GETs:

```bash
gh_api() { curl -sS -H "Authorization: Bearer $GITHUB_PERSONAL_ACCESS_TOKEN" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" "https://api.github.com/repos/martinjakubec/skyteam$1"; }
```

Run from the repository root:

```bash
git branch --show-current          # must be: main
git status --porcelain             # must be empty
git rev-parse HEAD                 # must equal origin's main:
gh_api /commits/main | python3 -c 'import json,sys; print(json.load(sys.stdin)["sha"])'
```

Stop and say why if any check fails (e.g. "HEAD isn't pushed yet"). Don't fix
it yourself (no stash, pull, push or checkout) unless the user asks.

## 2. Version

The last release is the highest `v*` tag by version, not by date. Take it from
the remote's tags (local tags may be stale), and make sure its commit is local:

```bash
LAST=$(gh_api '/tags?per_page=100' | python3 -c '
import json,re,sys
vs=[t["name"] for t in json.load(sys.stdin) if re.fullmatch(r"v\d+\.\d+\.\d+",t["name"])]
print(max(vs,key=lambda v:tuple(map(int,v[1:].split(".")))) if vs else "")')
git rev-parse -q --verify "$LAST^{commit}" || echo "tag $LAST missing locally"
git log --oneline "$LAST"..HEAD
```

If `$LAST` is missing locally, ask the user to run `git fetch --tags` in their
own terminal (Git Bash) and stop.

If there are no commits since `$LAST`, stop: there is nothing to release.

Next version from the argument: none → patch bump (`v0.1.3` → `v0.1.4`),
`minor` → `v0.2.0`, `major` → `v1.0.0`, an exact `vX.Y.Z` → that. Refuse a
version that isn't greater than `$LAST`, or a tag that already exists
(`gh_api "/git/ref/tags/$NEW"` must say `Not Found`).

## 3. Notes

One bullet per commit subject since `$LAST`, oldest first, then the compare link:

```bash
git log --reverse --format='- %s' "$LAST"..HEAD
```

```markdown
## What's changed

- ...

**Full changelog:** https://github.com/martinjakubec/skyteam/compare/<LAST>...<NEW>
```

## 4. Ask

Show the user, then STOP and wait for an explicit yes:

- the version (`$LAST` → `$NEW`) and the commit (`git rev-parse HEAD`, with its subject),
- the notes, exactly as they'll be published,
- "Publishing this deploys it to https://skyteam.mjakubec.eu."

If they ask for changes to the version or the notes, apply them and ask again.
Anything other than a clear yes is not a yes.

## 5. Publish

Build the JSON with python3 (no jq here) so the notes are escaped properly, and
pin the release to the exact SHA that was shown, not to `main`:

```bash
SHA=$(git rev-parse HEAD)
python3 -c 'import json,sys; print(json.dumps({"tag_name": sys.argv[1], "target_commitish": sys.argv[2], "name": sys.argv[1], "body": sys.stdin.read(), "draft": False, "prerelease": False, "make_latest": "true"}))' \
  "$NEW" "$SHA" < notes.md > release.json

curl -sS -w '\n%{http_code}\n' -X POST \
  -H "Authorization: Bearer $GITHUB_PERSONAL_ACCESS_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/repos/martinjakubec/skyteam/releases \
  --data @release.json
```

Write `notes.md` and `release.json` to the scratchpad directory, not the repo.
GitHub creates the tag on `$SHA` (only on GitHub; the user's next
`git fetch --tags` brings it locally).

The last line of the output is the HTTP status:

- **201**: published. Take `html_url` from the response.
- **401 / 403**: the token is missing, expired, or lacks Contents: write on this
  repo. Tell the user; don't retry.
- **422**: show GitHub's `message` / `errors` (usually: the tag already exists).
- Anything else: show the response.

Never retry a publish on your own. A failed request may still have created the
release, so check first (`get_release_by_tag` from the GitHub MCP server, or
`gh_api "/releases/tags/$NEW"`).

## 6. Report

- the release URL,
- the Deploy runs: https://github.com/martinjakubec/skyteam/actions/workflows/deploy.yml
  (the run tests, builds, deploys, then checks `/health`).
