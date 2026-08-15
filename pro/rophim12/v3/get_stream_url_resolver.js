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

// ── Provider: rophim12 ──────────────────────────────────────

// Story 10-13 | RoPhim12 | Get Stream URL Resolver — v3
// Contract: getStreamUrl(episodeUrl) → JSON { type, url, headers, ads? } | { error }
//
// Research findings (2026-04-02):
// - No stream API available — all episode stream endpoints require auth
// - Watch page URL: /xem-phim/{slug}.{episodeId} on the active provider origin
// - m3u8 is embedded in HTML of watch page (via opstream90 CDN)
// - Fallback: /embed/{episodeId} on the API origin of the active provider
//
// Input: episodeUrl is the `url` field from episodes resolver server entry


async function getStreamUrl(episodeUrl) {
    const SITE_BASE = resolveSiteBase(episodeUrl);
    if (!SITE_BASE) {
        return JSON.stringify({ error: 'Cannot resolve site base from episodeUrl' });
    }
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
        if (!res.ok) throw new Error('Fetch failed ' + res.status + ': ' + url);
        return res.text();
    }

    function extractFirstM3u8(html) {
        const match = String(html || '').match(/https?:\/\/[^\s"'><\\]+\.m3u8[^\s"'><\\]*/i);
        return match ? match[0].replace(/\\/g, '') : '';
    }

    function decryptUrl(encryptedHex, key = "mySecretKey2024") {
        let decrypted = "";
        for (let i = 0; i < encryptedHex.length; i += 2) {
            let byte = parseInt(encryptedHex.substring(i, i + 2), 16);
            let keyChar = key.charCodeAt((i / 2) % key.length);
            decrypted += String.fromCharCode(byte ^ keyChar);
        }
        return decrypted;
    }

    async function extractEmbedApiBase(html, fallbackDomain) {
        if (!html) return fallbackDomain;
        try {
            // Tìm script NextJS có chứa (phim)/layout- trong src
            const layoutScriptRegex = /src="([^"]*\/app\/\(phim\)\/layout-[^"]*\.js)"/i;
            const match = html.match(layoutScriptRegex);
            if (match && match[1]) {
                let jsUrl = match[1];
                if (jsUrl.startsWith('/')) {
                    jsUrl = SITE_BASE + jsUrl;
                }
                console.log('[KENG][RoPhim12] Found layout JS chunk: ' + jsUrl);
                const jsContent = await fetchHtml(jsUrl, episodeUrl);
                
                // Quét qua các URL chứa api trong JS layout
                const apiDomainRegex = /https?:\/\/[a-zA-Z0-9.-]*api[a-zA-Z0-9.-]*/g;
                const apiMatches = jsContent.match(apiDomainRegex);
                if (apiMatches && apiMatches.length > 0) {
                    const ResolvedBase = apiMatches[0].replace(/\/+$/, '');
                    console.log('[KENG][RoPhim12] Resolved dynamic embed domain: ' + ResolvedBase);
                    return ResolvedBase;
                }
            }
        } catch (err) {
            console.log('[KENG][RoPhim12] Error resolving dynamic embed domain: ' + err.message);
        }
        return fallbackDomain;
    }

    async function tryDecryptEmbed(embedUrl, embedApiBase) {
        let embedHtml = '';
        
        // Phase 1: Thử fetch trực tiếp (hoạt động trong môi trường CLI test/Playwright)
        try {
            console.log('[KENG][RoPhim12] Fetching embed URL directly: ' + embedUrl);
            embedHtml = await fetchHtml(embedUrl, SITE_BASE + '/');
        } catch (e) {
            console.log('[KENG][RoPhim12] Direct fetch failed (likely CORS on client): ' + e.message);
        }
        
        // Phase 2: Thử qua CodeTabs CORS Proxy (hoạt động tốt trên app client thật)
        if (!embedHtml) {
            try {
                const proxyUrl = 'https://api.codetabs.com/v1/proxy/?quest=' + encodeURIComponent(embedUrl);
                console.log('[KENG][RoPhim12] Fetching via CodeTabs proxy: ' + proxyUrl);
                const res = await fetch(proxyUrl, { headers: { 'User-Agent': UA } });
                if (res.ok) {
                    embedHtml = await res.text();
                    console.log('[KENG][RoPhim12] Successfully fetched HTML via CodeTabs proxy');
                } else {
                    console.log('[KENG][RoPhim12] CodeTabs proxy returned status: ' + res.status);
                }
            } catch (e) {
                console.log('[KENG][RoPhim12] CodeTabs proxy failed: ' + e.message);
            }
        }

        // Phase 3: Thử qua AllOrigins CORS Proxy (Dự phòng dự phòng)
        if (!embedHtml) {
            try {
                const proxyUrl = 'https://api.allorigins.win/get?url=' + encodeURIComponent(embedUrl);
                console.log('[KENG][RoPhim12] Fetching via AllOrigins proxy: ' + proxyUrl);
                const res = await fetch(proxyUrl, { headers: { 'User-Agent': UA } });
                if (res.ok) {
                    const json = await res.json();
                    embedHtml = json.contents || '';
                    console.log('[KENG][RoPhim12] Successfully fetched HTML via AllOrigins proxy');
                } else {
                    console.log('[KENG][RoPhim12] AllOrigins proxy returned status: ' + res.status);
                }
            } catch (e) {
                console.log('[KENG][RoPhim12] AllOrigins proxy failed: ' + e.message);
            }
        }
        
        if (embedHtml) {
            // Tìm encrypted_url trong object JSON 'episode'
            const encMatch = embedHtml.match(/"encrypted_url"\s*:\s*"([a-fA-F0-9]+)"/);
            if (encMatch && encMatch[1]) {
                const decrypted = decryptUrl(encMatch[1]);
                if (decrypted && decrypted.includes('.m3u8')) {
                    console.log('[KENG][RoPhim12] Successfully decrypted embed m3u8: ' + decrypted);
                    return decrypted;
                }
            }
        }
        
        console.log('[KENG][RoPhim12] Decrypt embed failed, fallback to raw embed');
        return '';
    }

    function extractIframeSrc() {
        try {
            const iframe =
                document.querySelector('iframe[src*="/embed/"]') ||
                document.querySelector('iframe');
            if (!iframe) {
                return '';
            }

            const src = iframe.getAttribute('src') || iframe.src || '';
            if (!src) {
                return '';
            }

            return new URL(src, SITE_BASE).href;
        } catch (_e) {
            return '';
        }
    }

    try {
        console.log('[KENG][RoPhim12] getStreamUrl: ' + episodeUrl);

        // If input is already a direct m3u8 URL, return immediately
        if (episodeUrl.includes('.m3u8')) {
            const result = await makeStreamM3U8Result(episodeUrl, '');
            console.log('[KENG][RoPhim12] Direct m3u8, ads=' + (result.ads === null ? 'null' : (result.ads ? result.ads.length : 0)));
            return JSON.stringify(result);
        }

        // Strategy 1: Fetch watch page HTML once — check if m3u8 is embedded directly
        let html = '';
        try {
            html = await fetchHtml(episodeUrl, SITE_BASE + '/');
        } catch (fetchErr) {
            console.log('[KENG][RoPhim12] Fetching watch page HTML failed: ' + fetchErr.message);
        }

        if (html) {
            const streamUrl = extractFirstM3u8(html);
            if (streamUrl) {
                console.log('[KENG][RoPhim12] Found m3u8 in watch page: ' + streamUrl);
                const referer = SITE_BASE + '/';
                const result = await makeStreamM3U8Result(streamUrl, referer);
                console.log('[KENG][RoPhim12] Stream result: ads=' + (result.ads === null ? 'null' : (result.ads ? result.ads.length : 0)));
                return JSON.stringify(result);
            }
        }

        // Resolve dynamic embed base URL
        const embedApiBase = await extractEmbedApiBase(html, 'https://rophim-api.clubc.org');

        // Strategy 2: Reuse the hydrated iframe src from the current page DOM.
        const iframeSrc = extractIframeSrc();
        if (iframeSrc) {
            console.log('[KENG][RoPhim12] Found iframe src: ' + iframeSrc);
            if (iframeSrc.includes('/embed/')) {
                const decryptedM3u8 = await tryDecryptEmbed(iframeSrc, embedApiBase);
                if (decryptedM3u8) {
                    const referer = embedApiBase + '/';
                    const result = await makeStreamM3U8Result(decryptedM3u8, referer);
                    console.log('[KENG][RoPhim12] Stream result: ads=' + (result.ads === null ? 'null' : (result.ads ? result.ads.length : 0)));
                    return JSON.stringify(result);
                }
            }
            return JSON.stringify({
                type: 'embed',
                url: iframeSrc,
                headers: {
                    'Referer': SITE_BASE + '/',
                    'User-Agent': UA
                }
            });
        }

        // Strategy 3: Extract episode ID from URL and return the canonical embed page.
        // URL format: .../xem-phim/{slug}.{episodeId}
        const epIdM = episodeUrl.match(/\.(\d+)$/);
        if (epIdM) {
            const episodeId = epIdM[1];
            const directEmbedUrl = embedApiBase + '/embed/' + episodeId;
            console.log('[KENG][RoPhim12] Resolving direct embed: ' + directEmbedUrl);
            
            const decryptedM3u8 = await tryDecryptEmbed(directEmbedUrl, embedApiBase);
            if (decryptedM3u8) {
                const referer = embedApiBase + '/';
                const result = await makeStreamM3U8Result(decryptedM3u8, referer);
                console.log('[KENG][RoPhim12] Stream result: ads=' + (result.ads === null ? 'null' : (result.ads ? result.ads.length : 0)));
                return JSON.stringify(result);
            }

            return JSON.stringify({
                type: 'embed',
                url: directEmbedUrl,
                headers: {
                    'Referer': SITE_BASE + '/',
                    'User-Agent': UA
                }
            });
        }

        throw new Error('No stream URL found in watch page or embed');

    } catch (e) {
        console.log('[KENG][RoPhim12] getStreamUrl error: ' + e.message);
        return JSON.stringify({ error: e.message });
    }
}

function resolveSiteBase(url) {
    const siteMatch = url.match(/^(https?:\/\/[^/]+)/);
    if (siteMatch) return siteMatch[1];
    if (typeof location !== 'undefined' && location.origin) return location.origin;
    return '';
}
