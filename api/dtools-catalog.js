// /api/dtools-catalog.js
// Vercel Serverless Function — D-Tools Cloud Catalog Proxy
// Fetches products from D-Tools, maps them to AOP categories, caches for 1 hour.

const DTOOLS_BASE = 'https://dtcloudapi.d-tools.cloud/api/v1';
const DTOOLS_API_KEY = process.env.DTOOLS_API_KEY;
const DTOOLS_BASIC_AUTH = 'RFRDbG91ZEFQSVVzZXI6MyNRdVkrMkR1QCV3Kk15JTU8Yi1aZzlV';

// AOP Category mapping rules
const AOP_MAPPING = {
  illumination: {
    brands: ['lutron', 'ketra', 'elco', 'lumiere', 'wac'],
    systems: ['whole home lighting', 'automated shades'],
    categories: ['lighting', 'shades & blinds', 'electrical fixtures'],
  },
  immersion: {
    brands: ['focal', 'naim', 'leon', 'sonance', 'jbl', 'sony', 'barco', 'grimani', 'episode', 'arcam', 'coastal source', 'triad'],
    systems: ['music system', 'cinema room system', 'av system'],
    categories: ['speakers', 'amplifiers', 'display devices', 'projection screens', 'a/v sources', 'processors'],
  },
  equilibrium: {
    brands: ['aprilaire'],
    systems: ['hvac system'],
    categories: [],
  },
  autonomy: {
    brands: ['savant', 'crestron'],
    systems: ['control system', 'network system'],
    categories: ['control systems', 'networking'],
  },
  perimeter: {
    brands: ['luma', 'ic realtime', '2n'],
    systems: ['surveillance system', 'security system'],
    categories: ['surveillance', 'access control'],
  },
  continuity: {
    brands: ['savant'],
    systems: ['power management', 'power management system'],
    categories: ['power protection', 'power distribution'],
  },
};

// ROM fallback ranges (used if D-Tools returns no data for a category)
const ROM_FALLBACK = {
  illumination: { low: 85000, high: 400000 },
  immersion: { low: 45000, high: 300000 },
  equilibrium: { low: 15000, high: 80000 },
  autonomy: { low: 35000, high: 150000 },
  perimeter: { low: 25000, high: 120000 },
  continuity: { low: 40000, high: 200000 },
};

// In-memory cache: { data, timestamp }
let catalogCache = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function classifyProduct(product) {
  const brandRaw = (product.brand || product.Manufacturer || product.Brand || product.ManufacturerName || '').toLowerCase();
  const systemRaw = (product.system || product.System || product.SystemName || '').toLowerCase();
  const categoryRaw = (product.category || product.Category || product.CategoryName || '').toLowerCase();

  for (const [aopCat, rules] of Object.entries(AOP_MAPPING)) {
    // Check brand match
    if (rules.brands.some(b => brandRaw.includes(b))) return aopCat;
    // Check system match
    if (rules.systems.some(s => systemRaw.includes(s))) return aopCat;
    // Check category match (non-empty rules)
    if (rules.categories.length > 0 && rules.categories.some(c => categoryRaw.includes(c))) return aopCat;
  }
  return null; // Not AOP-relevant
}

function mapProduct(product, aopCategory) {
  return {
    id: product.id || product.ProductId || product.Id || product.SKU,
    name: product.name || product.Name || product.ProductName || product.Description,
    brand: product.brand || product.Manufacturer || product.Brand || product.ManufacturerName,
    model: product.model || product.Model || product.ModelNumber || product.SKU,
    description: product.shortDescription || product.description || product.LongDescription || product.Description || '',
    category: aopCategory,
    unitPrice: parseFloat(product.unitPrice || product.UnitPrice || product.Price || 0),
    msrp: parseFloat(product.msrp || product.MSRP || product.RetailPrice || 0),
    unitCost: parseFloat(product.unitCost || product.UnitCost || product.Cost || 0),
    system: product.system || product.System || product.SystemName || '',
    images: product.images || product.Images || product.ImageUrls || [],
  };
}

async function fetchAllProducts() {
  const authHeaders = {
    'X-API-Key': DTOOLS_API_KEY,
    'Authorization': `Basic ${DTOOLS_BASIC_AUTH}`,
    'Content-Type': 'application/json',
  };

  let allProducts = [];
  let pageNumber = 1;
  let hasMore = true;

  while (hasMore) {
    const url = `${DTOOLS_BASE}/Products/GetProducts?pageSize=500&pageNumber=${pageNumber}`;
    const res = await fetch(url, { headers: authHeaders });

    if (!res.ok) {
      // If first page fails, throw; otherwise stop pagination
      if (pageNumber === 1) {
        throw new Error(`D-Tools API error: ${res.status} ${res.statusText}`);
      }
      break;
    }

    const data = await res.json();

    // Handle various response shapes
    const products = data.Data || data.Products || data.Items || data.products || (Array.isArray(data) ? data : []);

    if (!products || products.length === 0) {
      hasMore = false;
    } else {
      allProducts = allProducts.concat(products);
      // Stop if we got fewer than 500 (last page)
      if (products.length < 500) {
        hasMore = false;
      } else {
        pageNumber++;
        // Safety: max 20 pages (10,000 products)
        if (pageNumber > 20) hasMore = false;
      }
    }
  }

  return allProducts;
}

function buildCatalog(rawProducts) {
  // Group by AOP category
  const grouped = {
    illumination: [],
    immersion: [],
    equilibrium: [],
    autonomy: [],
    perimeter: [],
    continuity: [],
  };

  for (const product of rawProducts) {
    const aopCat = classifyProduct(product);
    if (aopCat && grouped[aopCat]) {
      grouped[aopCat].push(mapProduct(product, aopCat));
    }
  }

  return grouped;
}

function buildSummary(catalog) {
  const summary = {};
  for (const [cat, products] of Object.entries(catalog)) {
    const prices = products
      .map(p => p.unitPrice || p.msrp)
      .filter(p => p > 0);

    const fallback = ROM_FALLBACK[cat];

    if (prices.length > 0) {
      summary[cat] = {
        count: products.length,
        priceMin: Math.min(...prices),
        priceMax: Math.max(...prices),
        priceAvg: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
        // ROM ranges: aggregate product prices into project-level estimate
        romLow: Math.round(Math.min(...prices) * 3),
        romHigh: Math.round(Math.max(...prices) * 12),
        hasLiveData: true,
      };
      // Sanity-check: use fallback if computed ROM seems too low
      if (summary[cat].romLow < fallback.low * 0.1) {
        summary[cat].romLow = fallback.low;
        summary[cat].romHigh = fallback.high;
      }
    } else {
      summary[cat] = {
        count: 0,
        priceMin: null,
        priceMax: null,
        priceAvg: null,
        romLow: fallback.low,
        romHigh: fallback.high,
        hasLiveData: false,
      };
    }
  }
  return summary;
}

async function getOrRefreshCache() {
  const now = Date.now();
  if (catalogCache && (now - catalogCache.timestamp) < CACHE_TTL_MS) {
    return catalogCache.data;
  }

  const rawProducts = await fetchAllProducts();
  const catalog = buildCatalog(rawProducts);
  catalogCache = { data: catalog, timestamp: now };
  return catalog;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { category, tier, summary } = req.query;

  try {
    // Check if D-Tools API key is configured
    if (!DTOOLS_API_KEY) {
      // Return fallback data so the UI still works
      if (summary === 'true') {
        const fallbackSummary = {};
        for (const [cat, range] of Object.entries(ROM_FALLBACK)) {
          fallbackSummary[cat] = {
            count: 0,
            priceMin: null,
            priceMax: null,
            priceAvg: null,
            romLow: range.low,
            romHigh: range.high,
            hasLiveData: false,
          };
        }
        return res.status(200).json({
          success: true,
          source: 'fallback',
          summary: fallbackSummary,
          message: 'D-Tools API key not configured. Using ROM estimates.',
        });
      }
      return res.status(200).json({
        success: true,
        source: 'fallback',
        catalog: { illumination: [], immersion: [], equilibrium: [], autonomy: [], perimeter: [], continuity: [] },
        message: 'D-Tools API key not configured.',
      });
    }

    const catalog = await getOrRefreshCache();

    // Summary mode: return price ranges per category
    if (summary === 'true') {
      const summaryData = buildSummary(catalog);
      return res.status(200).json({
        success: true,
        source: 'dtools',
        summary: summaryData,
        cached: catalogCache && (Date.now() - catalogCache.timestamp) < CACHE_TTL_MS,
        cachedAt: catalogCache ? new Date(catalogCache.timestamp).toISOString() : null,
      });
    }

    // Category filter mode
    if (category) {
      const catProducts = catalog[category.toLowerCase()];
      if (!catProducts) {
        return res.status(400).json({ error: `Unknown AOP category: ${category}` });
      }

      // Optionally filter by tier (used for illumination)
      let filtered = catProducts;
      if (tier && category === 'illumination') {
        const tierBrandMap = {
          curated_light: ['lutron', 'elco'],
          living_light: ['lutron', 'ketra', 'elco'],
          full_spectrum: ['lutron', 'ketra', 'elco', 'lumiere', 'wac'],
        };
        const tierBrands = tierBrandMap[tier.toLowerCase()] || [];
        if (tierBrands.length > 0) {
          filtered = catProducts.filter(p =>
            tierBrands.some(b => (p.brand || '').toLowerCase().includes(b))
          );
        }
      }

      return res.status(200).json({
        success: true,
        source: 'dtools',
        category,
        tier: tier || null,
        count: filtered.length,
        products: filtered,
      });
    }

    // Full catalog summary (no filter)
    const totalCount = Object.values(catalog).reduce((sum, arr) => sum + arr.length, 0);
    const categorySummary = {};
    for (const [cat, products] of Object.entries(catalog)) {
      categorySummary[cat] = products.length;
    }

    return res.status(200).json({
      success: true,
      source: 'dtools',
      totalProducts: totalCount,
      categories: categorySummary,
      catalog,
    });

  } catch (error) {
    console.error('D-Tools catalog error:', error);

    // Return fallback data on error so the UI stays functional
    const fallbackSummary = {};
    for (const [cat, range] of Object.entries(ROM_FALLBACK)) {
      fallbackSummary[cat] = {
        count: 0,
        priceMin: null,
        priceMax: null,
        priceAvg: null,
        romLow: range.low,
        romHigh: range.high,
        hasLiveData: false,
      };
    }

    if (summary === 'true') {
      return res.status(200).json({
        success: true,
        source: 'fallback',
        summary: fallbackSummary,
        error: error.message,
      });
    }

    return res.status(500).json({
      success: false,
      error: error.message,
      fallback: fallbackSummary,
    });
  }
}
