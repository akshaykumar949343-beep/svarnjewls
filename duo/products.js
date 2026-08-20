/* ============================================================
   PRODUCTS — fetches the live catalog from Sanity (the CMS where
   product data lives now) instead of a hardcoded array. Falls back to
   a small built-in sample if Sanity isn't configured yet or the fetch
   fails, so the site never breaks while the CMS project is being set
   up or if the API is briefly unreachable.

   Loaded synchronously (not defer), same reasoning as gold-rate.js:
   the Bestsellers render code later in the document needs
   window.Products.fetch() to already exist when it runs.
   ============================================================ */

const SANITY_PROJECT_ID = 'h2a44pwh';
const SANITY_DATASET = 'production';
const SANITY_API_VERSION = 'v2024-01-01';

// named to avoid colliding with the main inline script's own `ph()` —
// two classic scripts sharing one global scope can't both declare it
// (a later `const ph` would throw: identifier already declared)
function placeholderImg(w, h, label, bg, fg) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="100%" height="100%" fill="${bg}"/>
    <text x="50%" y="50%" fill="${fg}" font-family="sans-serif" font-size="${Math.round(w / 18)}"
      text-anchor="middle" dominant-baseline="middle">${label}</text>
  </svg>`;
  return 'data:image/svg+xml;base64,' + btoa(svg);
}

/* used only until the Sanity project is wired up — same numbers the site
   shipped with, computed from a realistic gold weight/purity/making-charge
   so the live price calculator has something sensible to work with */
const FALLBACK_PRODUCTS = [
  { n: 'Kiara', t: 'Everyday Hoops', category: 'Earrings', w: 1.8, purity: 22, making: 12, stone: 0, b: '' },
  { n: 'Mira', t: 'Diamond Line Ring', category: 'Rings', w: 2.2, purity: 18, making: 15, stone: 12000, b: 'Bestseller' },
  { n: 'Avani', t: 'Rope Chain', category: 'Chains', w: 8.5, purity: 22, making: 10, stone: 0, b: '' },
  { n: 'Diya', t: 'Cuff Bangle', category: 'Bangles', w: 9.5, purity: 22, making: 14, stone: 0, b: '' },
  { n: 'Naina', t: 'Chandbali Earrings', category: 'Earrings', w: 4.2, purity: 22, making: 16, stone: 1500, b: 'Bestseller' },
  { n: 'Rhea', t: 'Baguette Pendant', category: 'Necklaces', w: 2.0, purity: 18, making: 18, stone: 6000, b: '' },
  { n: 'Amara', t: 'Signet Ring', category: 'Rings', w: 3.0, purity: 22, making: 11, stone: 0, b: '' },
  { n: 'Veda', t: 'Tennis Bracelet', category: 'Bangles', w: 6.5, purity: 18, making: 20, stone: 38000, b: '' },
].map((p) => ({
  ...p,
  img: placeholderImg(800, 1000, p.n, '#F7F3EC', '#004374'),
  imgAlt: placeholderImg(800, 1000, p.n + ' 02', '#E7DED0', '#124F7B'),
}));

const QUERY = `*[_type == "product" && featured == true] | order(_createdAt asc){
  name, productType, category, weight, purity, makingChargePct, stoneCharge, badge,
  "img": image.asset->url, "imgAlt": imageAlt.asset->url
}`;

async function fetchProducts() {
  if (SANITY_PROJECT_ID === 'YOUR_PROJECT_ID') return FALLBACK_PRODUCTS;
  try {
    const url = `https://${SANITY_PROJECT_ID}.api.sanity.io/${SANITY_API_VERSION}/data/query/${SANITY_DATASET}` +
      `?query=${encodeURIComponent(QUERY)}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Sanity query failed: ${res.status}`);
    const { result } = await res.json();
    if (!Array.isArray(result) || !result.length) return FALLBACK_PRODUCTS;
    return result.map((r) => ({
      n: r.name,
      t: r.productType,
      category: r.category,
      w: r.weight,
      purity: r.purity,
      making: r.makingChargePct,
      stone: r.stoneCharge || 0,
      b: r.badge || '',
      img: r.img,
      imgAlt: r.imgAlt || r.img,
    }));
  } catch (err) {
    console.warn('[products] Sanity fetch failed, using fallback catalog', err);
    return FALLBACK_PRODUCTS;
  }
}

window.Products = { fetch: fetchProducts };
