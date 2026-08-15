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

// ── Provider: rophim1 ──────────────────────────────────────

// RoPhim1 | Get Stream URL Resolver — v3
// Contract: getStreamUrl(episodeUrl) → JSON { type, url, headers, ads? } | { error }
// Source:
// - watch page /xem-phim/{slug}.{episodeId}
// - embed page https://api.<host>/embed/{episodeId}
// - encrypted HLS URL in embed payload, decrypted with XOR key `mySecretKey2024`


async function getStreamUrl(episodeUrl) {
  const SITE_BASE = resolveSiteBase(episodeUrl);
  if (!SITE_BASE) {
    return JSON.stringify({ error: 'Cannot resolve site base from episodeUrl' });
  }

  const API_ORIGIN = buildApiOrigin(SITE_BASE);
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

  function buildFetchOptions(refererUrl) {
    return {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Referer': refererUrl || SITE_BASE + '/',
        'Origin': SITE_BASE,
      },
    };
  }

  async function fetchHtml(url, refererUrl) {
    const res = await fetch(url, buildFetchOptions(refererUrl || SITE_BASE + '/'));
    if (!res.ok) {
      throw new Error(`Fetch failed ${res.status}: ${url}`);
    }
    return res.text();
  }

  function extractFirstM3u8(html) {
    const match = html.match(/https?:\/\/[^\s"'><\\]+\.m3u8[^\s"'><\\]*/i);
    return match ? match[0].replace(/\\/g, '') : '';
  }

  function extractIframeSrc(html) {
    const normalized = html.replace(/\\"/g, '"');
    const match = normalized.match(/<iframe[^>]+src="([^"]+)"/i);
    if (!match) return '';
    try {
      return new URL(match[1], SITE_BASE).href;
    } catch (_e) {
      return match[1];
    }
  }

  function extractEncryptedUrl(html) {
    const normalized = html.replace(/\\"/g, '"');
    const patterns = [
      /"encrypted_url":"([^"]+)"/i,
      /encrypted_url\s*:\s*"([^"]+)"/i,
      /encrypted_url\s*=\s*"([^"]+)"/i,
      /episode\[[^\]]+\]\s*=\s*"([^"]+)"/i,
    ];

    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (match) {
        return match[1];
      }
    }
    return '';
  }

  function hexXorDecrypt(cipherHex, secretKey) {
    let out = '';
    for (let i = 0; i < cipherHex.length; i += 2) {
      const cipherByte = parseInt(cipherHex.substr(i, 2), 16);
      const keyByte = secretKey.charCodeAt((i / 2) % secretKey.length);
      out += String.fromCharCode(cipherByte ^ keyByte);
    }
    return out;
  }

  try {
    console.log('[KENG][RoPhim1] getStreamUrl: ' + episodeUrl);

    if (episodeUrl.includes('.m3u8')) {
      const result = await makeStreamM3U8Result(episodeUrl, '');
      console.log('[KENG][RoPhim1] Direct m3u8, ads=' + (result.ads === null ? 'null' : (result.ads ? result.ads.length : 0)));
      return JSON.stringify(result);
    }

    const watchHtml = await fetchHtml(episodeUrl, SITE_BASE + '/');
    const directFromWatch = extractFirstM3u8(watchHtml);
    if (directFromWatch) {
      const referer = SITE_BASE + '/';
      const result = await makeStreamM3U8Result(directFromWatch, referer);
      console.log('[KENG][RoPhim1] Stream result: ads=' + (result.ads === null ? 'null' : (result.ads ? result.ads.length : 0)));
      return JSON.stringify(result);
    }

    const episodeIdMatch = episodeUrl.match(/\.(\d+)$/);
    const iframeUrl = extractIframeSrc(watchHtml);
    const embedUrl = iframeUrl || (episodeIdMatch ? `${API_ORIGIN}/embed/${episodeIdMatch[1]}` : '');
    if (!embedUrl) {
      throw new Error('Cannot determine embed URL');
    }

    const embedHtml = await fetchHtml(embedUrl, episodeUrl);
    const directFromEmbed = extractFirstM3u8(embedHtml);
    if (directFromEmbed) {
      const referer = embedUrl;
      const result = await makeStreamM3U8Result(directFromEmbed, referer);
      console.log('[KENG][RoPhim1] Stream result: ads=' + (result.ads === null ? 'null' : (result.ads ? result.ads.length : 0)));
      return JSON.stringify(result);
    }

    const encryptedUrl = extractEncryptedUrl(embedHtml);
    if (!encryptedUrl) {
      throw new Error('No encrypted_url found in embed page');
    }

    const streamUrl = hexXorDecrypt(encryptedUrl, 'mySecretKey2024');
    if (!/^https?:\/\//i.test(streamUrl)) {
      throw new Error('Decrypted stream URL is invalid');
    }

    const referer = embedUrl;
    const result = await makeStreamM3U8Result(streamUrl, referer);
    console.log('[KENG][RoPhim1] Stream result: ads=' + (result.ads === null ? 'null' : (result.ads ? result.ads.length : 0)));
    return JSON.stringify(result);
  } catch (e) {
    console.log('[KENG][RoPhim1] getStreamUrl error: ' + e.message);
    return JSON.stringify({ error: e.message });
  }
}

function resolveSiteBase(url) {
  const siteMatch = String(url || '').match(/^(https?:\/\/[^/]+)/);
  if (siteMatch) return siteMatch[1];
  if (typeof location !== 'undefined' && location.origin) return location.origin;
  return '';
}

function buildApiOrigin(siteBase) {
  try {
    const parsed = new URL(siteBase);
    return parsed.protocol + '//api.' + parsed.hostname;
  } catch (_e) {
    return '';
  }
}
