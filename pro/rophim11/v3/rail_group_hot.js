/**
 * Keng Common JS — shared utilities injected before each provider's resolver.
 * Keep this file self-contained; it will be prepended to provider JS at deploy time.
 *
 * Contract: all functions are available in provider resolvers via normal JS scoping.
 */

// ── HLS Ad Detection ────────────────────────────────────────────────────────
// Parse HLS variant playlist for SSAI ad segments.
// Detects ad patterns in HLS segment URLs:
//   - /adjump/ URLs
//   - /vN/ prefix with segment_XXX.ts (numbered SSAI ad segments, any version)
//
// NOTE: every clause must evaluate to a boolean. Never compare a .test() result
// against -1 — `-1 !== false` is true, which classifies every segment as an ad
// and makes the whole movie look like one giant ad break.
//
// `convertvN/` was removed 2026-08-15: it is a FALSE POSITIVE. On
// s5.phim1280.tv those segments carry the same random 8-char names as the
// content around them, sit in a playlist with zero /adjump/ segments, and were
// confirmed on-device to be ordinary film — they are re-transcoded segments,
// and the #EXT-X-DISCONTINUITY around them marks an encoder change, not an ad
// break. Flagging them cut ~25s of real movie out of a single title.
//
// Bias: a false positive removes film the user paid attention to; a false
// negative merely shows an ad. Prefer missing an ad over cutting content.
function _isAdSegment(segment) {
  return segment.indexOf('/adjump/') !== -1
      || /^\/v\d+\/.*segment_/.test(segment);
}

function parseAdsFromPlaylist(playlistText) {
  var ads = [];
  var lines = playlistText.split('\n');
  var cumulative = 0.0;
  var adStart = null;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line.indexOf('#EXTINF:') !== 0) continue;

    var match = line.match(/#EXTINF:([\d.]+)/);
    if (!match) continue;
    var duration = parseFloat(match[1]);
    if (isNaN(duration)) continue;

    var segment = (lines[i + 1] || '').trim();

    if (_isAdSegment(segment)) {
      if (adStart === null) adStart = cumulative;
    } else {
      if (adStart !== null) {
        ads.push({
          start: Math.round(adStart * 100) / 100,
          end: Math.round(cumulative * 100) / 100,
          duration: Math.round((cumulative - adStart) * 100) / 100,
        });
        adStart = null;
      }
    }
    cumulative += duration;
  }

  if (adStart !== null) {
    ads.push({
      start: Math.round(adStart * 100) / 100,
      end: Math.round(cumulative * 100) / 100,
      duration: Math.round((cumulative - adStart) * 100) / 100,
    });
  }

  return ads;
}

// Total playable duration of a playlist, in seconds.
function _playlistTotalDuration(playlistText) {
  var lines = playlistText.split('\n');
  var total = 0.0;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line.indexOf('#EXTINF:') !== 0) continue;
    var match = line.match(/#EXTINF:([\d.]+)/);
    if (!match) continue;
    var d = parseFloat(match[1]);
    if (!isNaN(d)) total += d;
  }
  return Math.round(total * 100) / 100;
}

// Sanity-checked ad detection.
// Returns an array of ad zones, or null when the result looks bogus — a
// mis-classifying detector would otherwise report the entire movie as one ad
// zone and the player would seek straight to the end.
//
// null means "detection not trustworthy" and is distinct from [] ("no ads"),
// which the Dart side relies on (see StreamResult.ads).
function detectAdsSafe(playlistText) {
  var total = _playlistTotalDuration(playlistText);
  if (total <= 0) return null;

  var ads = parseAdsFromPlaylist(playlistText);
  if (ads.length === 0) return [];

  var adTotal = 0.0;
  for (var i = 0; i < ads.length; i++) adTotal += ads[i].duration;

  // Guard 1 — ads covering (nearly) the whole playlist is a detector failure,
  // not a real stream.
  if (adTotal >= total * 0.8) {
    console.log('[KENG][common] Ads rejected: ' + adTotal + 's of ' + total + 's (>=80%) — treating as detection failure');
    return null;
  }

  // Guard 2 — a single zone spanning start to end, same failure shape.
  if (ads.length === 1 && ads[0].start <= 0.01 && ads[0].end >= total - 0.01) {
    console.log('[KENG][common] Ads rejected: single zone spans whole playlist');
    return null;
  }

  return ads;
}

function _isMasterPlaylist(playlistText) {
  return playlistText.indexOf('#EXT-X-STREAM-INF') !== -1;
}

// Resolve a possibly-relative playlist reference against its base URL.
// Handles absolute, root-relative, protocol-relative and plain relative paths.
function _resolveUrl(ref, baseUrl) {
  try {
    return new URL(ref, baseUrl).href;
  } catch (_e) {
    return ref;
  }
}

// First variant URI declared in a master playlist, or '' if none.
function _firstVariantPath(masterText) {
  var lines = masterText.split('\n');
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].trim().indexOf('#EXT-X-STREAM-INF') !== 0) continue;
    for (var j = i + 1; j < lines.length; j++) {
      var t = lines[j].trim();
      if (!t) continue;
      if (t.charAt(0) === '#') continue;
      return t;
    }
  }
  return '';
}

// PA-class CDN. These are served as a master playlist whose variant URL must be
// handed to the player directly — established behaviour, keep it.
// Every other CDN keeps its original URL so the player can still do ABR.
function _isPaCdn(url) {
  return url.indexOf('kkphimplayer') !== -1 || url.indexOf('phim1280.tv') !== -1;
}

function _kengFetchText(url, headers, timeoutMs) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
  return fetch(url, { headers: headers, signal: controller.signal })
    .then(function (resp) {
      clearTimeout(timer);
      if (!resp.ok) return null;
      return resp.text();
    })
    .catch(function () {
      clearTimeout(timer);
      return null;
    });
}

// Fetch + resolve m3u8 → ad-annotated stream result.
// Works on any CDN: detection is driven by playlist content, not by domain.
// Returns { type, url, headers, ads } or null on failure.
async function resolveAdsVariant(m3u8Url, referer) {
  var kengUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
  var origin;
  try { origin = new URL(m3u8Url).origin; } catch (_e) { origin = ''; }

  var reqHeaders = {
    'User-Agent': kengUA,
    'Accept': '*/*',
    'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': referer || origin + '/',
    'Origin': origin || '',
  };

  try {
    var firstText = await _kengFetchText(m3u8Url, reqHeaders, 2000);
    if (firstText === null) return null;

    var mediaText = firstText;
    var variantUrl = m3u8Url;

    if (_isMasterPlaylist(firstText)) {
      var variantPath = _firstVariantPath(firstText);
      if (!variantPath) return null;
      variantUrl = _resolveUrl(variantPath, m3u8Url);

      var variantText = await _kengFetchText(variantUrl, reqHeaders, 2000);
      if (variantText === null) {
        // Variant unreachable — still playable, just without ad info.
        mediaText = '';
      } else {
        mediaText = variantText;
      }
    }
    // else: m3u8Url is already a media playlist — parse it directly and never
    // mistake its first segment (.ts) for a variant URL.

    var ads = mediaText ? detectAdsSafe(mediaText) : null;
    if (ads && ads.length > 0) {
      console.log('[KENG][common] Ads detected: ' + JSON.stringify(ads));
    }

    // PA needs the resolved variant URL; everyone else keeps the original so
    // the player retains adaptive bitrate across renditions.
    var outUrl = _isPaCdn(m3u8Url) ? variantUrl : m3u8Url;

    console.log('[KENG][common] Stream resolved: ' + outUrl + ' | ads=' + (ads === null ? 'null' : ads.length));
    return {
      type: 'm3u8',
      url: outUrl,
      headers: { 'Referer': referer, 'User-Agent': kengUA },
      ads: ads,
    };
  } catch (e) {
    return null;
  }
}

// Main entry: probe the playlist for SSAI ads → build result.
// Usage: var result = await makeStreamM3U8Result(m3u8Url, referer);
async function makeStreamM3U8Result(m3u8Url, referer) {
  var kengUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
  var result = await resolveAdsVariant(m3u8Url, referer);
  if (result) return result;

  console.log('[KENG][common] Ad probe failed, falling back to original URL');
  return {
    type: 'm3u8',
    url: m3u8Url,
    headers: { 'Referer': referer, 'User-Agent': kengUA },
  };
}

// ── Provider: rophim11 ──────────────────────────────────────

async function railGroupHot(baseUrl) {
  const SITE_BASE = baseUrl;
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

  function buildFetchOptions(refererUrl) {
    return {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Referer': refererUrl || SITE_BASE + '/',
        'Origin': SITE_BASE,
      },
    };
  }

  function cleanText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
  }

  function decodeHtml(text) {
    return String(text ?? '')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#8211;/g, '-')
      .replace(/&nbsp;/g, ' ')
      .trim();
  }

  function normalizeUrl(url) {
    const text = cleanText(url);
    if (!text) return '';
    if (/^https?:\/\//i.test(text)) return text;
    return SITE_BASE + (text.startsWith('/') ? text : '/' + text);
  }

  function extractMovies(html) {
    const cards = [];
    const seen = new Set();
    const re = /<div class="sw-item"([\s\S]*?)<\/div>\s*<\/div>/g;
    let match;
    while ((match = re.exec(html)) !== null) {
      const block = match[0];
      const attr = (name) => {
        const m = block.match(new RegExp(name + '="([^"]*)"', 'i'));
        return m ? m[1] : '';
      };
      const hrefMatch = block.match(/<a href="([^"]+)" class="v-thumbnail">/i);
      const href = hrefMatch ? normalizeUrl(hrefMatch[1]) : '';
      const title = cleanText(attr('data-title'));
      const alias = cleanText(attr('data-alias'));
      const poster = normalizeUrl(attr('data-poster') || attr('data-thumb'));
      const thumbnail = normalizeUrl(attr('data-thumb') || attr('data-poster'));
      if (!href || !title || !poster) continue;
      const key = href.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const quality = cleanText(attr('data-quality'));
      const lang = cleanText(attr('data-lang'));
      const episode = cleanText(attr('data-episode'));
      const type = cleanText(attr('data-type')).toLowerCase();
      let genres = [];
      try {
        const parsed = JSON.parse(decodeHtml(attr('data-genres') || '[]'));
        if (Array.isArray(parsed)) {
          genres = parsed.map((g) => cleanText(g && g.name ? g.name : g)).filter(Boolean);
        }
      } catch (_e) {
        genres = [];
      }

      cards.push({
        rank: 0,
        title,
        title_original: alias && alias !== title ? alias : '',
        poster_url: poster,
        thumbnail_url: thumbnail || poster,
        url: href,
        media_type: type.includes('series') || type.includes('tv') ? 'series' : 'movie',
        badge_text: [quality, lang, episode].filter(Boolean).join(' • '),
        badge_sub: '',
        year: cleanText(attr('data-year')),
        rating: cleanText(attr('data-imdb')),
        synopsis: '',
        age_rating: cleanText(attr('data-content-rating')),
        episode_current: episode,
        genres
      });
    }
    return cards;
  }

  async function fetchRail(url) {
    const response = await fetch(url, buildFetchOptions(SITE_BASE + '/'));
    if (!response.ok) return [];
    const html = await response.text();
    return extractMovies(html);
  }

  async function firstNonEmpty(urls) {
    for (const url of urls) {
      const cards = await fetchRail(url);
      if (cards.length > 0) return cards;
    }
    return [];
  }

  try {
    const movies = await firstNonEmpty([
      `${SITE_BASE}/phim-dang-chieu/?sort=latest&page=1`,
      `${SITE_BASE}/phim-bo/?sort=latest&page=1`,
      `${SITE_BASE}/phim-le/?sort=latest&page=1`
    ]);

    if (movies.length === 0) {
      return JSON.stringify({ error: 'No hot rail found' });
    }

    return JSON.stringify([{
      id: 'phim_hot',
      title: 'Phim đang chiếu',
      subtitle: null,
      card_height_percent: 0.18,
      card_size_ratio: 1.5,
      is_hero_source: true,
      show_rank: false,
      movies: movies.slice(0, 20),
      show_cta: { js_method: 'getAllPhimDangChieu' }
    }]);
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
}

function _rp11HotResolveBaseUrl(baseUrl) {
  return (typeof baseUrl === 'string' && /^https?:\/\//i.test(baseUrl))
    ? baseUrl
    : ((typeof location !== 'undefined' && location.origin) ? location.origin : '');
}

function _rp11HotCleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function _rp11HotDecodeHtml(text) {
  return String(text ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#8211;/g, '-')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function _rp11HotNormalizeUrl(siteBase, url) {
  const text = _rp11HotCleanText(url);
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text;
  return siteBase + (text.startsWith('/') ? text : '/' + text);
}

function _rp11HotExtractMovies(html, siteBase) {
  const cards = [];
  const seen = new Set();
  const re = /<div class="sw-item"([\s\S]*?)<\/div>\s*<\/div>/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    const block = match[0];
    const attr = (name) => {
      const m = block.match(new RegExp(name + '="([^"]*)"', 'i'));
      return m ? m[1] : '';
    };
    const hrefMatch = block.match(/<a href="([^"]+)" class="v-thumbnail">/i);
    const href = hrefMatch ? _rp11HotNormalizeUrl(siteBase, hrefMatch[1]) : '';
    const title = _rp11HotCleanText(attr('data-title'));
    const alias = _rp11HotCleanText(attr('data-alias'));
    const poster = _rp11HotNormalizeUrl(siteBase, attr('data-poster') || attr('data-thumb'));
    const thumbnail = _rp11HotNormalizeUrl(siteBase, attr('data-thumb') || attr('data-poster'));
    if (!href || !title || !poster) continue;
    const key = href.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const quality = _rp11HotCleanText(attr('data-quality'));
    const lang = _rp11HotCleanText(attr('data-lang'));
    const episode = _rp11HotCleanText(attr('data-episode'));
    const type = _rp11HotCleanText(attr('data-type')).toLowerCase();
    let genres = [];
    try {
      const parsed = JSON.parse(_rp11HotDecodeHtml(attr('data-genres') || '[]'));
      if (Array.isArray(parsed)) {
        genres = parsed.map((g) => _rp11HotCleanText(g && g.name ? g.name : g)).filter(Boolean);
      }
    } catch (_e) {
      genres = [];
    }

    cards.push({
      rank: 0,
      title,
      title_original: alias && alias !== title ? alias : '',
      poster_url: thumbnail || poster,
      thumbnail_url: thumbnail || poster,
      url: href,
      media_type: type.includes('series') || type.includes('tv') ? 'series' : 'movie',
      badge_text: [quality, lang, episode].filter(Boolean).join(' • '),
      badge_sub: '',
      year: _rp11HotCleanText(attr('data-year')),
      rating: _rp11HotCleanText(attr('data-imdb')),
      synopsis: '',
      age_rating: _rp11HotCleanText(attr('data-content-rating')),
      episode_current: episode,
      genres
    });
  }
  return cards;
}

async function getAllPhimDangChieu(baseUrl, page = 1) {
  try {
    const siteBase = _rp11HotResolveBaseUrl(baseUrl);
    const url = new URL('/phim-dang-chieu/', siteBase);
    url.searchParams.set('sort', 'latest');
    url.searchParams.set('page', String(Number.parseInt(page || '1', 10) || 1));
    const response = await fetch(url.href, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Referer': siteBase + '/',
        'Origin': siteBase,
      },
    });
    if (!response.ok) return JSON.stringify([]);
    const html = await response.text();
    return JSON.stringify(_rp11HotExtractMovies(html, siteBase).slice(0, 20));
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
}
