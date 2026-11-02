# The kaedendev jj fork

This fork is T3 Code's latest upstream **stable** release plus Jujutsu (jj) support. It has its own release channel, and its servers and desktop apps update only from `kaedendev/t3code`.

## What the fork carries

`jj/stable` is an upstream stable tag (`vX.Y.Z` on `pingdotgg/t3code`) with a short stack of fork commits on top. List the stack with:

```sh
git log --oneline $(git describe --tags --abbrev=0 --match 'v[0-9]*' --exclude '*-*' jj/stable)..jj/stable
```

The stack has two parts:

- **jj support.** It is a port of the community jj stack, upstream PRs #20749 to #20756, which upstream closed unmerged for lack of maintainer approval.
  - Colocated jj repos (`.jj` next to `.git`) use jj for checkpoints, diffs, status, workspaces, commit, push, and pull requests.
  - jj needs version 0.46.0 or newer on the server's `PATH`. When jj is missing, broken, or too old, the repo falls back to git and shows a notice.
- **Release plumbing.**
  - `CLI_RELEASE_REPOSITORY` points at this fork.
  - `.github/workflows/fork-release.yml` builds releases.
  - `scripts/fork-release-version.ts` numbers them.

Mobile code is unchanged. The App Store app works against a fork server and shows Git wording for jj repos.

## Known limits of jj support

- A stale workspace is reported, not repaired. If you rewrite a thread's change from another workspace, T3 shows "workspace is stale". Run `jj workspace update-stale` in that workspace yourself.
- Push refuses to rewrite a published bookmark, as git's push does. To overwrite on purpose, run `jj git push` from a terminal.
- T3's status refresh snapshots the working copy. If a refresh lands while a `jj commit` or `jj describe` runs, that command can fail with "Concurrent checkout". The result is a divergent change; files on disk stay intact.

## Version numbers

A fork build of upstream `X.Y.P`, respin `N`, is `X.Y.(10000 + 100·P + N)`. For example, upstream 0.1.6 respin 1 is `0.1.10601`.

Fork versions sort above every upstream release on the same minor version. Clients therefore never offer an upstream release as an update. To return a machine to upstream, run `t3 update --allow-downgrade`.

## Cut a release

1. Run a draft build:
   ```sh
   gh workflow run fork-release.yml --repo kaedendev/t3code --ref jj/stable
   ```
2. Check the run's **Verify macOS signature** summary. It must show `Gatekeeper: Notarized Developer ID` and no problems. A publish run fails on any problem.
3. Publish it:
   ```sh
   gh workflow run fork-release.yml --repo kaedendev/t3code --ref jj/stable -f publish=true
   ```

After a release is published, **Update everything** in a fork client moves the fleet. `t3 update` on a server also installs it. Desktop apps update themselves.

## macOS signing

The workflow signs the Mac app and the macOS CLI with the Developer ID Application identity in the `CSC_LINK` and `CSC_KEY_PASSWORD` repository secrets. It notarizes both with the App Store Connect API key in `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`.

The app carries no passkey entitlements, because Apple grants those only to T3's own team. Passkeys in the in-app browser therefore don't work in the fork.

macOS installs an update only when it satisfies the running app's designated requirement. For Developer ID that requirement is the team, so a renewed certificate from the same team is fine. Moving to another team means one manual reinstall on every Mac.

## Move a machine onto the fork

Do this once per machine. After that, updates come from the fork.

- **Linux or macOS background service:**
  ```sh
  T3CODE_RELEASE_BASE_URL=https://github.com/kaedendev/t3code/releases/download t3 update <fork-version>
  ```
- **Mac desktop app:**
  1. Quit T3 Code.
  2. Download the `.dmg` from the release and drag the app into **Applications**, replacing `T3 Code (Beta).app`.
  3. On first launch, macOS may ask to let T3 Code use its "Safe Storage" keychain item, because the app's signer changed. Enter your password and choose **Always Allow**.

  Threads and settings in `~/.t3` carry over.

## Rebase onto a new upstream stable

An agent can run these steps unattended. Every gate must pass before anything ships.

1. Find the newest upstream stable: `gh release view --repo pingdotgg/t3code --json tagName -q .tagName`. Call it `NEW`.
2. Find the current base: `OLD=$(git describe --tags --abbrev=0 --match 'v[0-9]*' --exclude '*-*' fork/jj/stable)`. If `NEW` equals `OLD`, stop.
3. Create a worktree next to the others. Base a branch `jj/stable-$NEW` on `fork/jj/stable`, then run `git rebase --onto $NEW $OLD`.
4. Resolve each conflict so both upstream's change and the fork's intent survive. Never revert upstream work to make a hunk apply. Each commit must typecheck on its own.
5. Find git calls that upstream added between `OLD` and `NEW` in `apps/server/src`, and route them by VCS kind. Record any you leave for later.
6. Run the gates. All must pass:
   - `vp run check:changed $NEW`
   - `vp test run apps/server/src/jj apps/server/src/vcs apps/server/src/checkpointing apps/server/src/git scripts/fork-release-version.test.ts`
7. Push `jj/stable-$NEW` to `fork`. Run a draft build from that branch with `--ref jj/stable-$NEW`.
8. Report to the owner: the new base, the conflicts and how each was resolved, the gate results, and the draft release.
9. When the owner approves, force-move `jj/stable` to the new branch and publish a build from `jj/stable`.
