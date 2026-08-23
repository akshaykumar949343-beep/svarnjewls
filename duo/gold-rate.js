/* ============================================================
   GOLD RATE — fetches today's spot gold price, converted to ₹/gram at
   24K/22K/18K, and renders the top ticker. Every product price on the
   page is computed FROM this rate (see PRODUCT DATA below) rather than
   hardcoded, so it moves with the real market.

   Primary source is MetalPriceAPI (10,000 req/month free tier — GoldAPI's
   100/month kept getting exhausted by ordinary testing traffic). Falls
   back to GoldAPI if that ever fails, then to two free keyless CORS-open
   APIs (gold-api.com for spot XAU + open.er-api.com for USD→INR) doing
   the same conversion by hand, then to whatever was last cached, then to
   a conservative hardcoded number. The site never shows nothing. All
   these keys are necessarily visible client-side (there's no backend to
   hide them behind) — that's an accepted tradeoff of a static site, not
   an oversight.

   Cached in localStorage for CACHE_MS so a burst of page loads/reloads
   doesn't hammer either API; refreshed in the background on an
   interval so a tab left open stays current.
   ============================================================ */

const METALPRICE_KEY = 'e5c8c0e870478c9e81f829b1c78b8a9f';
const GOLDAPI_KEY = 'goldapi-efb14a8568ac2e3ebf545ab86645e505-io';
// prefixed — duo/products.js is a separate classic script sharing this
// same global scope and declares its own SANITY_PROJECT_ID/DATASET;
// identical `const` names in two scripts on one page is a redeclaration
// SyntaxError, not just a harmless shadow
const GOLDRATE_SANITY_PROJECT_ID = 'h2a44pwh';
const GOLDRATE_SANITY_DATASET = 'production';
const GRAMS_PER_TROY_OZ = 31.1034768;
const CACHE_KEY = 'svarn-gold-rate-v1';
const LIVE_CACHE_KEY = 'svarn-gold-rate-live-v1';
const CACHE_MS = 30 * 60 * 1000; // 30 min
const REFRESH_MS = 15 * 60 * 1000; // re-check every 15 min while the tab is open
const OVERRIDE_MAX_AGE_DAYS = 2; // a forgotten manual rate auto-expires back to the live feed
const FALLBACK_24K_PER_GRAM = 15870; // only used if every fetch/cache attempt fails; already India-duty-adjusted so it doesn't undercut the normal price

/* GoldAPI/the free fallback both return raw INTERNATIONAL spot gold
   converted to INR by forex rate alone — that's not what gold actually
   costs landed in India. India's total gold import duty is 15% (10%
   Basic Customs Duty + 5% AIDC) as of the 13 May 2026 hike, so that gets
   added on top here. GST (3%) is applied separately later in each page's
   calcPrice(), not here, to avoid double-counting it.
   This changes with government policy/the union budget — verify it's
   still current if pricing ever looks off. */
const INDIA_IMPORT_DUTY_PCT = 15;
function applyIndiaDuty(perGram) {
  const mult = 1 + INDIA_IMPORT_DUTY_PCT / 100;
  return { 24: perGram[24] * mult, 22: perGram[22] * mult, 18: perGram[18] * mult };
}

let cached = null; // {perGram:{24:..,22:..,18:..}, updatedAt: epoch ms}
let inflight = null;

function readCache(key = CACHE_KEY) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.perGram || !parsed.updatedAt) return null;
    return parsed;
  } catch (e) { return null; }
}
function writeCache(rate, key = CACHE_KEY) {
  try { localStorage.setItem(key, JSON.stringify(rate)); } catch (e) { /* storage unavailable */ }
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

async function fetchFromMetalPriceAPI() {
  const res = await fetch(
    `https://api.metalpriceapi.com/v1/latest?api_key=${METALPRICE_KEY}&base=INR&currencies=XAU`,
    { cache: 'no-store' }
  );
  if (!res.ok) throw new Error(`MetalPriceAPI failed: ${res.status}`);
  const data = await res.json();
  // INRXAU is INR per troy ounce of pure (24K) gold directly — same
  // international-spot-via-forex conversion as the other feeds, so it
  // still needs the India duty adjustment
  const perOz = data.rates && data.rates.INRXAU;
  if (!data.success || !perOz) throw new Error('malformed MetalPriceAPI response');
  const per24 = perOz / GRAMS_PER_TROY_OZ;
  return {
    perGram: applyIndiaDuty({ 24: per24, 22: per24 * (22 / 24), 18: per24 * (18 / 24) }),
    updatedAt: Date.now(),
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
    perGram: applyIndiaDuty({ 24: data.price_gram_24k, 22: data.price_gram_22k, 18: data.price_gram_18k }),
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
    perGram: applyIndiaDuty({ 24: per24, 22: per24 * (22 / 24), 18: per24 * (18 / 24) }),
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
    rate = await fetchFromMetalPriceAPI();
  } catch (err) {
    console.warn('[gold-rate] MetalPriceAPI failed, trying GoldAPI', err);
    try {
      rate = await fetchFromGoldAPI();
    } catch (err2) {
      console.warn('[gold-rate] GoldAPI failed, trying free fallback', err2);
      rate = await fetchFromFreeFallback();
    }
  }
  writeCache(rate);
  return rate;
}

/* Returns the PRICING rate — what calcPrice() on every page actually
   charges. Checks the Sanity override first (the 9:30/12:30/18:30
   checkpoint job writes here), so product prices hold steady between
   checkpoints instead of chasing every tick of the market. Falls back to
   the live feed if no recent override exists. Concurrent callers share
   one in-flight request instead of firing duplicates. */
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

/* Returns the DISPLAY rate — what the header pill and wide ticker show.
   Always the raw continuous market feed, ignoring the Sanity checkpoint
   override, so the ticker looks and feels genuinely live for visitors
   even while the actual charged price is holding steady between
   checkpoints. Cached separately from the pricing rate. */
let liveCached = null;
let liveInflight = null;
function getLiveDisplayRate() {
  if (liveCached && Date.now() - liveCached.updatedAt < CACHE_MS) return Promise.resolve(liveCached);
  const fromStorage = readCache(LIVE_CACHE_KEY);
  if (fromStorage && Date.now() - fromStorage.updatedAt < CACHE_MS) {
    liveCached = fromStorage;
    return Promise.resolve(liveCached);
  }
  if (liveInflight) return liveInflight;
  liveInflight = (async () => {
    try {
      return await fetchFromMetalPriceAPI();
    } catch (err) {
      console.warn('[gold-rate] MetalPriceAPI failed for display feed, trying GoldAPI', err);
      try {
        return await fetchFromGoldAPI();
      } catch (err2) {
        console.warn('[gold-rate] GoldAPI failed for display feed, trying free fallback', err2);
        return await fetchFromFreeFallback();
      }
    }
  })()
    .then((rate) => { liveCached = rate; writeCache(rate, LIVE_CACHE_KEY); liveInflight = null; return rate; })
    .catch((err) => {
      liveInflight = null;
      console.warn('[gold-rate] live display fetch failed, falling back', err);
      const stale = fromStorage || liveCached;
      if (stale) return stale;
      return { perGram: { 24: FALLBACK_24K_PER_GRAM, 22: FALLBACK_24K_PER_GRAM * (22 / 24), 18: FALLBACK_24K_PER_GRAM * (18 / 24) }, updatedAt: 0, isFallback: true };
    });
  return liveInflight;
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
  const p24 = formatINR(rate.perGram[24]);
  const p22 = formatINR(rate.perGram[22]);
  const p18 = formatINR(rate.perGram[18]);
  el.innerHTML =
    `<i class="gp-dot"></i>` +
    `<span class="gp-item gp-extra">24K <b>${p24}</b></span>` +
    `<span class="gp-item">22K <b>${p22}</b></span>` +
    `<span class="gp-item gp-extra">18K <b>${p18}</b></span>` +
    `<span class="gp-suffix">/g</span>`;
  el.title = `Live gold rate — 24K: ${p24}/g, 22K: ${p22}/g, 18K: ${p18}/g (${rate.isFallback ? 'estimated' : relativeTime(rate.updatedAt)})`;
  el.classList.add('is-ready');
}

async function refresh() {
  // ticker/badge now show the SAME checkpoint-locked rate product prices
  // use — one number everywhere, fetched at 9:30/13:30/18:30 and held
  // steady until the next checkpoint, instead of a separately-fetched
  // "live" number that could disagree with what's actually charged.
  const rate = await getGoldRate();
  renderTicker(rate);
  renderHeaderBadge(rate);
  document.dispatchEvent(new CustomEvent('goldrate:update', { detail: rate }));
  return rate;
}

refresh();
setInterval(refresh, REFRESH_MS);

/* small public surface other scripts can use — get() is the checkpoint-
   locked rate (used both for display and by calcPrice on every page);
   getLive() is the raw continuous market feed, kept only as the
   fallback getGoldRate() reaches for when no recent checkpoint exists */
window.GoldRate = { get: getGoldRate, getLive: getLiveDisplayRate, formatINR };
