/**
 * shop-script.js
 * ACME Store — frontend logic
 *
 * Routing (History API / pushState):
 *   /shop                        → intro screen
 *   /shop/collections            → collections grid
 *   /shop/collections/:slug      → product PDP (also handles direct deep-links)
 *
 * Products and sold counts are fetched from the server (MongoDB Atlas).
 * Prices always come from the server — never hardcoded.
 */

'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
let products      = [];   // from /api/products
let soldCounts    = {};   // from /api/sold-counts  { slug: count }
let cart          = [];
let activeP       = null;
let selectedSize  = '';
let selectedColor = '';
let curCat        = 'All';
let curSort       = 'Relevance';
let _cartJustOpened = false;

// ─── Sanitize: escape HTML special chars ─────────────────────────────────────
function escapeHTML(str) {
    if (typeof str !== 'string') return '';
    return str
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;')
        .replace(/'/g,  '&#x27;')
        .replace(/\//g, '&#x2F;');
}

// ─── Fetch products ───────────────────────────────────────────────────────────
async function loadProducts() {
    try {
        const res  = await fetch('/api/products');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        products = data.map((p) => ({
            ...p,
            id:       p.slug,
            name:     p.title,
            price:    `$${p.priceUSD.toFixed(2)} USD`,
            pVal:     p.priceUSD,
            cat:      p.category,
            imgs:     p.images && p.images.length ? p.images : ['/assets/images/placeholder.png'],
            sizes:    p.sizes  && p.sizes.length  ? p.sizes  : ['NA'],
            colors:   p.colors && p.colors.length ? p.colors : ['NA'],
            colorMap: {},
        }));
    } catch (err) {
        console.error('Failed to load products:', err);
        products = [];
    }
}

// ─── Fetch sold counts ────────────────────────────────────────────────────────
// Returns { slug: units_sold } map. Fails silently — sold counts are
// a nice-to-have display feature, not critical to cart or checkout.
async function loadSoldCounts() {
    try {
        const res  = await fetch('/api/sold-counts');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        soldCounts = await res.json();
    } catch (err) {
        console.warn('Could not load sold counts:', err.message);
        soldCounts = {};
    }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
    VANTA.CLOUDS({
        el: '#canvas-container',
        mouseControls: true,
        touchControls: true,
        backgroundColor: 0x0,
        skyColor:        0x111b24,
        cloudColor:      0x3a4a5e,
        speed:           1.2,
    });

    // Load both in parallel — neither depends on the other
    await Promise.all([loadProducts(), loadSoldCounts()]);

    buildFilterLists();
    setupSearch();
    setupCartOutsideClick();
    setupPopState();
    routeFromURL(false);
}

// ─── URL Router ───────────────────────────────────────────────────────────────
function routeFromURL(animate) {
    const p = window.location.pathname;

    const slugMatch = p.match(/^\/shop\/collections\/([a-z0-9-]+)$/);
    if (slugMatch) {
        showShopViewImmediate();
        openPDPBySlug(slugMatch[1], false);
        return;
    }

    if (p === '/shop/collections') {
        if (animate) {
            showShopView(() => showCollections());
        } else {
            showShopViewImmediate();
            showCollections();
        }
        return;
    }

    showIntroView();
}

function setupPopState() {
    window.addEventListener('popstate', () => routeFromURL(true));
}

// ─── View helpers ─────────────────────────────────────────────────────────────
function showIntroView() {
    const intro = document.getElementById('intro-view');
    const shop  = document.getElementById('shop-view');
    shop.classList.add('acme-hidden');
    shop.style.opacity  = '0';
    intro.style.display = 'flex';
    intro.style.opacity = '1';
}

function showShopView(callback) {
    const intro = document.getElementById('intro-view');
    const shop  = document.getElementById('shop-view');
    intro.style.opacity = '0';
    intro.style.display = 'none';
    shop.classList.remove('acme-hidden');
    requestAnimationFrame(() => {
        shop.style.opacity = '1';
        if (typeof callback === 'function') callback();
    });
}

function showShopViewImmediate() {
    const intro = document.getElementById('intro-view');
    const shop  = document.getElementById('shop-view');
    intro.style.display   = 'none';
    intro.style.opacity   = '0';
    shop.style.transition = 'none';
    shop.classList.remove('acme-hidden');
    shop.style.opacity    = '1';
    requestAnimationFrame(() => { shop.style.transition = 'opacity 0.5s'; });
}

function enterShop() {
    history.pushState({}, '', '/shop/collections');
    showShopView(() => showCollections());
}

function exitToIntro() {
    history.pushState({}, '', '/shop');
    document.getElementById('shop-view').style.opacity = '0';
    setTimeout(() => {
        document.getElementById('shop-view').classList.add('acme-hidden');
        const intro = document.getElementById('intro-view');
        intro.style.display = 'flex';
        intro.style.opacity = '1';
    }, 400);
}

// ─── Collections grid ─────────────────────────────────────────────────────────
function showCollections() {
    document.getElementById('pdp-view').classList.add('acme-hidden');
    document.getElementById('shop-home').classList.remove('acme-hidden');
    applyFilters();
}

function buildFilterLists() {
    const cats  = ['All', 'Shirts', 'Hoodies', 'Hats', 'Mugs'];
    const sorts = ['Relevance', 'Price: Low-High', 'Price: High-Low'];

    document.getElementById('cat-filters').innerHTML = cats.map(c =>
        `<li class="${c === 'All' ? 'active' : ''}" onclick="handleFilter('cat','${escapeHTML(c)}',this)">${escapeHTML(c)}</li>`
    ).join('');

    document.getElementById('sort-filters').innerHTML = sorts.map(s =>
        `<li class="${s === 'Relevance' ? 'active' : ''}" onclick="handleFilter('sort','${escapeHTML(s)}',this)">${escapeHTML(s)}</li>`
    ).join('');
}

function handleFilter(type, val, el) {
    el.parentElement.querySelectorAll('li').forEach(li => li.classList.remove('active'));
    el.classList.add('active');
    if (type === 'cat') curCat = val;
    else curSort = val;
    applyFilters();
}

function applyFilters() {
    let list = products.filter(p => curCat === 'All' || p.cat === curCat);
    if (curSort === 'Price: Low-High')  list.sort((a, b) => a.pVal - b.pVal);
    else if (curSort === 'Price: High-Low') list.sort((a, b) => b.pVal - a.pVal);

    document.getElementById('search-grid').innerHTML = list.map(p => {
        const safeName  = escapeHTML(p.name);
        const safePrice = escapeHTML(`$${p.pVal.toFixed(2)}`);
        const safeImg   = escapeHTML(p.imgs[0]);
        const safeSlug  = escapeHTML(p.id);
        return `
            <div class="acme-card" onclick="openPDPBySlug('${safeSlug}', true)">
                <img src="${safeImg}" alt="${safeName}">
                <div style="display:flex; justify-content:space-between; margin-top:10px; align-items:center;">
                    <span style="font-size:0.75rem; font-weight:700; color:#fff;">${safeName}</span>
                    <span class="price-pill" style="margin:0; font-size:0.6rem; padding:3px 8px;">${safePrice}</span>
                </div>
            </div>`;
    }).join('');

    staggerIn('.acme-card');
}

// ─── PDP ──────────────────────────────────────────────────────────────────────
function openPDPBySlug(slug, pushStateOnOpen) {
    const product = products.find(p => p.id === slug);
    if (!product) {
        console.warn('Product not found for slug:', slug);
        showCollections();
        history.replaceState({}, '', '/shop/collections');
        return;
    }
    if (pushStateOnOpen) {
        history.pushState({}, '', `/shop/collections/${encodeURIComponent(slug)}`);
    }
    renderPDP(product);
}

function renderPDP(product) {
    activeP       = product;
    selectedSize  = activeP.sizes[0];
    selectedColor = activeP.colors[0];

    document.getElementById('pdp-img').src = activeP.imgs[0];
    document.getElementById('pdp-title').textContent = activeP.name;
    document.getElementById('pdp-price').textContent = `$${activeP.pVal.toFixed(2)} USD`;

    document.getElementById('pdp-thumbs').innerHTML = activeP.imgs.map((img, idx) => {
        const safeImg = escapeHTML(img);
        return `<img src="${safeImg}" class="thumb-img ${idx === 0 ? 'active' : ''}" onclick="setMainImg('${safeImg}', this)" alt="Product thumbnail">`;
    }).join('');

    const displaySizes  = activeP.sizes.filter(s => s !== 'NA');
    const displayColors = activeP.colors.filter(c => c !== 'NA');

    document.getElementById('variant-area').innerHTML = `
        ${displaySizes.length ? `
        <div class="variant-container">
            <div class="variant-label">SIZE</div>
            <div class="variant-btns">
                ${displaySizes.map(s => {
                    const safe = escapeHTML(s);
                    return `<button class="acme-opt-btn ${s === selectedSize ? 'active' : ''}" onclick="setV('size','${safe}',this)">${safe}</button>`;
                }).join('')}
            </div>
        </div>` : ''}
        ${displayColors.length ? `
        <div class="variant-container">
            <div class="variant-label">COLOR</div>
            <div class="variant-btns">
                ${displayColors.map(c => {
                    const safe = escapeHTML(c);
                    return `<button class="acme-opt-btn ${c === selectedColor ? 'active' : ''}" onclick="setV('color','${safe}',this)">${safe}</button>`;
                }).join('')}
            </div>
        </div>` : ''}`;

    // ── Sold count — shown between ADD TO CART and BACK TO COLLECTION ─────────
    // soldCounts is a { slug: count } map loaded at init. If the product has
    // no record yet (count is 0 or missing), the element is hidden entirely
    // so new products don't show "0 sold".
    const soldEl = document.getElementById('pdp-sold-count');
    if (soldEl) {
        const count = soldCounts[activeP.id] || 0;
        if (count > 0) {
            soldEl.textContent = `${count.toLocaleString()} sold`;
            soldEl.style.display = 'block';
        } else {
            soldEl.style.display = 'none';
        }
    }

    renderRelated();

    const home = document.getElementById('shop-home');
    const pdp  = document.getElementById('pdp-view');

    if (!home.classList.contains('acme-hidden')) {
        home.classList.add('pdp-exit');
        setTimeout(() => {
            home.classList.add('acme-hidden');
            home.classList.remove('pdp-exit');
            showPDP(pdp);
        }, 200);
    } else {
        home.classList.add('acme-hidden');
        showPDP(pdp);
    }
}

function showPDP(pdp) {
    pdp.classList.remove('acme-hidden');
    pdp.classList.remove('pdp-enter');
    void pdp.offsetWidth;
    pdp.classList.add('pdp-enter');
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function closePDP() {
    history.pushState({}, '', '/shop/collections');
    document.getElementById('pdp-view').classList.add('acme-hidden');
    document.getElementById('pdp-view').classList.remove('pdp-enter');
    document.getElementById('shop-home').classList.remove('acme-hidden');
    applyFilters();
}

// ─── Related marquee ──────────────────────────────────────────────────────────
function renderRelated() {
    const track = document.getElementById('related-marquee');
    const items = products.map(p => {
        const safeImg  = escapeHTML(p.imgs[0]);
        const safeName = escapeHTML(p.name);
        const safeSlug = escapeHTML(p.id);
        return `<div class="marquee-item" onclick="openPDPBySlug('${safeSlug}', true)"><img src="${safeImg}" alt="${safeName}"></div>`;
    }).join('');
    track.innerHTML = items + items;
}

// ─── Image / variant helpers ──────────────────────────────────────────────────
function setMainImg(url, el) {
    document.getElementById('pdp-img').src = url;
    document.querySelectorAll('.thumb-img').forEach(t => t.classList.remove('active'));
    if (el) el.classList.add('active');
}

function setV(type, val, btn) {
    btn.parentElement.querySelectorAll('button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (type === 'size') {
        selectedSize = val;
    } else {
        selectedColor = val;
        if (activeP.colorMap && activeP.colorMap[val]) setMainImg(activeP.colorMap[val]);
    }
}

// ─── Stagger animation ────────────────────────────────────────────────────────
function staggerIn(sel) {
    const items = document.querySelectorAll(sel);
    items.forEach((item, i) => {
        item.classList.remove('fade-up-active');
        item.style.animationDelay = `${i * 0.1}s`;
        void item.offsetWidth;
        item.classList.add('fade-up-active');
    });
}

// ─── Search ───────────────────────────────────────────────────────────────────
function setupSearch() {
    const searchBar = document.getElementById('acme-search-bar');
    const dropdown  = document.getElementById('search-dropdown');

    searchBar.addEventListener('input', (e) => {
        const rawVal  = e.target.value;
        const safeVal = rawVal.trim().toLowerCase();
        if (rawVal.length > 100) e.target.value = rawVal.slice(0, 100);

        if (safeVal.length < 1) {
            dropdown.classList.add('acme-hidden'); dropdown.innerHTML = ''; return;
        }

        const matches = products.filter(p => p.name.toLowerCase().includes(safeVal));
        if (matches.length === 0) {
            dropdown.classList.add('acme-hidden'); dropdown.innerHTML = ''; return;
        }

        dropdown.innerHTML = matches.map(p => {
            const safeName  = escapeHTML(p.name);
            const safePrice = escapeHTML(`$${p.pVal.toFixed(2)}`);
            const safeImg   = escapeHTML(p.imgs[0]);
            const safeSlug  = escapeHTML(p.id);
            return `
                <div class="search-item" onclick="openPDPBySlug('${safeSlug}', true); hideDropdown();">
                    <img src="${safeImg}" alt="${safeName}">
                    <div>
                        <div style="font-weight:700; font-size:0.75rem;">${safeName}</div>
                        <div style="font-size:0.65rem;">${safePrice}</div>
                    </div>
                </div>`;
        }).join('');
        dropdown.classList.remove('acme-hidden');
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-wrapper')) hideDropdown();
    });
}

function hideDropdown() {
    const dropdown = document.getElementById('search-dropdown');
    dropdown.classList.add('acme-hidden');
    dropdown.innerHTML = '';
}

// ─── Cart outside-click ───────────────────────────────────────────────────────
function setupCartOutsideClick() {
    document.addEventListener('click', (e) => {
        const drawer = document.getElementById('cart-drawer');
        if (!drawer.classList.contains('open')) return;
        if (_cartJustOpened) { _cartJustOpened = false; return; }
        if (drawer.contains(e.target))       return;
        if (e.target.closest('.cart-label')) return;
        toggleCart(false);
    });
}

// ─── Cart ─────────────────────────────────────────────────────────────────────
function addToCart() {
    if (!activeP) return;
    cart.push({ ...activeP, selectedSize, selectedColor, cId: Date.now() });
    updateCart();
    _cartJustOpened = true;
    toggleCart(true);
}

function removeFromCart(cId) {
    cart = cart.filter(i => i.cId !== Number(cId));
    updateCart();
}

function updateCart() {
    document.getElementById('cart-count').textContent = cart.length;
    document.getElementById('cart-items').innerHTML = cart.map(i => {
        const safeName  = escapeHTML(i.name);
        const safeSize  = escapeHTML(i.selectedSize  !== 'NA' ? i.selectedSize  : '');
        const safeColor = escapeHTML(i.selectedColor !== 'NA' ? i.selectedColor : '');
        const safeImg   = escapeHTML(i.imgs[0]);
        const metaParts = [safeSize, safeColor].filter(Boolean).join(' / ');
        return `
            <div class="cart-item-row">
                <div class="cart-item-thumb">
                    <img src="${safeImg}" alt="${safeName}">
                    <button class="cart-remove-btn" onclick="removeFromCart(${i.cId})" title="Remove item">✕</button>
                </div>
                <div class="cart-item-info">
                    <div class="cart-item-name">${safeName}</div>
                    ${metaParts ? `<div class="cart-item-meta">${metaParts}</div>` : ''}
                </div>
                <div class="cart-item-price">$${i.pVal.toFixed(2)}</div>
            </div>`;
    }).join('');
    const total = cart.reduce((s, i) => s + i.pVal, 0);
    document.getElementById('cart-total').textContent = `$${total.toFixed(2)}`;
}

function toggleCart(open) {
    document.getElementById('cart-drawer').classList.toggle('open', open);
}

// ─── Stripe Checkout ──────────────────────────────────────────────────────────
async function startCheckout() {
    if (cart.length === 0) { alert('Your cart is empty!'); return; }

    const btn = document.getElementById('checkout-btn');
    btn.disabled    = true;
    btn.textContent = 'Redirecting...';

    const items = cart.map(item => ({
        slug:          item.id,
        selectedSize:  item.selectedSize,
        selectedColor: item.selectedColor,
        quantity:      1,
    }));

    try {
        const res  = await fetch('/create-checkout-session', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ items }),
        });
        const data = await res.json();

        if (data.url) {
            window.location.href = data.url;
        } else if (data.dev) {
            alert('🛠  Dev Mode — Stripe not configured yet.\n\nYour cart and products are working correctly.\nAdd your Stripe keys to .env to enable real payments.');
            btn.disabled    = false;
            btn.textContent = 'CHECKOUT';
        } else {
            alert('Checkout error: ' + escapeHTML(data.error || 'Unknown error'));
            btn.disabled    = false;
            btn.textContent = 'CHECKOUT';
        }
    } catch (err) {
        console.error('Checkout fetch error:', err);
        alert('Network error. Please try again.');
        btn.disabled    = false;
        btn.textContent = 'CHECKOUT';
    }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
init();
