# The kaedendev fork

This fork is an upstream T3 Code release plus Jujutsu (jj) support and a Tangled integration. It has its own release channel, and its servers and desktop apps update only from `kaedendev/t3code`.

## What the fork carries

`kaeden/stable` is an upstream release tag on `pingdotgg/t3code` with a short stack of fork commits on top. The base is the latest stable tag (`vX.Y.Z`) unless the owner wants a feature that only a nightly has; then it is that nightly (`vX.Y.Z-nightly.DATE.N`), until a stable release catches up. List the stack with:

```sh
git log --oneline $(git describe --tags --abbrev=0 --match 'v[0-9]*' --exclude 'v*.*.1[0-9][0-9][0-9][0-9]' --exclude '*-preview.*' kaeden/stable)..kaeden/stable
```

The stack has three parts:

- **jj support.** It is a port of the community jj stack, upstream PRs #20749 to #20756, which upstream closed unmerged for lack of maintainer approval.
  - Colocated jj repos (`.jj` next to `.git`) use jj for checkpoints, diffs, status, workspaces, commit, push, and pull requests.
  - jj needs version 0.46.0 or newer on the server's `PATH`. When jj is missing, broken, or too old, the repo falls back to git and shows a notice.
- **Tangled.** [Tangled](https://tangled.org), the AT Protocol git forge, is a source control host like GitHub. See the Tangled section of `docs/user/source-control.md`.
  - The code is `packages/source-control-tangled`. It reads Tangled's public index at `api.tangled.org` and writes through the knot with service-auth tokens.
  - Sign-in is atproto OAuth through a relay Worker at `t3-oauth.kaeden.codes` (`infra/tangled-oauth`). The relay serves the client metadata, signs client assertions with the key in `~/.config/t3-tangled-oauth/signing-key.json` on the devbox, and holds each sign-in callback until the server polls for it. Deploy it with `T3_TANGLED_OAUTH_SIGNING_KEY="$(cat ~/.config/t3-tangled-oauth/signing-key.json)" pnpm exec alchemy deploy --stage prod` from `infra/tangled-oauth`. Losing the key means generating a new one and signing in again.
  - The relay signs assertions and hands out callbacks without checking the caller. Sessions stay safe, since the PKCE verifier and DPoP key never leave the T3 server, but anyone could run a sign-in under the "T3 Code" client name, and a PDS that blocked that client would block T3's Tangled writes. Closing that needs a shared secret on the relay's assertion and callback routes, and the same secret in every T3 server's settings.
  - Pull requests have rounds. Pushing a branch with an open Tangled pull request submits a new round, and the review picker shows each round and what changed since an earlier one. The rounds picker works with any host that reports rounds.
- **Release plumbing.**
  - `CLI_RELEASE_REPOSITORY` points at this fork.
  - `.github/workflows/fork-release.yml` builds releases.
  - `scripts/fork-release-version.ts` numbers them.
  - `scripts/fork-testflight.sh` builds the iOS app and uploads it to TestFlight.

The fork also ships its own iOS app through TestFlight; see [Mobile app](#mobile-app). The App Store app still works against a fork server. It shows Git wording for jj repos, and it has no Tangled sign-in, round picker or Resubmit action; sign in to Tangled from web or desktop, and the server keeps the session for every client.

## Working in the fork

These trip up agents that follow upstream's habits:

- **Base branch.** Open PRs against `kaeden/stable` on `kaedendev/t3code`. In T3 worktrees that repository is the `origin` remote; the rebase steps below call it `fork`. Never open PRs on `pingdotgg/t3code`.
- **CI never finishes.** Most jobs run on Blacksmith runners, which the fork doesn't have, so they stay queued forever. "Agent context budget" fails because it measures against upstream `main`. Run `vp run check:changed origin/kaeden/stable` and the affected tests locally instead. Merge with `gh pr merge --squash --admin` and cancel the queued runs. Without the base argument, `check:changed` diffs against upstream and fails with `spawn E2BIG`.
- **Upstream-only workflows.** The `Mobile EAS *` workflows and `release.yml` are gated on `pingdotgg/t3code` and never run here. EAS builds go to upstream's Expo project and Apple team, so don't use `eas build` or `eas submit` for the fork.
- **Tools off `PATH`.** Agent shells may not load a login profile. `vp` lives in `~/.vite-plus/bin`. This Mac has no CocoaPods or Homebrew, so run anything that needs `pod`, such as `vp run mobile:install` after a native change, inside `nix shell nixpkgs#cocoapods -c …`.

## T3 Connect

Fork builds use upstream's production relay (`relay.t3.codes`) and Clerk app, so a fork machine links to the same T3 Connect account as upstream machines. `fork-release.yml` holds the four public values upstream bakes into its builds. Upstream can rotate them; if linking breaks after an upstream release, read them from that release's `t3` binary (`buildTimeRelayUrl`, `buildTimeClerkPublishableKey`, `buildTimeClerkCliOAuthClientId`, and the `clerkJwtTemplate` in its client bundle). Builds made before this change have Connect turned off and need a reinstall. Relay tracing stays off in fork builds.

An agent signing in on a machine's T3 Connect address is approved on the hosted app's `/approve-agent` page. Upstream sends stable builds to `app.t3.codes`, which lacks that page until a stable release ships it, and fork builds count as stable. `agentApprovalAppUrlConfig` in `apps/server/src/cloud/publicConfig.ts` therefore always uses `nightly.app.t3.codes`. `T3CODE_HOSTED_APP_URL` on a server still overrides it.

## Known limits of jj support

- A stale workspace is reported, not repaired. If you rewrite a thread's change from another workspace, T3 shows "workspace is stale". Run `jj workspace update-stale` in that workspace yourself.
- Push rewrites a published bookmark only with newer versions of its own changes, after an amend, squash, describe or rebase under it; the button then reads "Push rewrite". It refuses when the remote holds anything else, such as someone else's commits or a change dropped from the stack, or when the remote moved since jj last fetched. To overwrite on purpose, run `jj git push` from a terminal.
- T3's status refresh snapshots the working copy. If a refresh lands while a `jj commit` or `jj describe` runs, that command can fail with "Concurrent checkout". The result is a divergent change; files on disk stay intact.

## Version numbers

A fork build of upstream `X.Y.P`, respin `N`, is `X.Y.(10000 + 100·P + N)`. For example, upstream 0.1.6 respin 1 is `0.1.10601`. On a nightly base, `P` is the newest stable tag in the branch's history, so a build on a 0.1.8 nightly is numbered as a 0.1.7 respin.

Fork versions sort above every upstream release on the same minor version. Clients therefore never offer an upstream release as an update. To return a machine to upstream, run `t3 update --allow-downgrade`.

## Cut a release

1. Run a draft build:
   ```sh
   gh workflow run fork-release.yml --repo kaedendev/t3code --ref kaeden/stable
   ```
2. Check the run's **Verify macOS signature** summary. It must show `Gatekeeper: Notarized Developer ID` and no problems. A publish run fails on any problem.
3. Publish it:
   ```sh
   gh workflow run fork-release.yml --repo kaedendev/t3code --ref kaeden/stable -f publish=true
   ```

These builds cover the CLI and desktop app only. Ship the iOS app separately; see [Mobile app](#mobile-app).

After a release is published, **Update everything** in a fork client moves the fleet. `t3 update` on a server also installs it. Desktop apps update themselves.

## Mobile app

The fork's iOS app is signed by Kaeden's team (`28AUT7GBK3`) as `com.kaedenmurphy.t3code` and distributed through TestFlight. The app config uses that team and bundle ID only when `T3CODE_IOS_TEAM_ID` and `T3CODE_IOS_BUNDLE_ID` are set. Without them, dev and preview builds keep upstream's identifiers, so don't put either variable in `.env` or `.env.local`.

To ship a TestFlight build, merge to `kaeden/stable`, then run this from a clean checkout of it on the Mac:

```sh
scripts/fork-testflight.sh
```

It sets the signing and T3 Connect values, runs a clean prebuild with CocoaPods from Nix, archives with automatic signing through the Apple account signed into Xcode, and uploads with a timestamp build number. It takes about 10 minutes, and Apple then needs 5 to 30 minutes to process the build. It prints its log path; on failure it shows the last errors.

- The first archive after a new Swift package can stop at "Resolving packages" with no CPU use. SwiftPM is waiting on a macOS keychain prompt for github.com credentials. Click **Always Allow** on the Mac.
- There's no Android release for the fork.
- The fork publishes no OTA updates, so JS changes reach phones only through a new TestFlight build.

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

## Rebase onto a new upstream release

An agent can run these steps unattended. Every gate must pass before anything ships.

1. Find the target. The newest stable is `gh release view --repo pingdotgg/t3code --json tagName -q .tagName`. For a nightly, take the newest `v*-nightly.*` tag that contains the wanted commits (`git merge-base --is-ancestor <commit> <tag>`). Call it `NEW`.
2. Find the current base: `OLD=$(git describe --tags --abbrev=0 --match 'v[0-9]*' --exclude 'v*.*.1[0-9][0-9][0-9][0-9]' --exclude '*-preview.*' fork/kaeden/stable)`. If `NEW` equals `OLD`, stop.
3. Create a worktree next to the others. Base a branch `kaeden/stable-$NEW` on `fork/kaeden/stable`, then run `git rebase --onto $NEW $OLD`.
4. Resolve each conflict so both upstream's change and the fork's intent survive. Never revert upstream work to make a hunk apply. Each commit must typecheck on its own.
5. Find git calls that upstream added between `OLD` and `NEW` in `apps/server/src`, and route them by VCS kind. Record any you leave for later.
   - If `NEW` is a stable tag that contains `apps/web/src/routes/approve-agent.tsx` (`app.t3.codes` serves stable), restore upstream's `agentApprovalAppUrlConfig` default and remove the paragraph about it under [T3 Connect](#t3-connect).
6. Run the gates. All must pass:
   - `vp run check:changed $NEW`
   - `vp test run apps/server/src/jj apps/server/src/vcs apps/server/src/checkpointing apps/server/src/git apps/server/src/pullRequest packages/source-control-tangled infra/tangled-oauth scripts/fork-release-version.test.ts`
7. Push `kaeden/stable-$NEW` to `fork`. Run a draft build from that branch with `--ref kaeden/stable-$NEW`.
8. Report to the owner: the new base, the conflicts and how each was resolved, the gate results, and the draft release.
9. When the owner approves, force-move `kaeden/stable` to the new branch and publish a build from `kaeden/stable`.
