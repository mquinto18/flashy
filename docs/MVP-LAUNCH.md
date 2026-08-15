# Flashy — MVP launch plan

Three parts: what has to be true before you publish, how people will actually use the
app, and how the paid feature gets sold and enforced.

For build and run instructions see [`../README.md`](../README.md).

---

## Part 1 — Before you publish

### Blockers

Neither of these is optional. Everything else on this page is wasted effort until both
are done.

**1. Sign and notarize the app.**

Right now `spctl` rejects the build outright:

```
src-tauri/target/release/bundle/macos/Flashy.app: rejected
source=no usable signature
```

An unsigned app shows *"Flashy cannot be opened because the developer cannot be
verified"* and the user has to right-click → Open, or run `xattr` from a terminal. Most
people stop there and never see the product.

- Apple Developer Program — $99/yr
- Set `bundle.macOS.signingIdentity` in `src-tauri/tauri.conf.json`, then notarize
- Windows: unsigned installers trigger SmartScreen. Less fatal, still costs installs.

**2. Prove auto-close actually works.**

It force-quits applications and has never been run end-to-end against real apps. The
failure mode is someone's unsaved work, not a cosmetic glitch.

- [ ] Run the dry-run **Preview** on a real category. Confirm every listed process is
      something you actually opened, and that Finder, Dock, WindowServer and Flashy
      itself all appear as spared.
- [ ] Let one real auto-close fire on throwaway apps. Confirm it closes what you expect
      and nothing else.
- [ ] Test the Cancel button during the 60-second warning.
- [ ] Close the lid past a scheduled time, reopen — confirm it reports "missed" rather
      than closing an hour late.

### Decide before shipping: Mac App Store or not

`macOSPrivateApi` is currently enabled so the warning overlay can be transparent with
rounded corners. **This makes the app ineligible for the Mac App Store**, which is a real
discovery channel for a paid utility.

It is reversible — revert the overlay to an opaque panel and you qualify again. Worth
deciding deliberately rather than inheriting it from a styling choice.

| | Direct distribution | Mac App Store |
|---|---|---|
| Cut | ~5% (payment vendor) | 15–30% |
| Discovery | you do all of it | built-in |
| Glass overlay | ✅ | ❌ must revert |
| Licensing | you build it | Apple handles it |

### Launch checklist

- [ ] Signed + notarized build
- [ ] Auto-close verified (above)
- [ ] Landing page: what it does, a demo GIF, download link, price/free split stated
- [ ] Decide and **state publicly** what will become paid (see Part 3)
- [ ] Pick one platform to launch on. Shipping Mac and Windows at once doubles support
      before you know anyone wants it.
- [ ] Distribution: Product Hunt, r/macapps, Hacker News "Show HN"

Expect to spend more time on the landing page and launch posts than you did building.
That is normal and not a sign anything went wrong.

---

## Part 2 — How people use Flashy

This doubles as the basis for your help page and landing-page copy.

### The idea

You group the things you use together — apps, websites, files, folders — into a
**category**. One click opens all of them. Optionally, they all close again at a time you
set.

*"Open everything I need for work at 9, close it all at 6."*

### First run

1. Open Flashy → **Get started**
2. Type a name under **New category** (e.g. `Work`) → **+**

### Adding items

Three ways, all landing in the same place:

| Method | How |
|---|---|
| Drag and drop | Drag a file, folder or app onto the window |
| Paste | Type or paste a URL or path into the quick-add box → **Add** |
| Browse | Folder icon → pick a file, folder or application |

Flashy detects the type automatically — `.app` and `.exe` become applications,
`example.com` becomes a website, anything else is a file or folder.

### Launching

Click **Launch \<category\>**. Items open ~100ms apart so nothing gets overwhelmed.
Applications already running are skipped rather than opened twice — a green dot marks
what's currently running.

### Setting an auto-close time

1. Click the **clock icon** next to the category name
2. Pick `+1h`, `+2h`, `+4h`, or a custom time
3. **Save**

The time is stored on the category and reused on every launch. A clock icon appears in
the category list — tinted when a close is actually scheduled, muted when a time is set
but nothing is running yet.

**The timer starts when you launch, not when you set the time.** And Flashy has to stay
open for it to fire.

### What happens at closing time

60 seconds before, a floating panel appears above whatever you're doing, with a border
that drains as the deadline approaches:

- **Cancel** — calls the whole thing off
- **Close now** — skips the remaining wait

Then everything that category opened is closed: asked politely first, force-closed if it
doesn't respond within 5 seconds.

If you're in fullscreen and macOS won't let the panel through, you get a system
notification instead — click it to bring Flashy forward and cancel.

### Previewing what will close

Because this force-quits applications, there's a dry run. After launching a category,
open the clock modal and press **Preview**. It lists exactly what *would* close and what
would be spared, without touching anything.

**Worth doing once before you trust a schedule with real work.**

### Limitations to tell users about honestly

- Some apps (Preview, TextEdit) close without prompting to save. Chrome, Firefox and
  Electron apps shut down cleanly.
- Flashy must stay running for a schedule to fire.
- Apps that take more than ~10 seconds to appear may not be tracked.
- If a browser was already open before you launched, closing the category closes it and
  all its tabs — only when that category contains website items.

---

## Part 3 — The paid feature

### What's free, what's paid

| | |
|---|---|
| **Free, permanently** | Categories, adding items, launching apps/sites/files |
| **Paid** | Scheduled auto-close |

The launcher is commoditized — Raycast, Shortcuts and Workspaces all do it, mostly free.
Charging for it just loses you the install. Scheduled auto-close is the genuinely
uncommon part, and it's what makes Flashy a *work-life boundary* tool rather than another
launcher.

### Say the paywall out loud, now

The biggest own-goal available here is shipping everything free and paywalling
auto-close later. The people who'd have advocated for you are exactly the ones who feel
cheated. Put this on the landing page from day one:

> Launching is free, forever. Scheduled auto-close is free during beta and will become a
> paid feature.

That single sentence buys goodwill *and* pre-frames the paywall as expected.

### Current state: hidden

Auto-close is behind `AUTO_CLOSE_ENABLED` (`src/lib/features.ts`, mirrored in
`src-tauri/src/proc/overlay.rs`) and **off**. The MVP ships as a launcher only. The code
is complete and committed — this is a flag, not a deletion.

Turn it on once the verification in Part 1 is done, and ship it as a free beta first.

### Then: free beta, before charging

It solves a real problem: the feature is destructive and unproven, you need real users
exercising it, and you can't honestly charge for it yet. Beta framing gets you testing,
sets expectations that it's rough, and establishes that it will cost money at 1.0.

The signal to watch: **do people still use scheduling in week two?** That, and nothing
else, is your pricing thesis.

### Taking the money

The important distinction is **merchant of record** (handles VAT/sales tax worldwide) vs
plain payment processor (you handle it).

| | Cut | Tax | Notes |
|---|---|---|---|
| **Lemon Squeezy** | ~5% + 50¢ | ✅ MoR | Built-in license-key API — least work |
| **Paddle** | ~5% + 50¢ | ✅ MoR | Long-standing Mac indie favourite |
| **Gumroad** | ~10% | ✅ MoR | Simplest, priciest |
| **Stripe** | ~2.9% + 30¢ | ❌ yours | Cheapest, tax compliance is your problem |

**Recommended: Lemon Squeezy**, specifically because its license API means one vendor
covers both payment and licensing.

Pricing: **$15–25 one-time**. Subscription isn't justified — there's no server and no
recurring cost. A 14-day full-featured trial with no card is the norm for Mac utilities,
and fits a tool whose value only shows after a few workdays.

### How licensing works

1. User buys → vendor emails a license key
2. App shows an **Activate** screen → user pastes the key
3. App calls the vendor's validate endpoint
4. Valid → store the activation locally, next to `workspaces.json` in app data
5. Re-validate weekly, with a long offline grace period

### Implementing it in Flashy

- Add `reqwest` to `src-tauri/Cargo.toml`
- New Rust command `activate_license(key)` → POST to the vendor → persist result
- New Rust command `license_status()` → cached state for the UI
- Gate **both** sides:
  - UI: hide the clock button and the close-time modal without a license
  - Rust: `arm_auto_close` refuses without one — otherwise the gate is bypassed by
    poking the frontend
- Activation screen in `src/pages/`

Roughly a day's work. It's vendor-agnostic up to a single HTTP call.

### Two rules

**Fail open.** If the license server is unreachable, keep working. Locking out a paying
customer during a vendor outage does far more damage than a few days of unlicensed use.

**Don't build DRM.** You cannot stop a determined pirate in a client-side desktop app —
the binary can always be patched. Make paying easier than not paying, then stop. Every
hour past a basic key check is an hour not spent on marketing, which is the thing that
actually decides whether this makes money.

---

## Suggested order

1. Verify auto-close (dry run, then a real close)
2. Sign + notarize
3. Landing page with the free/paid split stated
4. Ship free on Mac — launcher free, auto-close as free beta
5. Get ~50 users, watch week-two scheduling retention
6. If the signal is there, add licensing and turn on the paywall at 1.0

Don't charge before step 5. Selling an unverified destructive feature invites refunds and
a bad first review, and first reviews are hard to undo.
