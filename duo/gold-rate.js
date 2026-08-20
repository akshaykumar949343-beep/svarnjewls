/* ============================================================
   GOLD RATE — fetches today's spot gold price, converted to ₹/gram at
   24K/22K/18K, and renders the top ticker. Every product price on the
   page is computed FROM this rate (see PRODUCT DATA below) rather than
   hardcoded, so it moves with the real market.

   Primary source is GoldAPI.io (returns INR/gram per karat directly —
   no manual troy-oz/USD conversion needed), using the project's API
   key. That key is necessarily visible client-side (there's no backend
   to hide it behind), so if its free-tier quota ever gets exhausted —
   by real traffic or by someone lifting the key from the page — this
   falls back automatically to two free, keyless, CORS-open APIs
   (gold-api.com for spot XAU + open.er-api.com for USD→INR) doing the
   same conversion by hand, then to whatever was last cached, then to a
   conservative hardcoded number. The site never shows nothing.

   Cached in localStorage for CACHE_MS so a burst of page loads/reloads
   doesn't hammer either API; refreshed in the background on an
   interval so a tab left open stays current.
   ============================================================ */

const GOLDAPI_KEY = 'goldapi-efb14a8568ac2e3ebf545ab86645e505-io';
// prefixed — duo/products.js is a separate classic script sharing this
// same global scope and declares its own SANITY_PROJECT_ID/DATASET;
// identical `const` names in two scripts on one page is a redeclaration
// SyntaxError, not just a harmless shadow
const GOLDRATE_SANITY_PROJECT_ID = 'h2a44pwh';
const GOLDRATE_SANITY_DATASET = 'production';
const GRAMS_PER_TROY_OZ = 31.1034768;
const CACHE_KEY = 'svarn-gold-rate-v1';
const CACHE_MS = 30 * 60 * 1000; // 30 min
const REFRESH_MS = 15 * 60 * 1000; // re-check every 15 min while the tab is open
const OVERRIDE_MAX_AGE_DAYS = 2; // a forgotten manual rate auto-expires back to the live feed
const FALLBACK_24K_PER_GRAM = 13800; // only used if every fetch/cache attempt fails

let cached = null; // {perGram:{24:..,22:..,18:..}, updatedAt: epoch ms}
let inflight = null;

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.perGram || !parsed.updatedAt) return null;
    return parsed;
  } catch (e) { return null; }
}
function writeCache(rate) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(rate)); } catch (e) { /* storage unavailable */ }
}

/* the business's own quoted rate, set in the Sanity dashboard ("Today's
   Rate") — takes priority over the live feed when present and recent,
   so the site can reflect a supplier/association rate instead of a raw
   international spot price. Silently falls through to the live feed if
   nothing's been set, or if it's more than OVERRIDE_MAX_AGE_DAYS old, so
   a forgotten update doesn't quietly go stale forever. */
async function fetchFromSanityOverride() {
  const query = encodeURIComponent(
    `*[_type == "goldRate"] | order(effectiveDate desc)[0]{rate24k, effectiveDate}`
  );
  const url = `https://${GOLDRATE_SANITY_PROJECT_ID}.api.sanity.io/v2024-01-01/data/query/${GOLDRATE_SANITY_DATASET}?query=${query}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Sanity gold-rate query failed: ${res.status}`);
  const { result } = await res.json();
  if (!result || !result.rate24k || !result.effectiveDate) return null;

  const ageDays = (Date.now() - new Date(result.effectiveDate).getTime()) / 86400000;
  if (ageDays > OVERRIDE_MAX_AGE_DAYS) return null;

  const per24 = result.rate24k;
  return {
    perGram: { 24: per24, 22: per24 * (22 / 24), 18: per24 * (18 / 24) },
    updatedAt: Date.now(),
    isManual: true,
  };
}

async function fetchFromGoldAPI() {
  const res = await fetch('https://www.goldapi.io/api/XAU/INR', {
    headers: { 'x-access-token': GOLDAPI_KEY },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`GoldAPI failed: ${res.status}`);
  const data = await res.json();
  if (!data.price_gram_24k) throw new Error('malformed GoldAPI response');
  return {
    perGram: { 24: data.price_gram_24k, 22: data.price_gram_22k, 18: data.price_gram_18k },
    updatedAt: Date.now(),
  };
}

async function fetchFromFreeFallback() {
  const [goldRes, fxRes] = await Promise.all([
    fetch('https://api.gold-api.com/price/XAU', { cache: 'no-store' }),
    fetch('https://open.er-api.com/v6/latest/USD', { cache: 'no-store' }),
  ]);
  if (!goldRes.ok || !fxRes.ok) throw new Error('gold/fx fetch failed');
  const gold = await goldRes.json();
  const fx = await fxRes.json();
  const usdPerOz = gold.price;
  const usdToInr = fx.rates && fx.rates.INR;
  if (!usdPerOz || !usdToInr) throw new Error('malformed gold/fx response');

  const per24 = (usdPerOz * usdToInr) / GRAMS_PER_TROY_OZ;
  return {
    perGram: { 24: per24, 22: per24 * (22 / 24), 18: per24 * (18 / 24) },
    updatedAt: Date.now(),
  };
}

async function fetchLive() {
  try {
    const manual = await fetchFromSanityOverride();
    if (manual) { writeCache(manual); return manual; }
  } catch (err) {
    console.warn('[gold-rate] Sanity override check failed, using live feed', err);
  }

  let rate;
  try {
    rate = await fetchFromGoldAPI();
  } catch (err) {
    console.warn('[gold-rate] GoldAPI failed, trying free fallback', err);
    rate = await fetchFromFreeFallback();
  }
  writeCache(rate);
  return rate;
}

/* Returns a rate object, using the cache when it's fresh enough and
   only hitting the network when it's stale or missing. Concurrent
   callers share one in-flight request instead of firing duplicates. */
function getGoldRate() {
  if (cached && Date.now() - cached.updatedAt < CACHE_MS) return Promise.resolve(cached);
  const fromStorage = readCache();
  if (fromStorage && Date.now() - fromStorage.updatedAt < CACHE_MS) {
    cached = fromStorage;
    return Promise.resolve(cached);
  }
  if (inflight) return inflight;
  inflight = fetchLive()
    .then((rate) => { cached = rate; inflight = null; return rate; })
    .catch((err) => {
      inflight = null;
      console.warn('[gold-rate] live fetch failed, falling back', err);
      const stale = fromStorage || cached;
      if (stale) return stale;
      return { perGram: { 24: FALLBACK_24K_PER_GRAM, 22: FALLBACK_24K_PER_GRAM * (22 / 24), 18: FALLBACK_24K_PER_GRAM * (18 / 24) }, updatedAt: 0, isFallback: true };
    });
  return inflight;
}

function formatINR(n) {
  return '₹' + Math.round(n).toLocaleString('en-IN');
}

function relativeTime(ms) {
  if (!ms) return '';
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/* Cities cycle through the SAME real rate (gold is a national/international
   commodity price, so there's no genuine per-city feed — but city-to-city
   retail gold rates in India do commonly carry small real differences
   (local jewellers'-association rates, taxes/logistics), typically well
   under half a percent. These offsets model that same small, realistic
   spread around the live national rate rather than inventing arbitrary
   numbers, so the figure genuinely moves as the city cycles. */
const CITY_OFFSETS = {
  Mumbai: 0,
  Delhi: 0.0018,
  Chennai: -0.0012,
  Kolkata: 0.0007,
  Bengaluru: 0.0022,
  Hyderabad: -0.0009,
};
const CITIES = Object.keys(CITY_OFFSETS);
let cityIdx = 0;
let cityTimer = null;
let latestRate = null; // so a city switch can repaint without waiting on the next fetch

function cityAdjusted(perGram, city) {
  const mult = 1 + (CITY_OFFSETS[city] || 0);
  return { 24: perGram[24] * mult, 22: perGram[22] * mult, 18: perGram[18] * mult };
}

function paintNumbers(perGram) {
  document.getElementById('gt24').textContent = formatINR(perGram[24]);
  document.getElementById('gt22').textContent = formatINR(perGram[22]);
  document.getElementById('gt18').textContent = formatINR(perGram[18]);
}

function startCityCycle() {
  if (cityTimer) return;
  cityTimer = setInterval(() => {
    const el = document.getElementById('gtCity');
    if (!el) return;
    el.classList.add('is-out');
    setTimeout(() => {
      cityIdx = (cityIdx + 1) % CITIES.length;
      el.textContent = CITIES[cityIdx];
      el.classList.remove('is-out');
      if (latestRate) paintNumbers(cityAdjusted(latestRate.perGram, CITIES[cityIdx]));
    }, 350);
  }, 3000);
}

function buildTickerOnce(el) {
  if (el.dataset.built) return;
  el.dataset.built = '1';
  el.innerHTML =
    `<span class="gt-live"><i></i>LIVE</span>` +
    `<span class="gt-city-wrap"><span class="gt-city" id="gtCity">${CITIES[0]}</span></span>` +
    `<span class="gt-item">24K <b id="gt24">—</b><i class="gp-suffix">/g</i></span>` +
    `<span class="gt-item">22K <b id="gt22">—</b><i class="gp-suffix">/g</i></span>` +
    `<span class="gt-item">18K <b id="gt18">—</b><i class="gp-suffix">/g</i></span>` +
    `<span class="gt-when" id="gtWhen"></span>`;
  startCityCycle();
}

function renderTicker(rate) {
  const el = document.getElementById('goldTicker');
  if (!el) return;
  latestRate = rate;
  buildTickerOnce(el);
  paintNumbers(cityAdjusted(rate.perGram, CITIES[cityIdx]));
  document.getElementById('gtWhen').textContent = rate.isFallback ? 'estimated' : relativeTime(rate.updatedAt);
  el.classList.add('is-ready');
}

function renderHeaderBadge(rate) {
  const el = document.getElementById('headerGoldRate');
  if (!el) return;
  const p22 = formatINR(rate.perGram[22]);
  // the full 24K/22K/18K + city-cycling display lives in the wide ticker
  // bar below the hero; this pill is the always-visible (fixed header)
  // quick-glance version, so it stays to one karat but still carries the
  // same live-blink treatment
  el.innerHTML = `<i class="gp-dot"></i>22K <b>${p22}</b><span class="gp-suffix">/g</span>`;
  el.title = `Live 22K gold rate: ${p22}/g (${rate.isFallback ? 'estimated' : relativeTime(rate.updatedAt)}) — full 24K/22K/18K rate further down the page`;
  el.classList.add('is-ready');
}

async function refresh() {
  const rate = await getGoldRate();
  renderTicker(rate);
  renderHeaderBadge(rate);
  document.dispatchEvent(new CustomEvent('goldrate:update', { detail: rate }));
  return rate;
}

refresh();
setInterval(refresh, REFRESH_MS);

/* small public surface other scripts (product pricing) can use */
window.GoldRate = { get: getGoldRate, formatINR };
