# github-trending.yuanqi.blog

Daily-refreshed GitHub Trending dashboard. Static HTML, rebuilt every day at 12:00 Beijing
time by GitHub Actions, deployed on Vercel.

- **Period**: 滚动 7 天的每日榜 + 本周 + 本月 + 本年
- **本年** 数据来自 `github.com/search?created:>=YYYY-01-01 sort:stars`
- 所有英文描述自动翻译成中文(Gemini API)

## How it works

```
GitHub Actions (cron 04:00 UTC)
  └─ node scripts/build.mjs
       ├─ reads existing index.html → extract historical daily snapshots (≤6 days)
       ├─ fetches today's daily / weekly / monthly / yearly
       ├─ batches descriptions to Gemini for Chinese translation
       └─ writes new index.html
  └─ commit & push
        └─ Vercel auto-deploys
```

The page itself is **pure static HTML** — no client-side fetching, no JS framework.
Datasets are embedded as `<script type="application/json" id="trending-data-…">` blocks
that the page's small inline IIFE reads at startup.

## Setup (one-time)

### 1. Create the GitHub repo (private)

```bash
# In this directory
git init -b main
git add .
git commit -m "initial commit"
gh repo create yuanqi/github-trending-page --private --source=. --push
# (or create on github.com manually and push)
```

### 2. Add the Gemini API key as a repo secret

GitHub repo → Settings → Secrets and variables → Actions → New repository secret
- Name: `GEMINI_API_KEY`
- Value: your Gemini API key from https://aistudio.google.com/apikey

### 3. Run once locally to verify (optional but recommended)

```bash
npm install
GEMINI_API_KEY=sk-... node scripts/build.mjs
```

This regenerates `index.html`. Open it in a browser to confirm.

### 4. Deploy on Vercel

1. https://vercel.com/new → Import the GitHub repo
2. Framework Preset: **Other**
3. Build Command: leave default (we set `vercel.json` to no-op build)
4. Output Directory: `.` (set in `vercel.json`)
5. Click **Deploy**

After first deploy, in **Project → Settings → Domains**:
- Add `github-trending.yuanqi.blog`
- Vercel auto-provisions the CNAME because `yuanqi.blog`'s nameservers are already
  managed by Vercel (no manual DNS change needed)

### 5. Trigger the first scheduled refresh manually

Go to repo → Actions → "Daily refresh" → "Run workflow" to verify the cron job works
end-to-end before relying on the schedule. After this passes once, daily auto-runs
will Just Work.

## File map

```
index.html                          ← the static page (rewritten every day)
scripts/
  template.html                     ← HTML template with __DATASETS__ + __FETCHED_AT__
  build.mjs                         ← fetch + translate + render
.github/workflows/refresh.yml       ← GH Actions cron 04:00 UTC
package.json                        ← deps: @google/generative-ai
vercel.json                         ← static-only deploy config
```

## Updating

- **Tweak HTML/styling**: edit `scripts/template.html`. Next daily run will pick it up.
  (Or run `node scripts/build.mjs` locally and commit.)
- **Change translation rules**: edit the prompt inside `scripts/build.mjs`'s
  `translateBatch()`. Re-run the build.
- **Change cron time**: edit `.github/workflows/refresh.yml` cron expression
  (UTC; `0 4 * * *` is 12:00 Beijing).
- **Add new Period dataset**: extend `build.mjs` to fetch + emit a new
  `<script id="trending-data-XXX">` block; update `template.html`'s
  `buildPeriodOptions()` label map.

## Cost

- **Vercel**: free tier (well under bandwidth limits)
- **GitHub Actions**: free for public repos; 2,000 minutes/month free for private.
  Each run takes ~30s, so ~15 minutes/month — comfortably within free tier.
- **Gemini API**: ~70 short descriptions × ~150 tokens ≈ 11K tokens/day.
  At Gemini 2.0 Flash pricing (~$0.075/M input, $0.30/M output), well under $0.05/day.
