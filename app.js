import { PEXELS_KEY, UNSPLASH_KEY } from './config.js';
import { CURATED_PHOTOS } from './curated-photos.js';

const ORANGE = '#e8590c';
const STEP_LABELS = ['Size', 'Photo', 'Cutout', 'Swirl', 'Export'];
const RATIOS = [
  { key: 'hero', label: 'Website hero', w: 2880, h: 1260 },
  { key: 'widescreen', label: 'Widescreen 16:9', w: 1920, h: 1080 },
  { key: 'classic', label: 'Classic 3:2', w: 1620, h: 1080 },
  { key: 'square', label: 'Social square', w: 1080, h: 1080 },
  { key: 'portrait', label: 'Social portrait', w: 1080, h: 1350 },
  { key: 'story', label: 'Story', w: 1080, h: 1920 }
];

const root = document.getElementById('app');

const state = {
  step: 1, maxStep: 1,
  ratioKey: 'hero', customW: 1600, customH: 900,
  libQuery: '', photoId: null, photoReady: false, uploadThumb: null, uploadName: '',
  photoSource: 'search', recTheme: 'All',
  searching: false, loadingMore: false,
  segStatus: 'idle', segMessage: 'Loading cutout model…', segEngine: null,
  view: 'cutout', threshold: 0.5, feather: 0.06,
  swirlIdx: 0, swx: 0.5, swy: 0.42, swScale: 1.05, swRot: 0, swFlipH: false, swFlipV: false, lassoMode: false,
  exportFmt: 'jpg', exportScale: 1
};

// ---------- non-reactive engine state (canvases, images, model handles) ----------
let img = null;
let swirls = [];
let results = [];
let _searchToken = 0;
let _deb = null;
let probC = null;
let mw = 0, mh = 0, subjectC = null;
let _raf = 0;
let _draggingSwirl = false;
let _rmbgP = null, _rmbgModel = null, _rmbgProc = null, _T = null;
let _segP = null, segmenter = null;

let c3 = null, c4 = null, c5 = null;
let topRightReadoutEl = null;
let bottomStatusEl = null;
let gridScrollEl = null;
let previewingPhoto = null;
let swEraseMask = []; // polygons erased from the swirl, in swirl-local fraction space (-1..1), so they scale/rotate with it
let lassoPoints = []; // in-progress polygon, in current canvas pixel space
let gridScrollTop = 0;

let pexelsPage = 1, unsplashPage = 1;
let pexelsHasMore = true, unsplashHasMore = true;
let currentQuery = '';
let searchOrientation = null;
let searchedOrientation; // orientation used for the last completed search — re-search if canvas ratio changes
let activePresetLabel = null;

function setState(patch) {
  Object.assign(state, patch);
  render();
}

function baseSize() {
  if (state.ratioKey === 'custom') return { w: Math.max(200, state.customW | 0), h: Math.max(200, state.customH | 0) };
  const r = RATIOS.find(r => r.key === state.ratioKey);
  return { w: r.w, h: r.h };
}

// null = no orientation constraint (near-square canvas accepts either landscape or portrait source photos)
function desiredOrientation() {
  const b = baseSize();
  if (Math.abs(b.w - b.h) / Math.max(b.w, b.h) < 0.05) return null;
  return b.w > b.h ? 'landscape' : 'portrait';
}

function curatedForView() {
  const wantOrientation = desiredOrientation(); // null = square-ish, accepts either
  return CURATED_PHOTOS.filter(it =>
    (!wantOrientation || it.orientation === wantOrientation) &&
    (state.recTheme === 'All' || it.theme === state.recTheme)
  );
}

function seg2(on) {
  return on ? { border: '#1a1a1a', bg: '#1a1a1a', color: '#ffffff' } : { border: '#e0ddd6', bg: '#ffffff', color: '#1a1a1a' };
}

// ---------- element helper ----------
function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'style') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    e.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return e;
}

// ---------- photo loading ----------
function loadPhoto(src, id, cross) {
  const im = new Image();
  if (cross) im.crossOrigin = 'anonymous';
  im.onload = () => {
    img = im; probC = null; subjectC = null;
    swEraseMask = []; lassoPoints = [];
    setState({ photoReady: true, photoId: id, segStatus: 'idle' });
  };
  im.onerror = () => setState({ photoReady: false, photoId: null });
  im.src = src;
  setState({ photoReady: false, photoId: id });
}

function onUploadFile(e) {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  setState({ uploadThumb: url, uploadName: f.name });
  loadPhoto(url, 'upload', false);
}

// ---------- live search (Pexels + Unsplash) ----------
// Brand style guide (5.8 Photography style guide): authentic & natural, human-centric
// & diverse, clean & confident, rooted in the UK. We can't judge aesthetics for free,
// so we softly bias every query toward it instead of trusting raw keyword search alone.
function augmentQuery(q) {
  const base = (q || '').trim();
  if (!base) return 'people warm natural light candid close-up';
  return base + ' candid natural light close-up';
}

function loadImageEl(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => resolve(im);
    im.onerror = reject;
    im.src = src;
  });
}

// Cheap local check (no ML model) — Pexels/Unsplash have no "exclude black & white" or
// "natural white balance" filter, so this samples a tiny canvas and checks it directly:
// drops near-zero-saturation (B&W) photos, and drops extreme color-cast grading in
// either direction (heavy teal/blue "cinematic" looks, or oversaturated orange/tungsten
// looks) — thresholds calibrated against the 100 already-approved curated photos so
// nothing already signed off gets retroactively caught, only genuine outliers.
async function imageQualityOk(url) {
  try {
    const im = await loadImageEl(url);
    const s = 32;
    const c = document.createElement('canvas'); c.width = s; c.height = s;
    c.getContext('2d').drawImage(im, 0, 0, s, s);
    const d = c.getContext('2d').getImageData(0, 0, s, s).data;
    let sat = 0, r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const rr = d[i], gg = d[i + 1], bb = d[i + 2];
      const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb);
      sat += max === 0 ? 0 : (max - min) / max;
      r += rr; g += gg; b += bb;
      n++;
    }
    const avgSat = sat / n;
    const coolCast = (b / n) - (r / n); // blue/teal dominant over red — moody cinematic grading
    const warmCast = (r / n) - (b / n); // red dominant over blue — oversaturated orange/tungsten grading
    if (avgSat <= 0.08) return false;
    if (coolCast > 20) return false;
    if (warmCast > 65) return false;
    return true;
  } catch (e) { return true; } // fail open — don't drop a photo just because sampling errored
}

async function filterColorPhotos(items) {
  const flags = await Promise.all(items.map(it => imageQualityOk(it.thumb)));
  return items.filter((it, i) => flags[i]);
}

// Baked in from client feedback on the curated set: solo person + laptop shots, video
// calls, whiteboards/sticky notes, presentation/screen shots, and wide meeting-table
// shots were rejected almost every time, even when the framing was otherwise tight.
// Requiring explicit multi-person language is the single strongest signal that held up.
const MULTI_PERSON_RE = /\btwo\b|colleagues|coworkers|\bteam\b|\bcouple\b|\bpeople\b|\bwomen\b|\bmen\b|multiethnic|multiracial|diverse team/i;
const SOLO_SIGNAL_RE = /\ba (person|man|woman|professional|freelancer|employee|individual)\b(?!.*\b(two|colleagues|coworkers|team|couple|and (a|another))\b)/i;
const GROUP_RE = /\b(three|four|five|six|seven|eight|multiple|several|group of|large group|group\b)/i;
const FACELESS_RE = /\b(faceless|crop(ped)? (colleagues|coworkers)|top view|overhead|browsing netbook|hands? (holding|working|typing)|close-up of .*(hand|typing)|taking notes on documents)\b/i;
const STYLE_REJECT_RE = /\b(whiteboard|chalkboard|blackboard|white ?board|sticky[- ]?notes?|post-its?|cork ?board|transparent board|on a white|macbook|keyboard|manicure|nails?|video ?(call|calling|chat|chatting|conferenc\w*)|virtual meeting|presenting|presentation|screen|projector|infographics|seminar|conference (table|room)|meeting room|collaborative meeting|business meeting|team meeting|engag(ed|ing) in a|walking|dancing|hallway|corridor|open[ -](o|plan)|cafeteria|cozy|caf[eé]|coffee|using a laptop|typing on a laptop|freelancer sittin|outdoor|works remotely|living room|lounge|seating area|large room|high angle|wide shot|interior|gathered in|sitting in a room)\b/i;

function passesStylePreference(alt) {
  return MULTI_PERSON_RE.test(alt) && !SOLO_SIGNAL_RE.test(alt) && !GROUP_RE.test(alt) && !FACELESS_RE.test(alt) && !STYLE_REJECT_RE.test(alt);
}

async function filterByStylePreference(items) {
  const colorChecked = await filterColorPhotos(items);
  return colorChecked.filter(it => passesStylePreference(it.alt));
}

// ---------- face check (catches hands-only close-ups and "subjects too far apart" —
// the two most common client rejects that have no reliable text signal in the alt
// description at all, so keyword filtering can never catch them) ----------
let _faceDetP = null, faceDetector = null;
function ensureFaceDetector() {
  if (_faceDetP) return _faceDetP;
  _faceDetP = (async () => {
    const vision = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs');
    const files = await vision.FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm');
    const opts = d => ({ baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite', delegate: d }, runningMode: 'IMAGE' });
    try { faceDetector = await vision.FaceDetector.createFromOptions(files, opts('GPU')); }
    catch (e) { faceDetector = await vision.FaceDetector.createFromOptions(files, opts('CPU')); }
  })();
  _faceDetP.catch(() => { _faceDetP = null; });
  return _faceDetP;
}

// Calibrated against 47 photos the client hand-flagged good/bad (see project notes).
// Best combo found by grid search over the labeled set: ~70% agreement with the client's
// own calls — real ceiling, not an undertuned guess. Two known failure modes that no
// threshold fixes: (1) BlazeFace sometimes finds an incidental face in a hands-only shot,
// so those can still slip through; (2) "subjects too far apart" shots often only register
// one detectable face (the other turned away/occluded), so the span check can't fire.
const MIN_FACE_AREA_RATIO = 0.004;
const MAX_FACE_SPAN_RATIO = 0.6; // when 2+ faces are found, how far apart their centers can be (fraction of frame)

async function faceCheckOk(url) {
  try {
    const im = await loadImageEl(url);
    const cap = 640;
    const k = Math.min(1, cap / Math.max(im.naturalWidth, im.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
    c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    const res = faceDetector.detect(c);
    const dets = res.detections || [];
    if (dets.length === 0) return false; // no visible face at all — catches hands-only, back-of-head, object shots
    const frameArea = c.width * c.height;
    const hasBigEnoughFace = dets.some(d => (d.boundingBox.width * d.boundingBox.height) / frameArea >= MIN_FACE_AREA_RATIO);
    if (!hasBigEnoughFace) return false;
    if (dets.length >= 2) {
      const cxs = dets.map(d => d.boundingBox.originX + d.boundingBox.width / 2);
      const cys = dets.map(d => d.boundingBox.originY + d.boundingBox.height / 2);
      const spanX = (Math.max(...cxs) - Math.min(...cxs)) / c.width;
      const spanY = (Math.max(...cys) - Math.min(...cys)) / c.height;
      if (Math.max(spanX, spanY) > MAX_FACE_SPAN_RATIO) return false; // subjects too far apart
    }
    return true;
  } catch (e) { return true; } // fail open — don't drop a photo just because detection errored
}

// Runs after results are already on screen (non-blocking) and prunes any that fail the
// face check, updating the grid as it goes. Guarded by _searchToken so a stale run from
// a previous search can't clobber a newer one.
async function runFaceCheckPass(token) {
  try { await ensureFaceDetector(); } catch (e) { return; }
  const items = results.slice();
  for (const it of items) {
    if (token !== _searchToken) return;
    const ok = await faceCheckOk(it.thumb);
    if (token !== _searchToken) return;
    if (!ok) {
      results = results.filter(r => r.id !== it.id);
      render();
    }
    await new Promise(r => setTimeout(r, 0)); // yield so clicks/paints aren't starved
  }
}

function randomStartPage() {
  return 1 + Math.floor(Math.random() * 4); // spreads repeat searches across ~4 pages of results
}

const PEXELS_PER_PAGE = 40; // Pexels allows up to 80
const UNSPLASH_PER_PAGE = 30; // Unsplash's max

async function fetchPexels(qq, page, orientation) {
  try {
    const orientParam = orientation ? '&orientation=' + orientation : '';
    const r = await fetch('https://api.pexels.com/v1/search?query=' + encodeURIComponent(qq) + '&per_page=' + PEXELS_PER_PAGE + '&page=' + page + orientParam, { headers: { Authorization: PEXELS_KEY } });
    if (!r.ok) throw new Error('pexels ' + r.status);
    const j = await r.json();
    const items = (j.photos || []).map(p => ({ id: 'px' + p.id, thumb: p.src.medium, full: p.src.original, alt: ((p.alt || 'Photo').slice(0, 100)), provider: 'Pexels' }));
    return { items, hasMore: (page * PEXELS_PER_PAGE) < (j.total_results || 0) };
  } catch (e) { console.warn('pexels search failed', e); return { items: [], hasMore: false }; }
}

async function fetchUnsplash(qq, page, orientation) {
  try {
    const orientParam = orientation ? '&orientation=' + orientation : '';
    const r = await fetch('https://api.unsplash.com/search/photos?query=' + encodeURIComponent(qq) + '&per_page=' + UNSPLASH_PER_PAGE + '&page=' + page + orientParam + '&client_id=' + UNSPLASH_KEY);
    if (!r.ok) throw new Error('unsplash ' + r.status);
    const j = await r.json();
    const items = (j.results || []).map(p => ({ id: 'un' + p.id, thumb: p.urls.small, full: p.urls.raw + '&w=6000&q=90&auto=format', alt: ((p.alt_description || 'Photo').slice(0, 100)), provider: 'Unsplash' }));
    return { items, hasMore: page < (j.total_pages || 1) };
  } catch (e) { console.warn('unsplash search failed', e); return { items: [], hasMore: false }; }
}

function interleave(a, b) {
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) { if (a[i]) out.push(a[i]); if (b[i]) out.push(b[i]); }
  return out;
}

function dedupeById(items) {
  const seen = new Set();
  return items.filter(it => { if (seen.has(it.id)) return false; seen.add(it.id); return true; });
}

async function searchNow(q) {
  const qq = augmentQuery(q);
  currentQuery = qq;
  searchOrientation = desiredOrientation();
  searchedOrientation = searchOrientation;
  const token = ++_searchToken;
  setState({ searching: true });
  pexelsPage = randomStartPage();
  unsplashPage = randomStartPage();
  // fetch two pages per provider up front — the style filter rejects most raw results,
  // so a wider pool per search meaningfully raises the odds of landing good ones
  const [rp1, rp2, ru1, ru2] = await Promise.all([
    fetchPexels(qq, pexelsPage, searchOrientation),
    fetchPexels(qq, pexelsPage + 1, searchOrientation),
    fetchUnsplash(qq, unsplashPage, searchOrientation),
    fetchUnsplash(qq, unsplashPage + 1, searchOrientation)
  ]);
  let rpItems = dedupeById(rp1.items.concat(rp2.items));
  let ruItems = dedupeById(ru1.items.concat(ru2.items));
  if (rpItems.length === 0 && pexelsPage > 1) { pexelsPage = 1; const rp = await fetchPexels(qq, 1, searchOrientation); rpItems = rp.items; }
  if (ruItems.length === 0 && unsplashPage > 1) { unsplashPage = 1; const ru = await fetchUnsplash(qq, 1, searchOrientation); ruItems = ru.items; }
  if (token !== _searchToken) return;
  const combined = interleave(rpItems, ruItems);
  results = await filterByStylePreference(combined);
  if (token !== _searchToken) return;
  pexelsHasMore = rp2.hasMore; unsplashHasMore = ru2.hasMore;
  setState({ searching: false });
  runFaceCheckPass(token); // non-blocking — prunes hands-only/too-wide shots as it goes
}

function queueSearch(q) {
  clearTimeout(_deb);
  _deb = setTimeout(() => searchNow(q), 450);
}

async function loadMore() {
  if (state.loadingMore || (!pexelsHasMore && !unsplashHasMore)) return;
  setState({ loadingMore: true });
  const [a, b] = await Promise.all([
    pexelsHasMore ? fetchPexels(currentQuery, ++pexelsPage, searchOrientation).then(r => { pexelsHasMore = r.hasMore; return r.items; }) : Promise.resolve([]),
    unsplashHasMore ? fetchUnsplash(currentQuery, ++unsplashPage, searchOrientation).then(r => { unsplashHasMore = r.hasMore; return r.items; }) : Promise.resolve([])
  ]);
  const seen = new Set(results.map(r => r.id));
  const combined = interleave(a, b).filter(it => !seen.has(it.id));
  const fresh = await filterByStylePreference(combined);
  results = results.concat(fresh);
  setState({ loadingMore: false });
  runFaceCheckPass(_searchToken); // non-blocking — prunes hands-only/too-wide shots as it goes
}

// ---------- segmentation: RMBG-1.4 (HQ) with MediaPipe fallback ----------
function ensureRMBG() {
  if (_rmbgP) return _rmbgP;
  _rmbgP = (async () => {
    const T = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2');
    T.env.allowLocalModels = false;
    _rmbgModel = await T.AutoModel.from_pretrained('briaai/RMBG-1.4', { config: { model_type: 'custom' } });
    _rmbgProc = await T.AutoProcessor.from_pretrained('briaai/RMBG-1.4', { config: {
      do_normalize: true, do_pad: false, do_rescale: true, do_resize: true,
      image_mean: [0.5, 0.5, 0.5], image_std: [1, 1, 1],
      feature_extractor_type: 'ImageFeatureExtractor', resample: 2,
      rescale_factor: 0.00392156862745098, size: { width: 1024, height: 1024 }
    } });
    _T = T;
  })();
  _rmbgP.catch(() => { _rmbgP = null; });
  return _rmbgP;
}

async function runRMBGOnImage(im, cap) {
  const k = Math.min(1, cap / Math.max(im.naturalWidth, im.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
  c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const raw = await _T.RawImage.fromBlob(blob);
  const { pixel_values } = await _rmbgProc(raw);
  const { output } = await _rmbgModel({ input: pixel_values });
  const mask = await _T.RawImage.fromTensor(output[0].mul(255).to('uint8')).resize(c.width, c.height);
  return { data: mask.data, w: mask.width, h: mask.height };
}

async function segRMBG() {
  return runRMBGOnImage(img, 1024);
}

function applyProb(alpha, mwv, mhv) {
  const pc = document.createElement('canvas'); pc.width = mwv; pc.height = mhv;
  const pd = pc.getContext('2d').createImageData(mwv, mhv);
  for (let i = 0; i < mwv * mhv; i++) { pd.data[i * 4] = 255; pd.data[i * 4 + 1] = 255; pd.data[i * 4 + 2] = 255; pd.data[i * 4 + 3] = alpha[i]; }
  pc.getContext('2d').putImageData(pd, 0, 0);
  probC = pc;
  const im = img;
  const wk = Math.min(1, 1200 / Math.max(im.naturalWidth, im.naturalHeight));
  mw = Math.round(im.naturalWidth * wk); mh = Math.round(im.naturalHeight * wk);
  recompute();
}

function ensureSeg() {
  if (_segP) return _segP;
  _segP = (async () => {
    const vision = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs');
    const files = await vision.FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm');
    const opts = d => ({ baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite', delegate: d }, runningMode: 'IMAGE', outputConfidenceMasks: true, outputCategoryMask: false });
    try { segmenter = await vision.ImageSegmenter.createFromOptions(files, opts('GPU')); }
    catch (e) { segmenter = await vision.ImageSegmenter.createFromOptions(files, opts('CPU')); }
  })();
  _segP.catch(() => { _segP = null; });
  return _segP;
}

async function runSeg() {
  if (!img) return;
  setState({ segStatus: 'loading', segMessage: 'Loading HQ cutout model (first time only, ~40 MB)…' });
  try {
    await ensureRMBG();
    setState({ segStatus: 'loading', segMessage: 'Removing background (high quality)…' });
    await new Promise(r => setTimeout(r, 30));
    const { data, w, h } = await segRMBG();
    applyProb(data, w, h);
    setState({ segStatus: 'ready', segEngine: 'HQ', feather: 0.015, threshold: 0.4 });
    return;
  } catch (err) {
    console.warn('RMBG failed, falling back to MediaPipe', err);
  }
  setState({ segStatus: 'loading', segMessage: 'HQ model unavailable — using fast fallback…' });
  try {
    await ensureSeg();
    await new Promise(r => setTimeout(r, 30));
    const im = img;
    const cap = 1024, k = Math.min(1, cap / Math.max(im.naturalWidth, im.naturalHeight));
    const inC = document.createElement('canvas');
    inC.width = Math.round(im.naturalWidth * k); inC.height = Math.round(im.naturalHeight * k);
    inC.getContext('2d').drawImage(im, 0, 0, inC.width, inC.height);
    const res = segmenter.segment(inC);
    const m = res.confidenceMasks[0];
    let p = Float32Array.from(m.getAsFloat32Array());
    const mwv = m.width, mhv = m.height;
    try { res.close && res.close(); } catch (e) {}
    const avg = (x0, y0, x1, y1) => { let s = 0, n = 0; for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { s += p[y * mwv + x]; n++; } return s / Math.max(1, n); };
    const c = avg(mwv * 0.4 | 0, mhv * 0.35 | 0, mwv * 0.6 | 0, mhv * 0.75 | 0);
    const e = (avg(0, 0, mwv * 0.12 | 0, mhv * 0.12 | 0) + avg(mwv * 0.88 | 0, 0, mwv, mhv * 0.12 | 0)) / 2;
    if (c < e) for (let i = 0; i < p.length; i++) p[i] = 1 - p[i];
    const alpha = new Uint8ClampedArray(p.length);
    for (let i = 0; i < p.length; i++) alpha[i] = Math.round(p[i] * 255);
    applyProb(alpha, mwv, mhv);
    setState({ segStatus: 'ready', segEngine: 'Fast', feather: 0.06, threshold: 0.5 });
  } catch (err) {
    console.warn('segmentation failed', err);
    setState({ segStatus: 'error' });
  }
}

function smoothstep(p, th, fe) {
  const t = Math.min(1, Math.max(0, (p - (th - fe)) / (2 * fe + 1e-4)));
  return t * t * (3 - 2 * t);
}

function recompute() {
  if (!probC || !img) return;
  const th = state.threshold, fe = state.feather;
  const t = document.createElement('canvas'); t.width = mw; t.height = mh;
  const tc = t.getContext('2d');
  tc.drawImage(probC, 0, 0, mw, mh);
  const idata = tc.getImageData(0, 0, mw, mh);
  const d = idata.data;
  for (let i = 0; i < mw * mh; i++) {
    const a = smoothstep(d[i * 4 + 3] / 255, th, fe);
    d[i * 4] = 255; d[i * 4 + 1] = 255; d[i * 4 + 2] = 255; d[i * 4 + 3] = Math.round(a * 255);
  }
  tc.putImageData(idata, 0, 0);
  const im = img;
  const s = document.createElement('canvas'); s.width = im.naturalWidth; s.height = im.naturalHeight;
  const sc = s.getContext('2d');
  sc.drawImage(im, 0, 0);
  sc.globalCompositeOperation = 'destination-in';
  sc.imageSmoothingQuality = 'high';
  sc.drawImage(t, 0, 0, s.width, s.height);
  subjectC = s;
}

function scheduleRecompute() {
  if (_raf) return;
  _raf = requestAnimationFrame(() => { _raf = 0; recompute(); paintCurrent(); });
}

// ---------- painting ----------
function paintCurrent() {
  if (state.step === 3) paint3();
  if (state.step === 4) paint4();
  if (state.step === 5) paint5();
}

function containRect(iw, ih, cw, ch) {
  const k = Math.min(cw / iw, ch / ih);
  const w = iw * k, h = ih * k;
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h, k };
}

function coverDraw(ctx, im, cw, ch) {
  const iw = im.width || im.naturalWidth, ih = im.height || im.naturalHeight;
  const k = Math.max(cw / iw, ch / ih);
  ctx.drawImage(im, (cw - iw * k) / 2, (ch - ih * k) / 2, iw * k, ih * k);
}

function paint3() {
  const c = c3; if (!c || !img) return;
  const im = img;
  const fit = containRect(im.naturalWidth, im.naturalHeight, 960, 540);
  c.width = Math.round(fit.w); c.height = Math.round(fit.h);
  const ctx = c.getContext('2d');
  if (state.view === 'original' || !subjectC) {
    ctx.drawImage(im, 0, 0, c.width, c.height);
  } else {
    ctx.fillStyle = 'rgba(220,38,38,0.7)';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(subjectC, 0, 0, c.width, c.height);
  }
}

function swirlDims(cw) {
  const sw = swirls[state.swirlIdx];
  if (!sw || !sw.naturalWidth) return null;
  const tw = state.swScale * cw * 0.9, thh = tw * (sw.naturalHeight / sw.naturalWidth);
  return { sw, tw, thh };
}

function drawComposite(ctx, cw, ch) {
  if (img) coverDraw(ctx, img, cw, ch);
  const d = swirlDims(cw);
  if (d) {
    const { sw, tw, thh } = d;
    // draw the swirl (and its erase mask) on an isolated offscreen buffer first — applying
    // destination-out directly on the main canvas would erase the background photo underneath
    // it too, not just the swirl.
    const off = document.createElement('canvas'); off.width = cw; off.height = ch;
    const octx = off.getContext('2d');
    octx.save();
    octx.translate(state.swx * cw, state.swy * ch);
    octx.rotate(state.swRot * Math.PI / 180);
    octx.scale(state.swFlipH ? -1 : 1, state.swFlipV ? -1 : 1);
    octx.drawImage(sw, -tw / 2, -thh / 2, tw, thh);
    if (swEraseMask.length) {
      octx.globalCompositeOperation = 'destination-out';
      for (const poly of swEraseMask) {
        if (poly.length < 3) continue;
        octx.beginPath();
        octx.moveTo(poly[0].fx * tw / 2, poly[0].fy * thh / 2);
        for (let i = 1; i < poly.length; i++) octx.lineTo(poly[i].fx * tw / 2, poly[i].fy * thh / 2);
        octx.closePath();
        octx.fill();
      }
      octx.globalCompositeOperation = 'source-over';
    }
    octx.restore();
    ctx.drawImage(off, 0, 0);
  }
  if (subjectC && state.segStatus === 'ready') coverDraw(ctx, subjectC, cw, ch);
}

// Converts a click point (in canvas pixel space) into swirl-local fraction space (-1..1),
// inverting the translate/rotate/flip applied when drawing — so the erased region stays
// glued to the swirl if it's later moved, rotated, or resized.
function canvasPtToSwirlFraction(px, py, cw, ch) {
  const d = swirlDims(cw);
  if (!d) return null;
  const { tw, thh } = d;
  const dx = px - state.swx * cw, dy = py - state.swy * ch;
  const rad = -state.swRot * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  let rx = dx * cos - dy * sin;
  let ry = dx * sin + dy * cos;
  if (state.swFlipH) rx = -rx;
  if (state.swFlipV) ry = -ry;
  return { fx: rx / (tw / 2), fy: ry / (thh / 2) };
}

function paint4() {
  const c = c4; if (!c) return;
  const b = baseSize();
  const fit = containRect(b.w, b.h, 980, 540);
  c.width = Math.round(fit.w); c.height = Math.round(fit.h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#efede8'; ctx.fillRect(0, 0, c.width, c.height);
  drawComposite(ctx, c.width, c.height);
  if (!state.lassoMode) {
    ctx.save();
    ctx.beginPath(); ctx.arc(state.swx * c.width, state.swy * c.height, 7, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#1a1a1a'; ctx.stroke();
    ctx.restore();
  }
  if (lassoPoints.length) {
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#e8590c'; ctx.fillStyle = 'rgba(232,89,12,.15)';
    ctx.beginPath();
    ctx.moveTo(lassoPoints[0].x, lassoPoints[0].y);
    for (let i = 1; i < lassoPoints.length; i++) ctx.lineTo(lassoPoints[i].x, lassoPoints[i].y);
    ctx.stroke();
    if (lassoPoints.length > 2) { ctx.closePath(); ctx.fill(); }
    for (const p of lassoPoints) { ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fillStyle = '#e8590c'; ctx.fill(); }
    ctx.restore();
  }
}

function paint5() {
  const c = c5; if (!c) return;
  const b = baseSize();
  const fit = containRect(b.w, b.h, 900, 600);
  c.width = Math.round(fit.w); c.height = Math.round(fit.h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#efede8'; ctx.fillRect(0, 0, c.width, c.height);
  drawComposite(ctx, c.width, c.height);
}

// ---------- export ----------
function doExportNow() {
  const b = baseSize(), k = state.exportScale;
  const c = document.createElement('canvas'); c.width = b.w * k; c.height = b.h * k;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
  drawComposite(ctx, c.width, c.height);
  const fmt = state.exportFmt;
  try {
    c.toBlob(bl => {
      if (!bl) { alert('Export failed — the selected stock photo blocked canvas export. Try an uploaded photo.'); return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(bl);
      a.download = 'lz-' + state.ratioKey + '-' + c.width + 'x' + c.height + '.' + fmt;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }, fmt === 'jpg' ? 'image/jpeg' : 'image/png', 0.92);
  } catch (err) { alert('Export failed: ' + err.message); }
}

// ---------- nav ----------
function maybeRefreshForOrientation() {
  if (state.photoSource !== 'search' || !results.length) return; // curated tab re-filters live at render time
  if (desiredOrientation() === searchedOrientation) return;
  const preset = PHOTO_PRESETS.find(p => p.label === activePresetLabel);
  searchNow(preset ? preset.queries[Math.floor(Math.random() * preset.queries.length)] : state.libQuery);
}

function go(n) {
  if (n > state.maxStep) return;
  setState({ step: n });
  if (n === 2) maybeRefreshForOrientation();
}

function next() {
  const s = state;
  if (s.step === 1) { setState({ step: 2, maxStep: Math.max(s.maxStep, 2) }); maybeRefreshForOrientation(); }
  else if (s.step === 2) {
    if (!s.photoReady) return;
    setState({ step: 3, maxStep: Math.max(s.maxStep, 3) });
    if (!probC && s.segStatus !== 'loading') runSeg();
  }
  else if (s.step === 3) { if (s.segStatus === 'loading') return; setState({ step: 4, maxStep: Math.max(s.maxStep, 4) }); }
  else if (s.step === 4) setState({ step: 5, maxStep: Math.max(s.maxStep, 5) });
}

// ---------- status text ----------
function computeStatusText() {
  const s = state, b = baseSize();
  switch (s.step) {
    case 1: return 'Canvas: ' + b.w + ' × ' + b.h + ' px';
    case 2: {
      if (s.searching) return 'Searching Pexels + Unsplash…';
      if (s.photoReady) return 'Photo ready — next: automatic subject cutout';
      if (s.photoId) return 'Loading photo…';
      if (s.photoSource === 'curated') {
        const n = curatedForView().length;
        return n ? n + ' curated photos' : 'Pick a photo or upload your own';
      }
      if (!results.length) return 'Pick a photo or upload your own';
      return results.length + ' photos · Pexels + Unsplash';
    }
    case 3: return s.segStatus === 'ready' ? 'Cutout ready (' + (s.segEngine === 'HQ' ? 'HQ model' : 'fast fallback') + ')' : s.segStatus === 'skipped' ? 'Cutout skipped — swirl will sit on top' : s.segStatus === 'error' ? 'Cutout unavailable' : 'Working…';
    case 4: return 'Swirl sits between background and subject — drag it around';
    case 5: return 'Everything happens in your browser — nothing is uploaded';
    default: return '';
  }
}

function refreshSizeReadout() {
  if (!topRightReadoutEl) return;
  const b = baseSize();
  topRightReadoutEl.textContent = b.w + '×' + b.h + (state.step === 5 && state.exportScale === 2 ? ' @2×' : '');
}

// ---------- top bar ----------
function renderTopBar() {
  const bar = el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px', height: '60px', background: '#ffffff', borderBottom: '1px solid #e8e6e1', flex: 'none' } });
  const left = el('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', width: '260px' } }, [
    el('span', { style: { fontWeight: '600', fontSize: '14px' } }, 'L&Z'),
    el('span', { style: { fontSize: '12px', color: '#8a8478' } }, 'Brand Assets Creator')
  ]);
  const mid = el('div', { style: { display: 'flex', alignItems: 'center', gap: '4px' } });
  STEP_LABELS.forEach((label, i) => {
    const n = i + 1, cur = n === state.step, done = n < state.step, reachable = n <= state.maxStep;
    if (i > 0) mid.appendChild(el('span', { style: { width: '18px', height: '1px', background: '#d5d1c7' } }));
    mid.appendChild(el('div', {
      style: { display: 'flex', alignItems: 'center', gap: '7px', padding: '5px 12px', borderRadius: '20px', background: cur ? '#f7f5f0' : 'transparent', cursor: reachable ? 'pointer' : 'default' },
      onClick: () => go(n)
    }, [
      el('span', { style: { width: '19px', height: '19px', borderRadius: '50%', background: cur ? ORANGE : done ? '#1a1a1a' : 'transparent', border: '1.5px solid ' + (cur ? ORANGE : done ? '#1a1a1a' : '#d5d1c7'), color: (cur || done) ? '#ffffff' : '#8a8478', fontSize: '10.5px', fontWeight: '600', display: 'flex', alignItems: 'center', justifyContent: 'center' } }, done ? '✓' : String(n)),
      el('span', { style: { fontSize: '12px', fontWeight: cur ? '600' : '400', color: cur ? '#1a1a1a' : '#8a8478' } }, label)
    ]));
  });
  topRightReadoutEl = el('span', { style: { font: "500 11px 'IBM Plex Mono', monospace", color: '#8a8478' } });
  refreshSizeReadout();
  const right = el('div', { style: { width: '260px', display: 'flex', justifyContent: 'flex-end' } }, [topRightReadoutEl]);
  bar.appendChild(left); bar.appendChild(mid); bar.appendChild(right);
  return bar;
}

// ---------- bottom bar ----------
function renderBottomBar() {
  const bar = el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px', height: '62px', background: '#ffffff', borderTop: '1px solid #e8e6e1', flex: 'none' } });
  const left = el('div', { style: { width: '200px' } });
  if (state.step > 1) {
    left.appendChild(el('div', {
      style: { display: 'inline-flex', padding: '9px 16px', border: '1px solid #e0ddd6', fontSize: '13px', fontWeight: '500', borderRadius: '7px', cursor: 'pointer', background: '#ffffff' },
      onClick: () => setState({ step: state.step - 1 })
    }, '← Back'));
  }
  bottomStatusEl = el('span', { style: { fontSize: '12px', color: '#8a8478' } }, computeStatusText());
  const right = el('div', { style: { width: '200px', display: 'flex', justifyContent: 'flex-end' } });
  if (state.step < 5) {
    const s = state;
    const segReady = s.segStatus === 'ready' || s.segStatus === 'skipped';
    const nextEnabled = (s.step === 1) || (s.step === 2 && s.photoReady) || (s.step === 3 && (segReady || s.segStatus === 'error')) || s.step === 4;
    right.appendChild(el('div', {
      style: { display: 'inline-flex', padding: '10px 20px', fontSize: '13px', fontWeight: '500', borderRadius: '8px', cursor: nextEnabled ? 'pointer' : 'default', background: nextEnabled ? '#1a1a1a' : '#e8e6e1', color: nextEnabled ? '#ffffff' : '#a09a8e' },
      onClick: () => next()
    }, s.step === 4 ? 'Next: Export →' : 'Next →'));
  }
  bar.appendChild(left); bar.appendChild(bottomStatusEl); bar.appendChild(right);
  return bar;
}

// ---------- step 1 · size ----------
function renderStep1() {
  const wrap = el('div', { style: { flex: '1', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '28px', minHeight: '0' } });
  wrap.appendChild(el('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' } }, [
    el('span', { style: { fontSize: '20px', fontWeight: '600' } }, 'Canvas size'),
    el('span', { style: { fontSize: '13px', color: '#8a8478' } }, 'Pick where this asset will live — everything downstream adapts.')
  ]));
  const cardsRow = el('div', { style: { display: 'flex', gap: '14px', alignItems: 'stretch' } });
  RATIOS.forEach(r => {
    const sel = state.ratioKey === r.key;
    const maxD = 64, k = maxD / Math.max(r.w, r.h);
    const pw = Math.round(r.w * k), ph = Math.round(r.h * k);
    cardsRow.appendChild(el('div', {
      style: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', gap: '12px', width: '148px', padding: '20px 12px 16px', background: '#ffffff', border: '1.5px solid ' + (sel ? '#1a1a1a' : '#e8e6e1'), borderRadius: '10px', cursor: 'pointer', boxShadow: sel ? '0 4px 16px rgba(26,20,10,.12)' : 'none' },
      onClick: () => setState({ ratioKey: r.key })
    }, [
      el('div', { style: { width: pw + 'px', height: ph + 'px', background: sel ? ORANGE : '#e8e6e1', borderRadius: '3px' } }),
      el('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' } }, [
        el('span', { style: { fontSize: '13px', fontWeight: '600' } }, r.label),
        el('span', { style: { font: "400 10.5px 'IBM Plex Mono', monospace", color: '#8a8478' } }, r.w + '×' + r.h)
      ])
    ]));
  });
  wrap.appendChild(cardsRow);

  const customSel = state.ratioKey === 'custom';
  const wInput = el('input', { type: 'number', style: { width: '76px', padding: '7px 9px', font: "500 12px 'IBM Plex Mono', monospace", border: '1px solid #e0ddd6', borderRadius: '6px', background: '#fbfaf8', color: '#1a1a1a' } });
  wInput.value = state.customW;
  wInput.addEventListener('input', e => { state.customW = parseInt(e.target.value) || 0; refreshSizeReadout(); });
  const hInput = el('input', { type: 'number', style: { width: '76px', padding: '7px 9px', font: "500 12px 'IBM Plex Mono', monospace", border: '1px solid #e0ddd6', borderRadius: '6px', background: '#fbfaf8', color: '#1a1a1a' } });
  hInput.value = state.customH;
  hInput.addEventListener('input', e => { state.customH = parseInt(e.target.value) || 0; refreshSizeReadout(); });

  wrap.appendChild(el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 16px', background: '#ffffff', border: '1.5px solid ' + (customSel ? '#1a1a1a' : '#e8e6e1'), borderRadius: '10px' } }, [
    el('span', { style: { fontSize: '12px', fontWeight: '600', color: '#55503f' } }, 'Custom'),
    wInput,
    el('span', { style: { fontSize: '12px', color: '#8a8478' } }, '×'),
    hInput,
    el('span', { style: { fontSize: '11px', color: '#8a8478' } }, 'px'),
    el('div', { style: { padding: '7px 12px', fontSize: '12px', fontWeight: '500', border: '1px solid #e0ddd6', borderRadius: '6px', cursor: 'pointer', background: customSel ? '#1a1a1a' : '#ffffff', color: customSel ? '#ffffff' : '#1a1a1a' }, onClick: () => setState({ ratioKey: 'custom' }) }, 'Use')
  ]));
  return wrap;
}

// ---------- step 2 · photo ----------
// Each preset holds several query variants on the same theme — clicking it again
// picks a different one, so repeat clicks surface fresh results, not the same batch.
// Kept deliberately away from "portrait" / "studio" / "posed" language per brand guide.
const PHOTO_PRESETS = [
  { label: 'Team at work', queries: [
    'diverse team collaborating office candid close-up',
    'colleagues brainstorming office candid close-up',
    'coworkers discussing project laptop office candid close-up',
    'colleagues talking office candid natural light close-up',
    'colleagues working together office desk candid close-up'
  ] },
  { label: 'Professional consultant', queries: [
    'consultant and client discussing strategy candid close-up',
    'two colleagues consulting on business strategy candid close-up',
    'advisor working with client on laptop candid close-up',
    'business consultant explaining plan to client candid close-up'
  ] },
  { label: 'Remote & hybrid work', queries: [
    'two colleagues hybrid office meeting candid close-up',
    'coworkers collaborating flexible office space candid close-up',
    'two coworkers discussing hybrid work schedule candid close-up'
  ] },
  { label: 'Meetings & presenting', queries: [
    'colleagues discussing plan candid business natural light close-up',
    'team discussion candid office close-up',
    'colleagues reviewing documents together candid natural light'
  ] },
];

function renderStep2() {
  const wrap = el('div', { style: { flex: '1', display: 'flex', flexDirection: 'column', minHeight: '0', padding: '22px 32px 8px', gap: '12px', overflow: 'hidden' } });

  const uploadInput = el('input', { id: 'lz-upload', type: 'file', accept: 'image/*', style: { display: 'none' } });
  uploadInput.addEventListener('change', onUploadFile);

  const sourceOn = state.photoSource;
  const sourceTabs = el('div', { style: { display: 'flex', gap: '2px', background: '#f1efe9', borderRadius: '7px', padding: '2px', flex: 'none' } }, [
    el('div', { style: { padding: '6px 14px', fontSize: '12px', fontWeight: '500', borderRadius: '5px', cursor: 'pointer', background: sourceOn === 'curated' ? '#ffffff' : 'transparent', boxShadow: sourceOn === 'curated' ? '0 1px 2px rgba(0,0,0,.1)' : 'none', color: sourceOn === 'curated' ? '#1a1a1a' : '#8a8478' }, onClick: () => setState({ photoSource: 'curated' }) }, 'Curated'),
    el('div', { style: { padding: '6px 14px', fontSize: '12px', fontWeight: '500', borderRadius: '5px', cursor: 'pointer', background: sourceOn === 'search' ? '#ffffff' : 'transparent', boxShadow: sourceOn === 'search' ? '0 1px 2px rgba(0,0,0,.1)' : 'none', color: sourceOn === 'search' ? '#1a1a1a' : '#8a8478' }, onClick: () => {
      setState({ photoSource: 'search' });
      if (!results.length) { const p = PHOTO_PRESETS.find(p => p.label === activePresetLabel) || PHOTO_PRESETS[0]; searchNow(p.queries[Math.floor(Math.random() * p.queries.length)]); }
    } }, 'Search')
  ]);

  const topRow = el('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', flex: 'none' } }, [
    sourceTabs,
    el('div', { style: { flex: '1' } }),
    el('label', { for: 'lz-upload', style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 16px', background: '#1a1a1a', color: '#ffffff', fontSize: '13px', fontWeight: '500', borderRadius: '8px', cursor: 'pointer' } }, 'Upload your own ↑'),
    uploadInput
  ]);
  wrap.appendChild(topRow);

  if (state.photoSource === 'search') {
    const searchInput = el('input', { placeholder: 'Search photos… e.g. woman headset, team laughing', style: { border: 'none', outline: 'none', fontSize: '13px', fontFamily: "'IBM Plex Sans', sans-serif", background: 'transparent', width: '100%', color: '#1a1a1a' } });
    searchInput.value = state.libQuery;
    searchInput.addEventListener('input', e => { state.libQuery = e.target.value; activePresetLabel = null; queueSearch(e.target.value); });

    wrap.appendChild(el('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', flex: 'none' } }, [
      el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 14px', border: '1px solid #e0ddd6', borderRadius: '8px', background: '#ffffff', width: '340px' } }, [
        el('span', { style: { width: '12px', height: '12px', border: '1.5px solid #a09a8e', borderRadius: '50%', flex: 'none' } }),
        searchInput
      ]),
      el('span', { style: { fontSize: '12px', color: '#8a8478' } }, 'Live search across Pexels + Unsplash — aim for bright, warm, people-first shots.')
    ]));

    const presetsRow = el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flex: 'none' } });
    PHOTO_PRESETS.forEach(p => {
      const active = activePresetLabel === p.label;
      presetsRow.appendChild(el('div', {
        style: { padding: '5px 10px', fontSize: '11.5px', fontWeight: '500', border: '1px solid ' + (active ? '#1a1a1a' : '#e0ddd6'), borderRadius: '14px', cursor: 'pointer', background: active ? '#1a1a1a' : '#ffffff', color: active ? '#ffffff' : '#55503f' },
        onClick: () => { const q = p.queries[Math.floor(Math.random() * p.queries.length)]; activePresetLabel = p.label; state.libQuery = ''; searchNow(q); }
      }, p.label));
    });
    wrap.appendChild(presetsRow);
  } else {
    const themesRow = el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flex: 'none' } });
    ['All', ...PHOTO_PRESETS.map(p => p.label)].forEach(theme => {
      const active = state.recTheme === theme;
      themesRow.appendChild(el('div', {
        style: { padding: '5px 10px', fontSize: '11.5px', fontWeight: '500', border: '1px solid ' + (active ? '#1a1a1a' : '#e0ddd6'), borderRadius: '14px', cursor: 'pointer', background: active ? '#1a1a1a' : '#ffffff', color: active ? '#ffffff' : '#55503f' },
        onClick: () => setState({ recTheme: theme })
      }, theme));
    });
    wrap.appendChild(themesRow);
  }
  wrap.appendChild(el('span', { style: { fontSize: '11px', color: '#a09a8e', flex: 'none' } }, 'Style guide: authentic & natural · human-centric & diverse · clean & confident · rooted in the UK'));

  if (state.uploadThumb) {
    wrap.appendChild(el('div', {
      style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 12px', background: '#fffcf5', border: '1.5px solid ' + (state.photoId === 'upload' ? '#1a1a1a' : '#f5c48f'), borderRadius: '8px', cursor: 'pointer', flex: 'none', width: 'fit-content' },
      onClick: () => loadPhoto(state.uploadThumb, 'upload', false)
    }, [
      el('img', { src: state.uploadThumb, style: { height: '52px', borderRadius: '4px' } }),
      el('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } }, [
        el('span', { style: { fontSize: '12px', fontWeight: '600' } }, 'Your upload'),
        el('span', { style: { fontSize: '11px', color: '#8a8478' } }, state.uploadName)
      ])
    ]));
  }

  const gridWrap = el('div', { style: { flex: '1', minHeight: '0', overflowY: 'auto', paddingBottom: '12px' } });
  gridWrap.addEventListener('scroll', () => { gridScrollTop = gridWrap.scrollTop; });
  gridScrollEl = gridWrap;
  const grid = el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px' } });
  const gridItems = state.photoSource === 'curated' ? curatedForView() : results;

  if (state.photoSource === 'search' && state.searching) {
    gridWrap.appendChild(el('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '14px', padding: '80px 0' } }, [
      el('span', { style: { width: '30px', height: '30px', border: '3px solid #e8e6e1', borderTopColor: '#e8590c', borderRadius: '50%', animation: 'lzspin .8s linear infinite' } }),
      el('span', { style: { fontSize: '13px', color: '#55503f' } }, 'Searching Pexels + Unsplash…')
    ]));
    wrap.appendChild(gridWrap);
    return wrap;
  }

  if (state.photoSource === 'curated' && gridItems.length === 0) {
    gridWrap.appendChild(el('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', padding: '48px 0', color: '#8a8478', fontSize: '13px' } }, [
      el('span', {}, 'No curated photos in this orientation/theme yet — try Search instead.')
    ]));
  }
  gridItems.forEach(it => {
    const label = it.alt + ' · ' + it.provider;
    const outline = state.photoId === it.id ? '#1a1a1a' : 'transparent';
    const thumbImg = el('img', { src: it.thumb, alt: label, style: { width: '100%', height: '172px', objectFit: 'cover', display: 'block', opacity: '0', transition: 'opacity .2s' } });
    thumbImg.addEventListener('load', () => { thumbImg.style.opacity = '1'; });
    const previewBtn = el('div', {
      style: { position: 'absolute', top: '8px', right: '8px', width: '26px', height: '26px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(26,26,26,.65)', borderRadius: '6px', cursor: 'pointer', color: '#ffffff', fontSize: '13px' },
      onClick: e => { e.stopPropagation(); previewingPhoto = it; render(); }
    }, '⤢');
    grid.appendChild(el('div', {
      style: { position: 'relative', cursor: 'pointer', borderRadius: '6px', overflow: 'hidden', outline: '2.5px solid ' + outline, outlineOffset: '-2.5px', background: '#e8e6e1' },
      onClick: () => loadPhoto(it.full, it.id, true)
    }, [
      thumbImg,
      previewBtn,
      el('span', { style: { position: 'absolute', left: '8px', right: '8px', bottom: '8px', padding: '3px 8px', fontSize: '10.5px', background: 'rgba(255,255,255,.92)', borderRadius: '4px', color: '#55503f', display: '-webkit-box', WebkitLineClamp: '2', WebkitBoxOrient: 'vertical', overflow: 'hidden' } }, label)
    ]));
  });
  gridWrap.appendChild(grid);

  if (state.photoSource === 'search' && (pexelsHasMore || unsplashHasMore)) {
    gridWrap.appendChild(el('div', { style: { display: 'flex', justifyContent: 'center', padding: '16px 0' } }, [
      el('div', {
        style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '9px 18px', fontSize: '12.5px', fontWeight: '500', border: '1px solid #e0ddd6', borderRadius: '8px', cursor: state.loadingMore ? 'default' : 'pointer', background: '#ffffff', color: state.loadingMore ? '#a09a8e' : '#1a1a1a' },
        onClick: () => loadMore()
      }, state.loadingMore
        ? [el('span', { style: { width: '12px', height: '12px', border: '2px solid #e8e6e1', borderTopColor: '#a09a8e', borderRadius: '50%', animation: 'lzspin .8s linear infinite' } }), 'Loading…']
        : 'Load more photos')
    ]));
  }

  wrap.appendChild(gridWrap);
  return wrap;
}

// ---------- step 3 · cutout ----------
function renderStep3() {
  const wrap = el('div', { style: { flex: '1', display: 'flex', flexDirection: 'column', minHeight: '0' } });
  const canvasArea = el('div', { style: { flex: '1', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '22px 28px 10px', minHeight: '0', position: 'relative' } });
  const canvas = el('canvas', { style: { maxWidth: '100%', maxHeight: '100%', boxShadow: '0 8px 32px rgba(26,20,10,.14)', borderRadius: '2px', touchAction: 'none' } });
  c3 = canvas;
  canvasArea.appendChild(canvas);

  if (state.segStatus === 'loading') {
    canvasArea.appendChild(el('div', { style: { position: 'absolute', inset: '0', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '14px', background: 'rgba(250,250,248,.88)' } }, [
      el('span', { style: { width: '30px', height: '30px', border: '3px solid #e8e6e1', borderTopColor: '#e8590c', borderRadius: '50%', animation: 'lzspin .8s linear infinite' } }),
      el('span', { style: { fontSize: '13px', color: '#55503f' } }, state.segMessage)
    ]));
  }
  if (state.segStatus === 'error') {
    canvasArea.appendChild(el('div', { style: { position: 'absolute', inset: '0', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', background: 'rgba(250,250,248,.92)' } }, [
      el('span', { style: { fontSize: '13px', color: '#c92a2a', maxWidth: '380px', textAlign: 'center' } }, "Couldn't load the cutout model (network). You can retry, or continue — the swirl will sit on top of the photo instead of behind the subject."),
      el('div', { style: { display: 'flex', gap: '10px' } }, [
        el('div', { style: { padding: '9px 16px', background: '#1a1a1a', color: '#fff', fontSize: '12.5px', fontWeight: '500', borderRadius: '7px', cursor: 'pointer' }, onClick: () => runSeg() }, 'Retry'),
        el('div', { style: { padding: '9px 16px', border: '1px solid #e0ddd6', fontSize: '12.5px', borderRadius: '7px', cursor: 'pointer', background: '#fff' }, onClick: () => setState({ segStatus: 'skipped', step: 4, maxStep: Math.max(state.maxStep, 4) }) }, 'Continue without cutout')
      ])
    ]));
  }
  wrap.appendChild(canvasArea);

  const toolbarWrap = el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '10px 24px 18px', flex: 'none' } });
  const toolbar = el('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 16px', background: '#ffffff', border: '1px solid #e8e6e1', borderRadius: '12px', boxShadow: '0 4px 18px rgba(26,20,10,.07)' } });

  toolbar.appendChild(el('div', { style: { display: 'flex', gap: '2px', background: '#f1efe9', borderRadius: '7px', padding: '2px' } }, [
    el('div', { style: { padding: '6px 12px', fontSize: '12px', fontWeight: '500', borderRadius: '5px', cursor: 'pointer', background: state.view === 'cutout' ? '#ffffff' : 'transparent', boxShadow: state.view === 'cutout' ? '0 1px 2px rgba(0,0,0,.1)' : 'none', color: state.view === 'cutout' ? '#1a1a1a' : '#8a8478' }, onClick: () => setState({ view: 'cutout' }) }, 'Cutout'),
    el('div', { style: { padding: '6px 12px', fontSize: '12px', fontWeight: '500', borderRadius: '5px', cursor: 'pointer', background: state.view === 'original' ? '#ffffff' : 'transparent', boxShadow: state.view === 'original' ? '0 1px 2px rgba(0,0,0,.1)' : 'none', color: state.view === 'original' ? '#1a1a1a' : '#8a8478' }, onClick: () => setState({ view: 'original' }) }, 'Original')
  ]));
  toolbarWrap.appendChild(toolbar);
  wrap.appendChild(toolbarWrap);
  return wrap;
}

// ---------- step 4 · swirl ----------
function renderStep4() {
  const wrap = el('div', { style: { flex: '1', display: 'flex', flexDirection: 'column', minHeight: '0' } });
  const canvasArea = el('div', { style: { flex: '1', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '22px 28px 10px', minHeight: '0' } });
  const canvas = el('canvas', { style: { maxWidth: '100%', maxHeight: '100%', boxShadow: '0 8px 32px rgba(26,20,10,.14)', borderRadius: '2px', cursor: state.lassoMode ? 'crosshair' : 'grab', touchAction: 'none' } });
  c4 = canvas;
  let dragOffsetX = 0, dragOffsetY = 0;
  const swirlHitRadius = r => {
    const sw = swirls[state.swirlIdx];
    if (!sw || !sw.naturalWidth) return 50;
    const tw = state.swScale * r.width * 0.9, thh = tw * (sw.naturalHeight / sw.naturalWidth);
    return Math.max(tw, thh) / 2;
  };
  canvas.addEventListener('pointerdown', e => {
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    if (state.lassoMode) {
      lassoPoints.push({ x: px, y: py });
      paint4();
      return;
    }
    const cx = state.swx * r.width, cy = state.swy * r.height;
    if (Math.hypot(px - cx, py - cy) > swirlHitRadius(r)) return; // only grab the swirl itself, not anywhere on canvas
    _draggingSwirl = true;
    canvas.setPointerCapture(e.pointerId);
    dragOffsetX = px - cx; dragOffsetY = py - cy; // preserve the exact point you grabbed — no snapping
  });
  canvas.addEventListener('pointermove', e => {
    if (!_draggingSwirl || state.lassoMode) return;
    const r = canvas.getBoundingClientRect();
    state.swx = ((e.clientX - r.left) - dragOffsetX) / r.width;
    state.swy = ((e.clientY - r.top) - dragOffsetY) / r.height;
    paint4();
  });
  canvas.addEventListener('pointerup', () => { _draggingSwirl = false; });
  canvas.addEventListener('dblclick', () => {
    if (!state.lassoMode || lassoPoints.length < 3) return;
    const r = canvas.getBoundingClientRect();
    const poly = lassoPoints.map(p => canvasPtToSwirlFraction(p.x, p.y, r.width, r.height)).filter(Boolean);
    if (poly.length >= 3) swEraseMask.push(poly);
    lassoPoints = [];
    paint4();
  });
  canvasArea.appendChild(canvas);
  wrap.appendChild(canvasArea);

  const toolbarWrap = el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', padding: '10px 24px 18px', flex: 'none' } });
  const toolbar = el('div', { style: { display: 'flex', alignItems: 'center', gap: '11px', padding: '12px 16px', background: '#ffffff', border: '1px solid #e8e6e1', borderRadius: '12px', boxShadow: '0 4px 18px rgba(26,20,10,.07)' } });

  [0, 1, 2, 3].forEach(i => {
    const outline = state.swirlIdx === i ? '#1a1a1a' : 'transparent';
    toolbar.appendChild(el('div', {
      style: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '62px', height: '38px', background: '#f7f5f0', borderRadius: '6px', cursor: 'pointer', outline: '2px solid ' + outline, outlineOffset: '-2px' },
      onClick: () => setState({ swirlIdx: i })
    }, [el('img', { src: 'assets/swirl-0' + (i + 1) + '.png', style: { width: '76%', height: 'auto' } })]));
  });
  toolbar.appendChild(el('span', { style: { width: '1px', height: '26px', background: '#e8e6e1' } }));
  toolbar.appendChild(el('span', { style: { fontSize: '11.5px', color: '#8a8478' } }, 'Scale'));
  const scaleInput = el('input', { type: 'range', min: '0.2', max: '5', step: '0.01', style: { width: '100px' } });
  scaleInput.value = state.swScale;
  scaleInput.addEventListener('input', e => { state.swScale = +e.target.value; paint4(); });
  toolbar.appendChild(scaleInput);
  toolbar.appendChild(el('span', { style: { fontSize: '11.5px', color: '#8a8478' } }, 'Rotate'));
  const rotateBy = delta => {
    let r = state.swRot + delta;
    if (r > 180) r -= 360;
    if (r < -180) r += 360;
    setState({ swRot: r });
  };
  toolbar.appendChild(el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '30px', height: '30px', border: '1px solid #e0ddd6', borderRadius: '6px', cursor: 'pointer', fontSize: '15px', background: '#ffffff' }, onClick: () => rotateBy(-90) }, '↺'));
  toolbar.appendChild(el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '30px', height: '30px', border: '1px solid #e0ddd6', borderRadius: '6px', cursor: 'pointer', fontSize: '15px', background: '#ffffff' }, onClick: () => rotateBy(90) }, '↻'));

  const fH = seg2(state.swFlipH), fV = seg2(state.swFlipV);
  toolbar.appendChild(el('div', { style: { padding: '6px 11px', fontSize: '12px', fontWeight: '500', border: '1px solid ' + fH.border, background: fH.bg === '#1a1a1a' ? '#f1efe9' : '#ffffff', borderRadius: '6px', cursor: 'pointer' }, onClick: () => setState({ swFlipH: !state.swFlipH }) }, 'Flip H'));
  toolbar.appendChild(el('div', { style: { padding: '6px 11px', fontSize: '12px', fontWeight: '500', border: '1px solid ' + fV.border, background: fV.bg === '#1a1a1a' ? '#f1efe9' : '#ffffff', borderRadius: '6px', cursor: 'pointer' }, onClick: () => setState({ swFlipV: !state.swFlipV }) }, 'Flip V'));
  toolbar.appendChild(el('div', { style: { padding: '6px 11px', fontSize: '12px', fontWeight: '500', color: '#8a8478', cursor: 'pointer', borderRadius: '6px' }, onClick: () => setState({ swScale: 1.05, swRot: 0 }) }, 'Reset'));
  toolbar.appendChild(el('span', { style: { width: '1px', height: '26px', background: '#e8e6e1' } }));

  toolbar.appendChild(el('span', { style: { fontSize: '11.5px', color: '#8a8478' } }, 'Soften edge'));
  const featherInput = el('input', { type: 'range', min: '0.005', max: '0.3', step: '0.005', style: { width: '90px' } });
  featherInput.value = state.feather;
  featherInput.addEventListener('input', e => { state.feather = +e.target.value; scheduleRecompute(); });
  toolbar.appendChild(featherInput);
  toolbar.appendChild(el('span', { style: { width: '1px', height: '26px', background: '#e8e6e1' } }));

  const lassoOn = seg2(state.lassoMode);
  toolbar.appendChild(el('div', {
    style: { padding: '6px 11px', fontSize: '12px', fontWeight: '500', border: '1px solid ' + lassoOn.border, background: lassoOn.bg === '#1a1a1a' ? '#f1efe9' : '#ffffff', borderRadius: '6px', cursor: 'pointer' },
    onClick: () => { lassoPoints = []; setState({ lassoMode: !state.lassoMode }); }
  }, '✂ Lasso'));
  toolbar.appendChild(el('div', {
    style: { padding: '6px 11px', fontSize: '12px', fontWeight: '500', color: swEraseMask.length ? '#1a1a1a' : '#c5c0b4', cursor: swEraseMask.length ? 'pointer' : 'default', borderRadius: '6px', border: '1px solid #e0ddd6' },
    onClick: () => { if (swEraseMask.length) { swEraseMask.pop(); paint4(); } }
  }, '↩ Undo'));
  toolbar.appendChild(el('span', { style: { width: '1px', height: '26px', background: '#e8e6e1' } }));
  toolbar.appendChild(el('span', { style: { fontSize: '11.5px', color: '#e8590c', fontWeight: '500' } }, state.lassoMode ? 'Click to place points, double-click to close the shape' : 'Drag the swirl on canvas ⌖'));

  toolbarWrap.appendChild(toolbar);
  wrap.appendChild(toolbarWrap);
  return wrap;
}

// ---------- step 5 · export ----------
function renderStep5() {
  const wrap = el('div', { style: { flex: '1', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '36px', minHeight: '0', padding: '24px 32px' } });
  const canvas = el('canvas', { style: { maxWidth: '100%', maxHeight: '100%', boxShadow: '0 8px 32px rgba(26,20,10,.14)', borderRadius: '2px' } });
  c5 = canvas;
  wrap.appendChild(el('div', { style: { flex: '1', maxWidth: '760px', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '0', height: '100%' } }, [canvas]));

  const b = baseSize();
  const panel = el('div', { style: { width: '300px', display: 'flex', flexDirection: 'column', gap: '18px', flex: 'none' } });
  panel.appendChild(el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } }, [
    el('span', { style: { fontSize: '17px', fontWeight: '600' } }, 'Export'),
    el('span', { style: { font: "500 11.5px 'IBM Plex Mono', monospace", color: '#8a8478' } }, (b.w * state.exportScale) + ' × ' + (b.h * state.exportScale) + ' px · ' + state.exportFmt.toUpperCase())
  ]));

  const sc1 = seg2(state.exportScale === 1), sc2 = seg2(state.exportScale === 2);
  panel.appendChild(el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, [
    el('span', { style: { fontSize: '11px', fontWeight: '600', letterSpacing: '.06em', color: '#8a8478' } }, 'SCALE'),
    el('div', { style: { display: 'flex', gap: '6px' } }, [
      el('div', { style: { flex: '1', textAlign: 'center', padding: '9px 0', fontSize: '12.5px', fontWeight: '500', border: '1.5px solid ' + sc1.border, background: sc1.bg === '#1a1a1a' ? '#f1efe9' : '#ffffff', borderRadius: '7px', cursor: 'pointer' }, onClick: () => setState({ exportScale: 1 }) }, '1×'),
      el('div', { style: { flex: '1', textAlign: 'center', padding: '9px 0', fontSize: '12.5px', fontWeight: '500', border: '1.5px solid ' + sc2.border, background: sc2.bg === '#1a1a1a' ? '#f1efe9' : '#ffffff', borderRadius: '7px', cursor: 'pointer' }, onClick: () => setState({ exportScale: 2 }) }, '2×')
    ])
  ]));

  const exportBtn = el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '13px 0', background: '#1a1a1a', color: '#ffffff', fontSize: '14px', fontWeight: '500', borderRadius: '9px', cursor: 'pointer' }, onClick: () => doExportNow() }, 'Download ' + state.exportFmt.toUpperCase() + ' ↓');
  exportBtn.addEventListener('mouseenter', () => { exportBtn.style.background = '#333'; });
  exportBtn.addEventListener('mouseleave', () => { exportBtn.style.background = '#1a1a1a'; });
  panel.appendChild(exportBtn);

  panel.appendChild(el('span', { style: { fontSize: '11.5px', color: '#8a8478', lineHeight: '1.5' } }, ['Need another size? Jump back to ', el('b', {}, 'Size'), ' in the top bar — your photo, cutout and swirl carry over.']));

  wrap.appendChild(panel);
  return wrap;
}

function renderStepBody() {
  switch (state.step) {
    case 1: return renderStep1();
    case 2: return renderStep2();
    case 3: return renderStep3();
    case 4: return renderStep4();
    case 5: return renderStep5();
    default: return el('div');
  }
}

// ---------- root render ----------
function render() {
  root.innerHTML = '';
  const wrap = el('div', { style: { display: 'flex', flexDirection: 'column', height: '100vh', background: '#fafaf8' } });
  wrap.appendChild(renderTopBar());
  wrap.appendChild(renderStepBody());
  wrap.appendChild(renderBottomBar());
  root.appendChild(wrap);
  if (state.step === 2 && gridScrollEl) gridScrollEl.scrollTop = gridScrollTop;
  if (previewingPhoto) root.appendChild(renderPreviewModal());
  paintCurrent();
}

function renderPreviewModal() {
  const it = previewingPhoto;
  const close = () => { previewingPhoto = null; render(); };
  const backdrop = el('div', {
    style: { position: 'fixed', inset: '0', background: 'rgba(20,18,14,.82)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: '1000', padding: '40px' },
    onClick: close
  }, [
    el('div', { style: { position: 'relative', maxWidth: '90vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px' }, onClick: e => e.stopPropagation() }, [
      el('img', { src: it.full, style: { maxWidth: '90vw', maxHeight: '76vh', borderRadius: '4px', boxShadow: '0 20px 60px rgba(0,0,0,.4)', display: 'block' } }),
      el('div', { style: { display: 'flex', alignItems: 'center', gap: '14px' } }, [
        el('span', { style: { fontSize: '12.5px', color: '#f1efe9' } }, it.alt + ' · ' + it.provider),
        el('div', { style: { padding: '9px 18px', background: '#1a1a1a', color: '#fff', fontSize: '12.5px', fontWeight: '500', borderRadius: '7px', cursor: 'pointer' }, onClick: () => { loadPhoto(it.full, it.id, true); close(); } }, 'Use this photo'),
        el('div', { style: { padding: '9px 18px', border: '1px solid #8a8478', color: '#f1efe9', fontSize: '12.5px', borderRadius: '7px', cursor: 'pointer' }, onClick: close }, 'Close')
      ])
    ])
  ]);
  return backdrop;
}

// ---------- init ----------
function init() {
  swirls = [1, 2, 3, 4].map(n => {
    const im = new Image();
    im.src = 'assets/swirl-0' + n + '.png';
    im.onload = () => paintCurrent();
    return im;
  });
  activePresetLabel = PHOTO_PRESETS[0].label;
  searchNow(PHOTO_PRESETS[0].queries[Math.floor(Math.random() * PHOTO_PRESETS[0].queries.length)]);
  render();
}

init();
