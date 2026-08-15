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

// ── Provider: motphimchillvl.com ──────────────────────────────────────

// Story 10.17 | Motchill | Movie Detail (v6.1 with Parts)
// Contract: getMovieDetail(url) → JSON object with parts[] field (v6.1 breaking change)
// Target: /phim/{slug} on the active provider origin
// Strategy:
//   1. Fetch detail page → metadata (title, poster, dinfo)
//   2. Extract tap-1 (or tap-full) URL from btn-stream-link
//   3. Fetch watch page → full episode list
//   4. Wrap episodes in single part (site doesn't support multi-part)
// Log prefix: [KENG][5-9][Motchill]

async function getMovieDetail(url) {
    const SITE_BASE = resolveSiteBase(url);
    if (!SITE_BASE) {
        return JSON.stringify({ error: 'Cannot resolve site base from url' });
    }
    const MC_BASE = SITE_BASE;
    const MC_UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    async function fetchHtml(targetUrl) {
        const res = await fetch(targetUrl);
        if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + targetUrl);
        return res.text();
    }

    function stripTags(html) {
        return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function extractActors(html) {
        const blockM = html.match(/<dt>Diễn viên:<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/i);
        if (!blockM) return [];
        const block = blockM[1];
        const actors = [];
        const actorRe = /<a[^>]+href="([^"]+\/dien-vien\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        let m;
        while ((m = actorRe.exec(block)) !== null) {
            const actorUrl = m[1].replace(/\s+/g, ' ').trim();
            const name = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
            if (!name) continue;
            actors.push({
                name,
                avatar_url: '',
                actor_url: actorUrl,
            });
        }
        return actors;
    }

    function extractDinfo(html) {
        // Extract all dt/dd pairs from first <dl> block (no class needed)
        const blockM = html.match(/<dl[^>]*>([\s\S]*?)<\/dl>/);
        if (!blockM) return {};
        const block = blockM[1];
        const pairs = [...block.matchAll(/<dt>([^<]+)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g)];
        const result = {};
        for (const [, dt, dd] of pairs) {
            const key = dt.trim().replace(/:$/, '');
            result[key] = stripTags(dd);
        }
        return result;
    }

    function splitBadge(label) {
        const clean = label.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        if (!clean) return { badgeText: '', badgeSub: '' };

        const suffixPatterns = [
            /^(.*?)(?:\s+(Vietsub.*|Thuyết\s*Minh.*|Thuyet\s*Minh.*|Lồng\s*Tiếng.*|TM.*|Raw.*))$/i,
            /^(.*?)(?:\s*-\s*(Vietsub.*|Thuyết\s*Minh.*|Thuyet\s*Minh.*|Lồng\s*Tiếng.*))$/i,
        ];

        for (const pattern of suffixPatterns) {
            const m = clean.match(pattern);
            if (m) {
                return {
                    badgeText: m[1].trim() || clean,
                    badgeSub: m[2].trim(),
                };
            }
        }

        const plusIdx = clean.indexOf(' + ');
        if (plusIdx >= 0) {
            return {
                badgeText: clean.slice(0, plusIdx).trim(),
                badgeSub: clean.slice(plusIdx + 3).trim(),
            };
        }

        return { badgeText: clean, badgeSub: '' };
    }

    function parseEpisodeNumber(name) {
        const m = name.match(/(\d+)/);
        return m ? parseInt(m[1], 10) : null;
    }

    function normalizeServerName(name) {
        if (!name) return 'Server #1';
        let s = name.replace(/<[^>]+>/g, '').trim().replace(/:$/, '');
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
            if (num === null) continue;
            if (!map.has(num)) map.set(num, { name: item.name, servers: [] });
            
            const srvName = normalizeServerName(item.server);
            if (!map.get(num).servers.some(s => s.server === srvName)) {
                map.get(num).servers.push({ server: srvName, url: item.url });
            }
        }
        return Array.from(map.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([, ep], idx) => ({ episode_index: idx, name: ep.name, servers: ep.servers }));
    }

    function extractEpisodesFromWatchPage(html) {
        const flat = [];
        // Parse server blocks: <div class="server-episode-block">ServerName</div><div class="episodes">...</div>
        const serverBlockRe = /<div[^>]+class="[^"]*server-episode-block[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]+class="[^"]*episodes[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
        let serverMatch;
        while ((serverMatch = serverBlockRe.exec(html)) !== null) {
            const serverName = serverMatch[1].replace(/<[^>]+>/g, '').trim().replace(/:$/, '');
            const episodesBlock = serverMatch[2];
            const epRe = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
            let epMatch;
            while ((epMatch = epRe.exec(episodesBlock)) !== null) {
                const href = epMatch[1];
                const name = epMatch[2].replace(/<[^>]+>/g, '').trim();
                if (!name) continue;
                const fullUrl = href.startsWith('http') ? href : new URL(href, MC_BASE).href;
                flat.push({ url: fullUrl, name, server: serverName });
            }
        }
        // Fallback nếu không tìm thấy server blocks
        if (flat.length === 0) {
            const host = new URL(SITE_BASE).hostname.replace(/^www\./, '');
            const re = new RegExp('href="(https?:\\/\\/' + escapeRegex(host) + '\\/phim\\/[^/]+\\/tap-[^"]+)"[^>]*>\\s*([^<]+)\\s*<\\/a>', 'gi');
            let m;
            while ((m = re.exec(html)) !== null) {
                const name = m[2].trim();
                if (!name || name.length > 30) continue;
                flat.push({ url: m[1], name, server: 'Vietsub #1' });
            }
        }
        return groupEpisodes(flat);
    }

    function normalizeUrl(src) {
        if (!src) return '';
        if (src.startsWith('http')) return src;
        return new URL(src, MC_BASE).href;
    }

    try {
        console.log('[KENG][5-9][Motchill] getMovieDetail(' + url + ')');

        // Step 1: Fetch detail page
        const detailHtml = await fetchHtml(url);
        console.log('[KENG][5-9][Motchill] detail page: ' + detailHtml.length + ' chars');

        // Extract slug from URL for id
        const slugM = url.match(/\/phim\/([^/?#]+)/);
        const slug  = slugM ? slugM[1] : '';

        // Title
        const titleM = detailHtml.match(/<span class="title"[^>]*>([^<]+)<\/span>/);
        const title  = titleM ? titleM[1].trim() : '';

        // Original title — strip year in parens and extra whitespace
        const realNameM = detailHtml.match(/<span class="real-name">\s*([\s\S]*?)\s*<\/span>/);
        let titleOriginal = '';
        if (realNameM) {
            titleOriginal = realNameM[1]
                .replace(/\(\d{4}\)/g, '')
                .replace(/<[^>]+>/g, '')
                .replace(/\s+/g, ' ')
                .trim();
        }

        // Poster — prefer absolute URL, fallback to og:image
        const posterInlineM = detailHtml.match(/<img itemprop="image" src="([^"]+)"/);
        const thumbInlineM  = detailHtml.match(/<img[^>]+itemprop="thumbnailUrl"[^>]+src="([^"]+)"/i);
        const posterOgM     = detailHtml.match(/<meta property="og:image" content="([^"]+)"/);
        const posterRaw     = posterInlineM ? posterInlineM[1] : (posterOgM ? posterOgM[1] : '');
        const posterUrl     = normalizeUrl(posterRaw);
        const thumbnailRaw  = thumbInlineM ? thumbInlineM[1] : posterRaw;
        const thumbnailUrl  = normalizeUrl(thumbnailRaw);

        // Description from og:description
        const descM    = detailHtml.match(/<meta property="og:description" content="([^"]+)"/);
        const description = descM ? descM[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').substring(0, 500) : '';

        // dinfo fields
        const dinfo = extractDinfo(detailHtml);
        const year          = dinfo['Năm sản xuất'] || '';
        const duration      = dinfo['Thời lượng']   || '';
        const country       = dinfo['Quốc gia']     || '';
        const genresRaw     = dinfo['Thể loại']     || '';
        const statusText    = dinfo['Trạng thái']   || '';
        const totalEpsStr   = dinfo['Số tập']       || '0';
        const totalEpisodes = parseInt(totalEpsStr, 10) || 0;

        // Genres: split by comma or space
        const genres = genresRaw
            ? genresRaw.split(/[,،]/).map(g => g.trim()).filter(Boolean)
            : [];
        const actors = extractActors(detailHtml);

        // media_type: movie if Số tập == 1 or status contains FULL
        const isMovie = totalEpisodes === 1 || /full/i.test(statusText);
        const mediaType = isMovie ? 'movie' : 'series';

        // badge_text preserves the full status prefix before language/quality suffixes.
        // Examples:
        // - "Tập 571 Vietsub" → badge_text="Tập 571", badge_sub="Vietsub"
        // - "Hoàn Thành 23/23 Vietsub" → badge_text="Hoàn Thành 23/23", badge_sub="Vietsub"
        const { badgeText, badgeSub } = splitBadge(statusText);

        // Step 2: Get tap-1 (or tap-full) URL from btn-stream-link
        const streamLinkM = detailHtml.match(/class="btn-see btn btn-danger btn-stream-link"\s+href="([^"]+)"/);
        const firstEpUrl  = streamLinkM ? streamLinkM[1] : '';

        // Step 3: Fetch watch page for full episode list
        let episodes = [];
        if (firstEpUrl) {
            console.log('[KENG][5-9][Motchill] fetching watch page: ' + firstEpUrl);
            const watchHtml = await fetchHtml(firstEpUrl);
            console.log('[KENG][5-9][Motchill] watch page: ' + watchHtml.length + ' chars');
            episodes = extractEpisodesFromWatchPage(watchHtml);
            console.log('[KENG][5-9][Motchill] episodes found: ' + episodes.length);
            if (episodes.length === 0 && isMovie) {
                // Motchill movie pages sometimes expose only the watch URL and no
                // parseable episode block. Treat the watch URL as a single Full episode
                // so the app can resolve the actual stream from the episode page.
                episodes = [{
                    episode_index: 0,
                    name: 'Tập Full',
                    servers: [{ server: 'Vietsub #1', url: firstEpUrl }]
                }];
                console.log('[KENG][5-9][Motchill] movie fallback episode synthesized from watch URL');
            }
        } else {
            console.log('[KENG][5-9][Motchill] WARN: no stream link found on detail page');
        }

        // Rating (not available on detail page — leave empty)
        const rating = '';

        // v6.1: Wrap episodes in parts structure (breaking change)
        const parts = [
            {
                name: 'Phần 1',  // Default single part
                episodes: episodes
            }
        ];

        const result = {
            id:             slug,
            title,
            title_original: titleOriginal,
            poster_url:     posterUrl,
            thumbnail_url:  thumbnailUrl,
            url,
            year,
            duration,
            rating,
            country,
            genres,
            description,
            media_type:     mediaType,
            total_episodes: episodes.length || totalEpisodes,
            badge_text:     badgeText,
            badge_sub:      badgeSub,
            parts,  // v6.1: REQUIRED field (replaces episodes)
            actors,
        };

        console.log('[KENG][5-9][Motchill] getMovieDetail() SUCCESS: ' + title + ' | ' + mediaType + ' | ' + episodes.length + ' eps');
        return JSON.stringify(result);

    } catch (e) {
        console.log('[KENG][5-9][Motchill] getMovieDetail() ERROR: ' + e.message);
        return JSON.stringify({ error: e.message });
    }
}

function resolveSiteBase(url) {
    const siteMatch = url.match(/^(https?:\/\/[^/]+)/);
    if (siteMatch) return siteMatch[1];
    if (typeof location !== 'undefined' && location.origin) return location.origin;
    return '';
}

function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
