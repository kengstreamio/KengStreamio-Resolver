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
//   - convertvN/ prefix segments (convertv7/, convertv8/, convertv9/, ...)
//   - /vN/ prefix with segment_XXX.ts (numbered SSAI ad segments, any version)
//
// NOTE: every clause must evaluate to a boolean. Never compare a .test() result
// against -1 — `-1 !== false` is true, which classifies every segment as an ad
// and makes the whole movie look like one giant ad break.
function _isAdSegment(segment) {
  return segment.indexOf('/adjump/') !== -1
      || /convertv\d+\//.test(segment)
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

// ── Provider: motphimchillvl.com ──────────────────────────────────────

/**
 * Motchill Resolver v1.0
 * Architecture: JS-Logic-Shell Standard
 *
 * App gọi:
 *   getEpisodes(filmUrl)   — lấy danh sách tập từ trang phim
 *   getStreamUrl(episodeUrl) — lấy M3U8 / embed link từ trang xem phim
 *
 * Toàn bộ logic fetch + parse nằm trong JS này.
 * Chạy trong WebView context với baseUrl động.
 */

/**
 * Groups a flat episode array (with duplicate episode numbers across servers)
 * into nested format per contract: [{ episode_index, name, servers: [{server, url}] }]
 * Rules: sort ascending, deduplicate by episode number, skip non-numbered (Special/OVA).
 */
function normalizeServerName(name) {
    if (!name) return 'Server #1';
    // Remove HTML, trim, remove trailing colon
    let s = name.replace(/<[^>]+>/g, '').trim().replace(/:$/, '');
    // Standardize common names to avoid duplicates like "Thuyết minh" vs "Thuyet minh"
    if (s.toLowerCase().includes('vietsub')) return 'Vietsub #1';
    if (s.toLowerCase().includes('thuyết minh') || s.toLowerCase().includes('thuyet minh')) {
        if (s.includes('2')) return 'Thuyết minh #2';
        return 'Thuyết minh #1';
    }
    return s;
}

function groupEpisodes(flatItems) {
    const map = new Map();
    for (const item of flatItems) {
        const num = parseEpisodeNumber(item.name);
        const key = num !== null ? num : -1;
        if (!map.has(key)) map.set(key, { name: item.name, servers: [] });
        
        const srvName = normalizeServerName(item.server);
        // Avoid duplicate links for the same server in one episode
        if (!map.get(key).servers.some(s => s.server === srvName)) {
            map.get(key).servers.push({ server: srvName, url: item.url });
        }
    }
    return Array.from(map.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, ep], idx) => ({ episode_index: idx, name: ep.name, servers: ep.servers }));
}

function parseEpisodeNumber(name) {
    const m = name.match(/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
}

async function getEpisodes(filmUrl) {
    const SITE_BASE = resolveSiteBase(filmUrl);
    if (!SITE_BASE) {
        return JSON.stringify({ error: 'Cannot resolve site base from filmUrl' });
    }
    const MOTCHILL_BASE = SITE_BASE;
    try {
        console.log('[JS-MC] Fetching film page: ' + filmUrl);
        const filmRes = await fetch(filmUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        if (!filmRes.ok) throw new Error('Film page fetch failed: ' + filmRes.status);
        const filmHtml = await filmRes.text();

        // Parse watch URL from <a class="btn-stream-link" href="...">
        const watchMatch = filmHtml.match(/class="[^"]*btn-stream-link[^"]*"\s+href="([^"]+)"/);
        let watchHtml;

        if (watchMatch) {
            const watchPath = watchMatch[1];
            const watchUrl = watchPath.startsWith('http') ? watchPath : MOTCHILL_BASE + watchPath;
            console.log('[JS-MC] Watch URL: ' + watchUrl);

            // Fetch watch page — contains full episode list
            const watchRes = await fetch(watchUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
            });
            if (!watchRes.ok) throw new Error('Watch page fetch failed: ' + watchRes.status);
            watchHtml = await watchRes.text();
        } else {
            // Fallback: film page itself may contain #box-player with data-link (single film / tap-full)
            console.log('[JS-MC] btn-stream-link not found — using film page as watch page');
            watchHtml = filmHtml;
        }

        // Parse episodes from div.episodes > a
        // Each server block: <div class="server-episode-block">ServerName</div><div class="episodes"><a href="...">Tập N</a>...
        const episodes = [];
        const serverBlockRe = /<div[^>]+class="[^"]*server-episode-block[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]+class="[^"]*episodes[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
        let serverMatch;
        while ((serverMatch = serverBlockRe.exec(watchHtml)) !== null) {
            const serverName = serverMatch[1].replace(/<[^>]+>/g, '').trim().replace(/:$/, '');
            const episodesBlock = serverMatch[2];
            const epRe = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
            let epMatch;
            while ((epMatch = epRe.exec(episodesBlock)) !== null) {
                const href = epMatch[1];
                const name = epMatch[2].replace(/<[^>]+>/g, '').trim();
                const fullUrl = href.startsWith('http') ? href : MOTCHILL_BASE + href;
                episodes.push({ url: fullUrl, name: name, server: serverName });
            }
        }

        if (episodes.length === 0) {
            // Fallback 1: parse all <a href="/xem-phim/..."> links
            const fallbackRe = /<a[^>]+href="(\/xem-phim\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
            let m;
            while ((m = fallbackRe.exec(watchHtml)) !== null) {
                const name = m[2].replace(/<[^>]+>/g, '').trim();
                if (name) episodes.push({ url: MOTCHILL_BASE + m[1], name: name, server: 'Vietsub' });
            }
        }

        if (episodes.length === 0) {
            // Fallback 2: single film / tap-full — parse data-link from #box-player <li> tags
            // HTML: <li data-link="..." data-type="m3u8" ...>Server Name</li>
            const liRe = /<li[^>]*data-link="([^"]+)"[\s\S]*?data-type="([^"]+)"[^>]*>([\s\S]*?)<\/li>/gi;
            let m;
            while ((m = liRe.exec(watchHtml)) !== null) {
                const link = m[1];
                const type = m[2].toLowerCase();
                const serverName = m[3].replace(/<[^>]+>/g, '').trim() || 'Server';
                if (type === 'm3u8' || type === 'embed') {
                    // Single film: treat as one episode (Tập Full) with multiple servers
                    episodes.push({ url: link, name: 'Tập Full', server: serverName });
                }
            }
            if (episodes.length > 0) {
                console.log('[JS-MC] Fallback 2 (box-player li): ' + episodes.length + ' servers found');
                // Return as single episode with all servers
                const servers = episodes.map(e => ({ server: e.server, url: e.url }));
                return JSON.stringify([{ episode_index: 0, name: 'Tập Full', servers }]);
            }
        }

        console.log('[JS-MC] Episodes found (flat): ' + episodes.length);
        const nested = groupEpisodes(episodes);
        console.log('[JS-MC] Episodes nested: ' + nested.length);
        return JSON.stringify(nested);
    } catch (e) {
        console.log('[JS-MC] getEpisodes error: ' + e.message);
        return JSON.stringify({ error: e.message });
    }
}

function resolveSiteBase(url) {
    const siteMatch = url.match(/^(https?:\/\/[^/]+)/);
    if (siteMatch) return siteMatch[1];
    if (typeof location !== 'undefined' && location.origin) return location.origin;
    return '';
}
