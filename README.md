# webinar-push

Single-purpose webinar outreach bot. Built specifically to drive registrations to one LinkedIn event:

- **Event:** SBOM Analysis and Protocol Fuzzing Covering the Full Attack Surface
- **Host:** Apona Security via Carahsoft
- **When:** Tue May 12 2026, 10:00 AM ET
- **LinkedIn event:** `7455003189491183616`
- **Registration:** carahevents.carahsoft.com link (in `settings/config.event.registrationUrl`)

This is a standalone Firebase project — separate from `AISDRLabradorLabs`.

## Architecture

```
functions/src/
├── index.ts                      # HTTP endpoints + scheduled tick
├── types.ts
└── services/
    ├── connectsafely.ts          # ConnectSafely.ai LinkedIn API client
    ├── inmail-quota.ts           # 5/day/account InMail cap (atomic)
    ├── safety.ts                 # Multi-account capacity, warm-up, pause
    ├── anthropic.ts              # Personalized copy generation + scoring
    ├── prospects.ts              # Sourcing: searchPeopleV2 + company followers
    ├── personalize.ts            # Generate copy, score, route channel
    ├── sender.ts                 # Channel router (DM / connect / InMail / email)
    ├── scheduler.ts              # T-3 / T-1 / T-0 follow-ups + reply poll
    └── gmail.ts                  # Email channel (optional, with .ics)
```

### Channel routing

| Prospect | Channel |
|---|---|
| 1st-degree | LinkedIn DM (with profile-view warm-up + typing delay) |
| 2nd-degree | Connection request, 280-char personalized note, event CTA |
| 3rd+ AND premium | LinkedIn InMail (Sales Nav, 5/day/account cap) |
| 3rd+ AND has email | Email with .ics calendar invite |
| 3rd+ no email no premium | Connection request (lower priority) |

Every send distributes across all enabled `linkedinAccounts` based on per-account remaining quota for that channel.

### Follow-up cadence

- **T-3 days** — nudge to non-responders (status `sent`)
- **T-1 day** — reminder
- **T-0 (~3h before)** — final nudge with direct join link

Reply detection runs on every tick: any inbound message from a known prospect flips them to `replied` and removes them from the follow-up pool. Tracking-link clicks flip to `registered`.

## Setup (separate Firebase project)

### 1. Prereqs

- Node 20
- Firebase CLI: `npm i -g firebase-tools`
- A NEW Firebase project (Blaze plan, do not reuse `aisdr-2cb64`)
- ConnectSafely.ai account + API bearer token (Pro $39/mo or Agency)
- Anthropic API key
- LinkedIn accounts already linked inside ConnectSafely (one or many)

### 2. Configure the project ID

Edit `.firebaserc`:

```json
{
  "projects": {
    "default": "your-new-firebase-project-id"
  }
}
```

### 3. Install + build

```bash
cd functions
npm install
npm run build
cd ..
firebase login
firebase use --add
```

### 4. Deploy Firestore rules and indexes

```bash
firebase deploy --only firestore
```

### 5. Deploy functions

```bash
firebase deploy --only functions
```

This prints function URLs. Copy the base URL — you'll use it below.

### 6. Seed the configuration

The bot has no seed UI; you run the `seed` HTTP endpoint once. Before that, set an admin key as an environment variable so the endpoints aren't open:

```bash
firebase functions:config:set admin.key="$(openssl rand -hex 32)"
# OR set as a function env var via Cloud Console
```

Then call seed:

```bash
ADMIN_KEY=<your admin key>
BASE=https://us-central1-<your-project>.cloudfunctions.net

curl -X POST "$BASE/seed" -H "X-Admin-Key: $ADMIN_KEY"
```

This writes default event metadata + ICP. Override anything in the Firestore console at `settings/config`.

### 7. Add API keys + LinkedIn accounts

In the Firebase Console → Firestore → `settings/config`, set:

```
connectSafelyApiKey: "<your CS bearer token>"
anthropicApiKey:     "<your Anthropic key>"
linkedinAccounts: [
  { id: "acct1", connectSafelyAccountId: "<CS account id 1>", enabled: true, label: "Founder seat" },
  { id: "acct2", connectSafelyAccountId: "<CS account id 2>", enabled: true, label: "AE 1" },
  ...
]
mode: "sandbox"   // keep sandbox until you verify the drafts look right
```

Test the keys:

```bash
curl -X POST "$BASE/testKeys" -H "X-Admin-Key: $ADMIN_KEY"
```

### 8. Tune ICP

Edit `settings/config.icp` directly in Firestore. Fields:

```
jobTitles:     ["AppSec Engineer", "DevSecOps", ...]
industries:    ["Computer Software", "Defense", ...]
companies:     ["Specific target accounts"]
followerOf:    ["snyk", "veracode", "anchore", "blackducksoftware", "apona-security"]
locations:     ["United States"]
connectionDegree: ["1st", "2nd", "3rd+"]
premiumOnly:   false
```

`followerOf` accepts LinkedIn company URN/slug or numeric ID. Confirm each one resolves before sourcing.

### 9. Run the push

Three modes:

**Manual stepwise (recommended for first run):**

```bash
# 1. Pull prospects
curl -X POST "$BASE/source" -H "X-Admin-Key: $ADMIN_KEY"

# 2. Generate personalized copy + score (sandbox safe)
curl -X POST "$BASE/personalize" -H "X-Admin-Key: $ADMIN_KEY" -d '{"batchSize":50}'

# 3. Inspect drafts in Firestore. Spot-check 5-10 prospects' connectNote / dmBody.

# 4. When happy, flip to live
# Set settings/config.mode = "live" in Firestore console

# 5. Drain the queue
curl -X POST "$BASE/queue"   -H "X-Admin-Key: $ADMIN_KEY"
curl -X POST "$BASE/sendNow" -H "X-Admin-Key: $ADMIN_KEY" -d '{"batchSize":30}'
```

**Automatic:** the `tick` cron runs every 30 minutes. It personalizes a slice, auto-queues, sends as much as capacity allows, fires due follow-ups, and polls replies. To go live, just set `mode: "live"` in `settings/config`.

**Pause kill-switch:**

```bash
curl -X POST "$BASE/pause"  -H "X-Admin-Key: $ADMIN_KEY"
curl -X POST "$BASE/resume" -H "X-Admin-Key: $ADMIN_KEY"
```

The bot also auto-pauses LinkedIn-only on rate-limit / restriction signals from ConnectSafely.

### 10. Watch it run

```bash
curl "$BASE/stats" -H "X-Admin-Key: $ADMIN_KEY"
```

Returns:

```json
{
  "counts": { "sourced": 312, "drafted": 48, "queued": 12, "sent": 89, ... },
  "capacityRemainingToday": { "dm": 110, "connect": 47, "inmail": 18, "total": 175 },
  "paused": { "paused": false },
  "mode": "live"
}
```

Activity log lives in `activity_log` collection (everything that happens), and every individual send is in `sends`.

## Channel + rate-limit reference

| Channel | Per-account/day | Mechanism |
|---|---|---|
| LinkedIn DM | ~25 (warm-up ramp applies) | `/messaging/send` via ConnectSafely |
| Connection request | ~13 (90/week) | `/connect` with 280-char note |
| InMail | 5 (Sales Nav cap) | Atomic Firestore reservation |
| Email | unlimited | Gmail OAuth (optional, off by default) |

Total daily ceiling = (number of accounts) × (per-account/day per channel).

## Tracking

Every prospect gets a unique `trackingToken`. Email + InMail bodies use `${BASE_URL}/track?token=${trackingToken}` instead of the raw registration URL. A click flips the prospect to `registered`. LinkedIn DMs use the raw URL because LinkedIn strips redirects in DMs.

## Safety notes

- ConnectSafely operates LinkedIn via headless sessions; **automated mass invites violate LinkedIn TOS**. Restriction/ban risk is non-zero. The warm-up ramp + per-account caps + jitter + reply detection are the standard mitigations, not guarantees.
- The bot **does not** click "Invite to event" on the LinkedIn event page itself — that endpoint isn't exposed by ConnectSafely or any other API. We drive registrations via DM/connect/InMail/email containing the event link.
- Default mode is `sandbox`. Drafts are written, no sends fire. Flip to `live` only after spot-check.

## Cost estimate (push of ~1000 prospects over 7 days)

| Item | Approx cost |
|---|---|
| ConnectSafely (Pro) | $39/mo |
| Anthropic (Sonnet, ~1k personalizations + scoring) | $15-30 |
| Firebase Blaze (functions + firestore) | < $5 |
| **Total for one push** | **~$60-75** |

## Branch / PR

This repo is developed on `claude/research-webinar-bot-events-rqLrE`. Push when ready for review.
