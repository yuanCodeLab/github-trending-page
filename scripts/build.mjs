// Build script for github-trending.yuanqi.blog
// Runs daily in GitHub Actions:
//   1. Reads existing index.html, extracts historical daily snapshots (≤ 6 days old)
//   2. Fetches today's daily / weekly / monthly trending + this-year top from github.com
//   3. Translates English descriptions to Chinese via Gemini API (batched)
//   4. Renders new index.html from scripts/template.html with all datasets embedded
//
// Required env: GEMINI_API_KEY
// Optional env:
//   GEMINI_MODEL         (default: gemini-2.5-flash)
//   GEMINI_BASE_URL      (default: https://generativelanguage.googleapis.com — set this to point at a proxy)
//   GEMINI_API_VERSION   (default: v1beta)
//
// Optional fallback provider (used automatically if primary fails after retries):
//   GEMINI_FALLBACK_API_KEY      — fallback only activates if this is set
//   GEMINI_FALLBACK_BASE_URL     (e.g. http://170.106.186.58)
//   GEMINI_FALLBACK_API_VERSION  (default: v1beta)
//   GEMINI_FALLBACK_MODEL        (default: same as GEMINI_MODEL)

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

// Build the ordered list of providers from env. Primary first, then fallback if configured.
// Each entry has a label for logs and the SDK config it needs.
function getProviders() {
  const providers = [];
  if (process.env.GEMINI_API_KEY) {
    providers.push({
      label: 'primary',
      apiKey: process.env.GEMINI_API_KEY,
      baseUrl: process.env.GEMINI_BASE_URL || undefined,
      apiVersion: process.env.GEMINI_API_VERSION || undefined,
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    });
  }
  if (process.env.GEMINI_FALLBACK_API_KEY) {
    providers.push({
      label: 'fallback',
      apiKey: process.env.GEMINI_FALLBACK_API_KEY,
      baseUrl: process.env.GEMINI_FALLBACK_BASE_URL || undefined,
      apiVersion: process.env.GEMINI_FALLBACK_API_VERSION || undefined,
      model:
        process.env.GEMINI_FALLBACK_MODEL ||
        process.env.GEMINI_MODEL ||
        'gemini-2.5-flash',
    });
  }
  return providers;
}

function describeProvider(p) {
  const url = p.baseUrl || 'https://generativelanguage.googleapis.com';
  const ver = p.apiVersion || 'v1beta';
  return `${p.label}: ${url}/${ver} model=${p.model}`;
}

const ENRICHMENT_PROMPT_HEADER = [
  '你是 GitHub 仓库的中文增强助手。我会给你 JSON 数组,每条仓库含 owner、repo、desc(原始英文描述)。',
  '请为每条返回 JSON 对象,包含以下 4 个字段(顺序和数量必须与输入一致):',
  '',
  '1. desc_zh — 把 desc 翻译成中文。',
  '   - 流畅自然中文,避免机翻味',
  '   - 技术术语保留英文(RAG, MCP, API, SDK, CLI, LLM, OAuth, GraphQL, Embedding 等)',
  '   - 项目名 / 产品名 / 人名保留英文(Suno, Discord, Claude, Codex, n8n, Karpathy 等)',
  '   - emoji 保留;描述末尾的省略号(…)保留',
  '',
  '2. summary_zh — 1-2 句中文总结(50-150 字)。比 desc 多说一层:它是什么、怎么实现、跟同类相比的卖点。',
  '',
  '3. scenarios — 适用场景中文 bullet 数组,3-4 项。每项一句话,帮用户判断"是否为我所用"。',
  '',
  '4. agent_install_prompt — 给 AI coding agent(Claude Code / Codex / Cursor)的安装提示词字符串。',
  '   ⚠️ **必须用中文**(命令本身保持原样)。',
  '   预设场景:用户复制这段话给 agent,让 agent 帮忙克隆 + 安装依赖 + 配置 + 跑一个 smoke test。',
  '   要包含:',
  '   - 克隆到具体路径(如 ~/Code/<repo-name>)',
  '   - 具体安装命令(pip / cargo / npm / docker compose 等,根据语言)',
  '   - 关键配置项(配置文件路径、环境变量名)— 提示用户后续自己粘 API key,不要假设凭据',
  '   - 最后跑一个最小冒烟测试,把输出贴给用户',
  '   不要写"参照 README"这种泛泛的话,要具体。',
  '',
  '示例(供参考,不要照搬):',
  '输入: { owner: "x", repo: "foo-tui", desc: "A terminal UI for the X model" }',
  '理想 agent_install_prompt: "把 https://github.com/x/foo-tui 克隆到 ~/Code/foo-tui,跑 pip install -e . 安装,把 API key 写到 ~/.config/foo-tui/config.toml(我等下粘 key)。完事跑 echo \'hello\' | foo-tui 验证一下,把输出贴给我。"',
  '',
  '只返回纯 JSON 数组,长度和顺序与输入完全一致。不要外层 markdown 代码块。',
  '',
  '输入:',
].join('\n');

// Single-provider call: configure SDK, retry on transient errors, parse + validate.
// Input: array of { owner, repo, desc }. Output: array of { desc_zh, summary_zh, scenarios, agent_install_prompt }.
async function callProvider(repos, provider) {
  const genAI = new GoogleGenerativeAI(provider.apiKey);
  const requestOptions = {};
  if (provider.baseUrl) requestOptions.baseUrl = provider.baseUrl;
  if (provider.apiVersion) requestOptions.apiVersion = provider.apiVersion;
  const model = genAI.getGenerativeModel(
    {
      model: provider.model,
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.4,
      },
    },
    requestOptions,
  );

  const prompt = `${ENRICHMENT_PROMPT_HEADER}\n${JSON.stringify(repos)}`;

  // Retry on transient errors (503 high demand, 429 rate limit, network blips).
  let result;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      result = await model.generateContent(prompt);
      break;
    } catch (e) {
      const status = e?.status || 0;
      const transient = status === 429 || (status >= 500 && status < 600) || !status;
      if (!transient || attempt === 5) throw e;
      const waitSec = Math.min(60, 5 * 2 ** (attempt - 1)); // 5, 10, 20, 40, 60
      console.log(`    [${provider.label}] ${status || 'network'} on attempt ${attempt}, retrying in ${waitSec}s`);
      await new Promise((res) => setTimeout(res, waitSec * 1000));
    }
  }
  const text = result.response.text().trim();
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  let arr;
  try {
    arr = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Gemini returned non-JSON: ${cleaned.slice(0, 300)}`);
  }
  if (!Array.isArray(arr) || arr.length !== repos.length) {
    throw new Error(`Gemini returned ${arr?.length ?? '?'} items, expected ${repos.length}`);
  }
  // Normalise each item to the 4 expected fields.
  return arr.map((x, i) => ({
    desc_zh: typeof x?.desc_zh === 'string' ? x.desc_zh : '',
    summary_zh: typeof x?.summary_zh === 'string' ? x.summary_zh : '',
    scenarios: Array.isArray(x?.scenarios) ? x.scenarios.map((s) => String(s || '')).filter(Boolean) : [],
    agent_install_prompt: typeof x?.agent_install_prompt === 'string' ? x.agent_install_prompt : '',
  }));
}

// Try each provider in order. If a provider fails after its own retries, fall back to the next.
async function translateBatch(repos, providers) {
  if (!repos.length) return [];
  let lastErr;
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    try {
      return await callProvider(repos, p);
    } catch (e) {
      lastErr = e;
      const summary = `${e?.status || ''} ${e?.message || e}`.slice(0, 200).trim();
      const isLast = i === providers.length - 1;
      console.log(`    [${p.label}] failed: ${summary}`);
      if (isLast) throw e;
      console.log(`    → falling back to ${providers[i + 1].label}`);
    }
  }
  throw lastErr; // unreachable but keeps types tidy
}

// Translate in chunks to keep prompts reasonable. Output is per-repo enrichment array.
async function translateAll(repos, providers) {
  const out = [];
  // Smaller chunks because each item now produces ~400 output tokens (4 fields) vs ~50 (just desc_zh).
  const CHUNK = 10;
  for (let i = 0; i < repos.length; i += CHUNK) {
    const slice = repos.slice(i, i + CHUNK);
    const enrichments = await translateBatch(slice, providers);
    out.push(...enrichments);
    console.log(`  enriched chunk ${Math.floor(i / CHUNK) + 1}/${Math.ceil(repos.length / CHUNK)} (${slice.length} items)`);
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

// Build a flat enrichment cache from ALL existing datasets (history + today's previous run).
// Key: `${owner}/${repo}|${desc}` so a repo with changed description gets re-translated.
// Only repos with all 4 enrichment fields are cached (legacy daily snapshots only have desc_zh
// and will be re-translated when they next appear in fresh datasets).
function buildEnrichmentCache(existingDatasets) {
  const cache = {};
  for (const ds of Object.values(existingDatasets)) {
    for (const r of ds.repos || []) {
      if (!r.desc) continue;
      const hasAll = r.desc_zh && r.summary_zh && Array.isArray(r.scenarios) && r.scenarios.length && r.agent_install_prompt;
      if (!hasAll) continue;
      const key = `${r.owner}/${r.repo}|${r.desc}`;
      cache[key] = {
        desc_zh: r.desc_zh,
        summary_zh: r.summary_zh,
        scenarios: r.scenarios,
        agent_install_prompt: r.agent_install_prompt,
      };
    }
  }
  return cache;
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
  const providers = getProviders();
  if (!providers.length && !skipTranslation) {
    console.error('GEMINI_API_KEY env var is required (or set SKIP_TRANSLATION=1 for a dry run)');
    process.exit(2);
  }

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const year = today.getUTCFullYear();

  console.log(`Refreshing for ${todayStr}`);
  if (skipTranslation) {
    console.log('  translation: SKIPPED');
  } else {
    console.log(`  translation providers (${providers.length}):`);
    for (const p of providers) console.log(`    ${describeProvider(p)}`);
  }

  console.log('Loading existing artifact for history + enrichment cache...');
  const existing = await loadExistingDatasets();
  const dailyRetained = rollHistory(existing, todayStr);
  const enrichmentCache = buildEnrichmentCache(existing);
  console.log(`  retained ${Object.keys(dailyRetained).length} historical daily snapshot(s)`);
  console.log(`  enrichment cache: ${Object.keys(enrichmentCache).length} repo(s) with full AI fields`);

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

  // Collect repos that need enrichment from FRESH datasets only.
  // Cache lookup: any repo with the same `${owner}/${repo}|${desc}` key + all 4 fields gets reused.
  const fresh = {
    [`daily-${todayStr}`]: todayDaily,
    weekly,
    monthly,
    yearly,
  };
  const seenKeys = new Set();
  const todoRepos = [];
  for (const ds of Object.values(fresh)) {
    for (const r of ds.repos) {
      if (!r.desc) continue;
      const key = `${r.owner}/${r.repo}|${r.desc}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      if (!enrichmentCache[key]) {
        todoRepos.push({ owner: r.owner, repo: r.repo, desc: r.desc });
      }
    }
  }

  const cacheHits = seenKeys.size - todoRepos.length;
  console.log(`Enrichment plan: ${cacheHits} cache hit(s), ${todoRepos.length} new repo(s) to translate`);

  if (skipTranslation) {
    console.log(`SKIP_TRANSLATION=1 — leaving AI fields empty for ${todoRepos.length} new repos`);
  } else if (todoRepos.length > 0) {
    console.log(`Calling Gemini for ${todoRepos.length} new repos...`);
    const newEnrichments = await translateAll(todoRepos, providers);
    for (let i = 0; i < todoRepos.length; i++) {
      const t = todoRepos[i];
      const key = `${t.owner}/${t.repo}|${t.desc}`;
      enrichmentCache[key] = newEnrichments[i];
    }
  }

  // Apply enrichment to all fresh repos
  for (const ds of Object.values(fresh)) {
    for (const r of ds.repos) {
      if (!r.desc) {
        r.desc_zh = '';
        r.summary_zh = '';
        r.scenarios = [];
        r.agent_install_prompt = '';
        continue;
      }
      const key = `${r.owner}/${r.repo}|${r.desc}`;
      const e = enrichmentCache[key];
      if (e) {
        r.desc_zh = e.desc_zh || '';
        r.summary_zh = e.summary_zh || '';
        r.scenarios = e.scenarios || [];
        r.agent_install_prompt = e.agent_install_prompt || '';
      } else {
        r.desc_zh = '';
        r.summary_zh = '';
        r.scenarios = [];
        r.agent_install_prompt = '';
      }
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
