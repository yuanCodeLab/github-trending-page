// Build script for github-trending.yuanqi.blog
// Runs daily in GitHub Actions:
//   1. Reads existing index.html, extracts historical daily snapshots (≤ 6 days old)
//   2. Fetches today's daily / weekly / monthly trending + this-year top from github.com
//   3. Translates English descriptions to Chinese via Gemini API (batched)
//   4. Renders new index.html from scripts/template.html with all datasets embedded
//
// Required env: GEMINI_API_KEY
// Optional env:
//   GEMINI_MODEL         (default: gemini-2.5-flash-lite)
//   GEMINI_BASE_URL      (default: https://generativelanguage.googleapis.com — set this to point at a proxy)
//   GEMINI_API_VERSION   (default: v1beta)

import { GoogleGenerativeAI } from '@google/generative-ai';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const INDEX_PATH = path.join(ROOT, 'index.html');
const TEMPLATE_PATH = path.join(__dirname, 'template.html');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const HISTORY_DAYS = 6; // keep up to 6 days of historical daily snapshots (today + 6 = 7 total)

// ---------- helpers ----------

const stripTags = (s) => (s || '').replace(/<[^>]+>/g, '');

const decodeEntities = (s) =>
  (s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));

const cleanText = (s) => decodeEntities(stripTags(s)).replace(/\s+/g, ' ').trim();

const parseInt0 = (s) => {
  const m = String(s ?? '').replace(/[^\d]/g, '');
  return m ? parseInt(m, 10) : 0;
};

async function fetchText(url, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (r.status === 429) {
        const retryAfter = parseInt(r.headers.get('retry-after') || '0', 10);
        const waitSec = Math.max(retryAfter, 30 * (i + 1));
        console.log(`  429 rate-limited on ${url}, waiting ${waitSec}s`);
        await new Promise((res) => setTimeout(res, waitSec * 1000));
        lastErr = new Error('HTTP 429');
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      // GitHub sometimes returns 200 with a "Too many requests" page body.
      // Detect this and treat as rate-limit.
      if (text.length < 20000 && /Too many requests/i.test(text)) {
        const waitSec = 30 * (i + 1);
        console.log(`  body-level rate-limit on ${url}, waiting ${waitSec}s`);
        await new Promise((res) => setTimeout(res, waitSec * 1000));
        lastErr = new Error('Body says "Too many requests"');
        continue;
      }
      return text;
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((res) => setTimeout(res, 2000 * (i + 1)));
    }
  }
  throw new Error(`fetch ${url} failed after ${attempts} attempts: ${lastErr?.message || lastErr}`);
}

// Pacing helper: serialise yearly search-page fetches with a short delay.
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ---------- parsers ----------

function parseTrendingHTML(html) {
  const articles = [...html.matchAll(/<article class="Box-row">([\s\S]*?)<\/article>/g)];
  const repos = [];
  for (const [, a] of articles) {
    const hrefM = a.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"/);
    if (!hrefM) continue;
    const parts = hrefM[1].replace(/^\//, '').split('/');
    if (parts.length < 2) continue;
    const [owner, repo] = parts;

    const descM = a.match(/<p[^>]*class="col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    const langM = a.match(/itemprop="programmingLanguage"[^>]*>([^<]+)</);
    const colorM = a.match(/class="repo-language-color"[^>]*style="background-color:\s*([^";]+)/);
    const starsM = a.match(/href="[^"]+\/stargazers"[^>]*>([\s\S]*?)<\/a>/);
    const forksM = a.match(/href="[^"]+\/forks"[^>]*>([\s\S]*?)<\/a>/);
    const todayM = a.match(/float-sm-right[^"]*"[^>]*>([\s\S]*?)<\/span>/);

    repos.push({
      owner,
      repo,
      url: `https://github.com/${owner}/${repo}`,
      desc: descM ? cleanText(descM[1]) : '',
      lang: langM ? langM[1].trim() : '',
      langColor: colorM ? colorM[1].trim() : '',
      stars: parseInt0(starsM ? cleanText(starsM[1]) : ''),
      forks: parseInt0(forksM ? cleanText(forksM[1]) : ''),
      today: todayM ? cleanText(todayM[1]) : '',
    });
  }
  return { repos, count: repos.length };
}

function parseSearchPayload(html) {
  const m = html.match(
    /<script[^>]+data-target="react-app\.embeddedData"[^>]*>([\s\S]+?)<\/script>/
  );
  if (!m) return { repos: [], count: 0 };
  let data;
  try {
    data = JSON.parse(decodeEntities(m[1]));
  } catch {
    return { repos: [], count: 0 };
  }
  const results = data?.payload?.results || [];
  const repos = [];
  for (const r of results) {
    const name = cleanText(r.hl_name || '');
    if (!name.includes('/')) continue;
    const [owner, repo] = name.split('/');
    repos.push({
      owner,
      repo,
      url: `https://github.com/${owner}/${repo}`,
      desc: cleanText(r.hl_trunc_description || ''),
      lang: r.language || '',
      langColor: r.color || '',
      stars: parseInt(r.followers || 0, 10),
      forks: 0,
      today: '',
    });
  }
  return { repos, count: repos.length };
}

// ---------- gemini translation ----------

async function translateBatch(descs, apiKey, modelName) {
  if (!descs.length) return {};
  const genAI = new GoogleGenerativeAI(apiKey);
  // Allow pointing at a proxy / alternate endpoint via env. Empty / unset → SDK defaults
  // (https://generativelanguage.googleapis.com + v1beta).
  const requestOptions = {};
  if (process.env.GEMINI_BASE_URL) requestOptions.baseUrl = process.env.GEMINI_BASE_URL;
  if (process.env.GEMINI_API_VERSION) requestOptions.apiVersion = process.env.GEMINI_API_VERSION;
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.4,
    },
  }, requestOptions);

  const prompt = [
    '把下面 JSON 数组里每个英文 GitHub 仓库描述翻译成中文。要求:',
    '- 流畅自然中文,避免明显的机翻味',
    '- 技术术语保留英文(RAG, MCP, API, SDK, CLI, LLM, OAuth, GraphQL, Embedding 等)',
    '- 项目名 / 产品名 / 人名保留英文(Suno, Discord, Claude, Codex, n8n, Karpathy 等)',
    '- emoji 保留',
    '- 长描述可以适当意译,不必逐字直译',
    '- 描述末尾的省略号(…)保留',
    '',
    '只返回纯 JSON 数组,顺序和长度与输入一致,每个元素是对应的中文翻译字符串。',
    '',
    '输入:',
    JSON.stringify(descs),
  ].join('\n');

  // Retry on transient Google-side errors (503 high demand, 429 rate limit, network blips).
  let result;
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      result = await model.generateContent(prompt);
      break;
    } catch (e) {
      lastErr = e;
      const status = e?.status || 0;
      const transient = status === 429 || (status >= 500 && status < 600) || !status;
      if (!transient || attempt === 5) throw e;
      const waitSec = Math.min(60, 5 * 2 ** (attempt - 1)); // 5, 10, 20, 40, 60
      console.log(`  Gemini ${status || 'network'} on attempt ${attempt}, retrying in ${waitSec}s`);
      await new Promise((res) => setTimeout(res, waitSec * 1000));
    }
  }
  const text = result.response.text().trim();

  // Strip markdown fence if Gemini wrapped it despite responseMimeType
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  let arr;
  try {
    arr = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Gemini returned non-JSON: ${cleaned.slice(0, 300)}`);
  }
  if (!Array.isArray(arr) || arr.length !== descs.length) {
    throw new Error(`Gemini returned ${arr?.length ?? '?'} items, expected ${descs.length}`);
  }
  const map = {};
  for (let i = 0; i < descs.length; i++) {
    map[descs[i]] = String(arr[i] || '');
  }
  return map;
}

// Translate in chunks to keep prompts reasonable.
async function translateAll(descs, apiKey, modelName) {
  const out = {};
  const CHUNK = 25;
  for (let i = 0; i < descs.length; i += CHUNK) {
    const slice = descs.slice(i, i + CHUNK);
    const m = await translateBatch(slice, apiKey, modelName);
    Object.assign(out, m);
    console.log(`  translated chunk ${i / CHUNK + 1}/${Math.ceil(descs.length / CHUNK)} (${slice.length} items)`);
  }
  return out;
}

// ---------- existing-artifact history ----------

async function loadExistingDatasets() {
  let html;
  try {
    html = await fs.readFile(INDEX_PATH, 'utf8');
  } catch {
    return {};
  }
  // Strip HTML comments first — the template has a documentation comment with
  // example <script id="trending-data-..."> tags that would otherwise match.
  const stripped = html.replace(/<!--[\s\S]*?-->/g, '');
  const datasets = {};
  const re = /<script id="trending-data-(\S+?)" type="application\/json">([\s\S]+?)<\/script>/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    const name = m[1];
    const blob = m[2].replace(/<\\\/script/g, '</script');
    try {
      datasets[name] = JSON.parse(blob);
    } catch (e) {
      console.warn(`could not parse dataset ${name}: ${e.message}`);
    }
  }
  return datasets;
}

function rollHistory(existing, todayStr) {
  const today = new Date(todayStr + 'T00:00:00Z');
  const kept = {};
  for (const [name, data] of Object.entries(existing)) {
    const m = name.match(/^daily-(\d{4}-\d{2}-\d{2})$/);
    if (!m) continue;
    const d = new Date(m[1] + 'T00:00:00Z');
    const ageDays = Math.floor((today - d) / 86400000);
    if (ageDays >= 1 && ageDays <= HISTORY_DAYS) {
      kept[name] = data;
    }
  }
  return kept;
}

// ---------- main ----------

async function main() {
  const skipTranslation = process.env.SKIP_TRANSLATION === '1';
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey && !skipTranslation) {
    console.error('GEMINI_API_KEY env var is required (or set SKIP_TRANSLATION=1 for a dry run)');
    process.exit(2);
  }
  const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const year = today.getUTCFullYear();

  const endpointInfo = process.env.GEMINI_BASE_URL
    ? `${process.env.GEMINI_BASE_URL}/${process.env.GEMINI_API_VERSION || 'v1beta'} (proxy)`
    : 'https://generativelanguage.googleapis.com/v1beta (official)';
  console.log(`Refreshing for ${todayStr} using model ${modelName} via ${endpointInfo}`);

  console.log('Loading existing artifact for history...');
  const existing = await loadExistingDatasets();
  const dailyRetained = rollHistory(existing, todayStr);
  console.log(`  retained ${Object.keys(dailyRetained).length} historical daily snapshot(s)`);

  console.log('Fetching trending pages...');
  const [dailyHTML, weeklyHTML, monthlyHTML] = await Promise.all([
    fetchText('https://github.com/trending?since=daily'),
    fetchText('https://github.com/trending?since=weekly'),
    fetchText('https://github.com/trending?since=monthly'),
  ]);
  const todayDaily = parseTrendingHTML(dailyHTML);
  const weekly = parseTrendingHTML(weeklyHTML);
  const monthly = parseTrendingHTML(monthlyHTML);
  console.log(`  daily ${todayDaily.count}  weekly ${weekly.count}  monthly ${monthly.count}`);

  console.log('Fetching yearly (3 pages of github.com/search, paced)...');
  // Pace search-page fetches serially with a 2s delay — GitHub rate-limits unauthenticated
  // search burstily, and 3 parallel requests almost always trip it.
  const yearlyPages = [];
  for (const p of [1, 2, 3]) {
    const html = await fetchText(
      `https://github.com/search?q=created%3A%3E%3D${year}-01-01&type=repositories&s=stars&o=desc&p=${p}`
    );
    yearlyPages.push(parseSearchPayload(html));
    if (p < 3) await sleep(2000);
  }
  const yearlySeen = new Set();
  const yearlyRepos = [];
  for (const page of yearlyPages) {
    for (const r of page.repos) {
      const k = `${r.owner}/${r.repo}`;
      if (yearlySeen.has(k)) continue;
      yearlySeen.add(k);
      yearlyRepos.push(r);
    }
  }
  const yearly = { repos: yearlyRepos, count: yearlyRepos.length };
  console.log(`  yearly ${yearly.count} (deduped from 30)`);

  if (todayDaily.count < 5 || weekly.count < 5 || monthly.count < 5 || yearly.count < 10) {
    throw new Error(
      `dataset too small: daily=${todayDaily.count} weekly=${weekly.count} monthly=${monthly.count} yearly=${yearly.count}`
    );
  }

  // Collect descriptions to translate from FRESH datasets only.
  // Retained historical snapshots already have desc_zh from previous runs.
  const fresh = {
    [`daily-${todayStr}`]: todayDaily,
    weekly,
    monthly,
    yearly,
  };
  const todoSet = new Set();
  for (const ds of Object.values(fresh)) {
    for (const r of ds.repos) {
      if (r.desc) todoSet.add(r.desc);
    }
  }
  const todoArr = [...todoSet];
  let transMap;
  if (skipTranslation) {
    console.log(`SKIP_TRANSLATION=1 — leaving desc_zh empty for ${todoArr.length} descs`);
    transMap = {};
  } else {
    console.log(`Translating ${todoArr.length} unique descriptions via Gemini...`);
    transMap = await translateAll(todoArr, apiKey, modelName);
  }
  for (const ds of Object.values(fresh)) {
    for (const r of ds.repos) {
      r.desc_zh = r.desc ? transMap[r.desc] || '' : '';
    }
  }

  const allDatasets = { ...dailyRetained, ...fresh };

  // Render
  const template = await fs.readFile(TEMPLATE_PATH, 'utf8');
  const fetchedAt = today.toISOString().replace(/\.\d{3}Z$/, '+00:00');

  const safeJSON = (obj) => JSON.stringify(obj).replace(/<\/script/g, '<\\/script');

  const dailyKeys = Object.keys(allDatasets)
    .filter((k) => /^daily-\d{4}-\d{2}-\d{2}$/.test(k))
    .sort()
    .reverse();
  const fixedKeys = ['weekly', 'monthly', 'yearly'].filter((k) => allDatasets[k]);
  const orderedKeys = [...dailyKeys, ...fixedKeys];

  const blocks = orderedKeys
    .map((k) => `<script id="trending-data-${k}" type="application/json">${safeJSON(allDatasets[k])}</script>`)
    .join('\n');

  const html = template.replace('__DATASETS__', blocks).replace('__FETCHED_AT__', fetchedAt);

  await fs.writeFile(INDEX_PATH, html, 'utf8');
  console.log(
    `Wrote ${INDEX_PATH}  ${html.length} bytes  ${orderedKeys.length} datasets  order: [${orderedKeys.join(', ')}]`
  );
}

main().catch((err) => {
  console.error('BUILD FAILED:', err);
  process.exit(1);
});
