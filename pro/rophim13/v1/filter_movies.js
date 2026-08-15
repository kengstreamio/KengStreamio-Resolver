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

// ── Provider: rophim13 ──────────────────────────────────────

// rophim-13 | Filter Movies — v1
// Contract: filterMovies(baseUrl, sortIdx, sortVal, filterId1, filterIdx1, filterVal1, ..., page) -> JSON array
// API: GET https://k8s.onflixcdn.com/api/movies?type={type}&page={page}&country={slug}&category={slug}&lang={lang}&year={year}&sort={sort}
//
// RC config stores DISPLAY NAMES in filter_list.values[].
// This resolver maps display names → API slugs internally.
//
// The app calls: filterMovies(baseUrl, sortIdx, sortVal, 'country', cIdx, cVal, 'category', gIdx, gVal, 'year', yIdx, yVal, 'lang', lIdx, lVal, page)
// Sort params come first (idx, val), then filter groups (id, idx, val), then page.

async function filterMovies(baseUrl) {
    const API_BASE = 'https://k8s.onflixcdn.com/api';
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
    const IMG_CDN = 'https://pics.onflixcdn.com';

    // Parse variable arguments
    // args[0] = baseUrl (already extracted)
    // args[1] = sortIdx, args[2] = sortVal
    // args[3..N-1] = filterId, filterIdx, filterVal (groups of 3)
    // args[N] = page
    const args = Array.prototype.slice.call(arguments, 1); // skip baseUrl

    let page = 1;
    let sortVal = '';
    const filters = {};

    if (args.length >= 2) {
        // First pair is sort (idx, val)
        sortVal = args[1] || '';
        let i = 2;

        // Remaining groups of 3: (id, idx, val) until last arg (page)
        while (i + 2 < args.length) {
            const filterId = args[i];
            const filterIdx = args[i + 1];
            const filterVal = args[i + 2];
            if (filterId && filterVal) {
                filters[filterId] = filterVal;
            }
            i += 3;
        }

        // Last arg is page (if numeric)
        if (args.length > 0) {
            const lastArg = args[args.length - 1];
            const parsed = parseInt(lastArg, 10);
            if (!isNaN(parsed) && parsed > 0) {
                page = parsed;
            }
        }
    }

    // ── Display name → API slug mappings ──
    const SORT_MAP = {
        'Đánh Giá Cao': 'tmdb_score', 'Năm': 'year',
        'Mới Cập Nhật': 'updated_at', 'Xem Nhiều': 'view_total', 'Mới Nhất': 'latest',
    };
    const COUNTRY_MAP = {
        'Hàn Quốc': 'han-quoc', 'Nhật Bản': 'nhat-ban', 'Trung Quốc': 'trung-quoc',
        'Thái Lan': 'thai-lan', 'Âu Mỹ': 'au-my', 'Đài Loan': 'dai-loan',
        'Hồng Kông': 'hong-kong', 'Ấn Độ': 'an-do', 'Pháp': 'phap',
        'Đức': 'duc', 'Nga': 'nga', 'Mỹ': 'my', 'Úc': 'uc',
        'Canada': 'canada', 'Anh': 'anh', 'Philippines': 'philippines',
        'Indonesia': 'indonesia', 'Singapore': 'singapore', 'Việt Nam': 'viet-nam',
        'Tây Ban Nha': 'tay-ban-nha', 'Ý': 'y', 'Thổ Nhĩ Kỳ': 'tho-nhi-ky',
        'Argentina': 'argentina', 'Hà Lan': 'ha-lan', 'Hy Lạp': 'hy-lap',
        'Brazil': 'brazil', 'México': 'mexico', 'Nam Phi': 'nam-phí',
        'Colombia': 'colombia', 'Chile': 'chile', 'Ba Lan': 'ba-lan',
        'Đan Mạch': 'dan-mach', 'Thụy Điển': 'thuy-dien', 'Ukraina': 'ukraina',
        'Bồ Đào Nha': 'bo-dao-nha', 'Malaysia': 'malaysia', 'Thụy Sĩ': 'thuy-si',
        'Ireland': 'ireland', 'Phần Lan': 'phan-lan', 'UAE': 'uae',
        'Nigeria': 'nigeria', 'Na Uy': 'na-uy', 'Bỉ': 'bi',
        'Quốc Gia Khác': 'quoc-gia-khac',
    };
    const CATEGORY_MAP = {
        'Chính Kịch': 'chinh-kich', 'Hành Động': 'hanh-dong', 'Tâm Lý': 'tam-ly',
        'Kinh Dị': 'kinh-di', 'Phiêu Lưu': 'phieu-luu', 'Hài Hước': 'hai-huoc',
        'Tình Cảm': 'tinh-cam', 'Hình Sự': 'hinh-su', 'Bí Ẩn': 'bi-an',
        'Viễn Tưởng': 'vien-tuong', 'Phim Hài': 'hai', 'Gây Cấn': 'gay-can',
        'Gia Đình': 'gia-dinh', 'Khoa Học': 'khoa-hoc', 'Tài Liệu': 'tai-lieu',
        'Lãng Mạn': 'lang-man', 'Phim 18+': '18-plus', 'Chiến Tranh': 'chien-tranh',
        'Khoa Học Viễn Tưởng': 'khoa-hoc-vien-tuong', 'Giả Tưởng': 'gia-tuong',
        'Lịch Sử': 'lich-su', 'Cổ Trang': 'co-trang', 'Âm Nhạc': 'am-nhac',
        'Võ Thuật': 'vo-thuat', 'Thể Thao': 'the-thao', 'Miền Tây': 'mien-tay',
        'Phim Nhạc': 'nhac', 'Kinh Điển': 'kinh-dien', 'Học Đường': 'hoc-duong',
        'Thần Thoại': 'than-thoai', 'Trẻ Em': 'tre-em',
        'Chương Trình Truyền Hình': 'chuong-trinh-truyen-hinh',
        'Phim Ngắn': 'ngan', 'Short Drama': 'short-drama', 'LGBT': 'lgbt',
    };
    const LANG_MAP = {
        'Vietsub': 'vietsub', 'Thuyết Minh': 'thuyet-minh',
        'Lồng Tiếng': 'long-tieng', 'Tiếng Anh': 'eng',
    };

    function mapSlug(displayName, map) {
        if (!displayName) return '';
        if (map[displayName]) return map[displayName];
        // Fallback: lowercase + replace spaces with hyphens (for raw slugs passed directly)
        return displayName.toLowerCase().replace(/\s+/g, '-');
    }

    function buildFetchOptions(refererUrl) {
        return {
            headers: {
                'User-Agent': UA,
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
                'Referer': refererUrl || baseUrl + '/',
                'Origin': baseUrl,
            },
        };
    }

    function fixImageUrl(url) {
        if (!url) return '';
        if (url.startsWith('http')) return url;
        return IMG_CDN + (url.startsWith('/') ? '' : '/') + url;
    }

    function mapType(apiType) {
        if (!apiType) return 'movie';
        return apiType === 'phim-bo' ? 'series' : 'movie';
    }

    function mapBadge(item) {
        if (item.episode_current) return item.episode_current;
        if (item.quality) return item.quality;
        return '';
    }

    function mapBadgeSub(item) {
        const parts = [];
        if (item.vietsub) parts.push('Vietsub');
        if (item.thuyet_minh) parts.push('TM');
        if (item.long_tieng) parts.push('LT');
        return parts.join('. ');
    }

    async function fetchJson(url) {
        const res = await fetch(url, buildFetchOptions(baseUrl + '/'));
        if (!res.ok) throw new Error('Fetch failed ' + res.status + ': ' + url);
        return res.json();
    }

    function mapMovie(item, rank) {
        return {
            rank: rank || 0,
            title: item.title || '',
            title_original: item.original_title || '',
            poster_url: fixImageUrl(item.thumb_url),
            thumbnail_url: fixImageUrl(item.poster_url),
            url: item.slug ? baseUrl + '/phim/' + item.slug : '',
            actors: [],
            media_type: mapType(item.type),
            badge_text: mapBadge(item),
            badge_sub: mapBadgeSub(item),
            year: item.year ? item.year.toString() : '',
            rating: item.tmdb_vote_average ? item.tmdb_vote_average.toString() : '',
            synopsis: '',
            age_rating: item.rated || '',
            episode_current: item.episode_current || '',
            genres: typeof item.categories === 'string'
                ? item.categories.split(',').map(s => s.trim()).filter(Boolean)
                : Array.isArray(item.categories) ? item.categories : [],
        };
    }

    function filterTrailers(items) {
        return items.filter(item => {
            const ec = (item.episode_current || '').toLowerCase();
            return ec !== 'trailer' && ec !== 'sắp chiếu';
        });
    }

    try {
        // Build API query params
        const params = new URLSearchParams();
        params.set('page', page.toString());

        // Map filter IDs to API params
        // type is determined by the tab (phim-le for movies, phim-bo for series)
        // The app passes type via the RC config's js_url or the filter groups
        // For now, default to phim-le (movies tab); series tab uses phim-bo
        // The type is embedded in the filter values or determined by the calling context
        if (filters['type']) {
            params.set('type', filters['type']);
        } else {
            params.set('type', 'phim-le');
        }

        if (sortVal) {
            params.set('sort', mapSlug(sortVal, SORT_MAP));
        }

        if (filters['country']) {
            params.set('country', mapSlug(filters['country'], COUNTRY_MAP));
        }

        if (filters['category']) {
            params.set('category', mapSlug(filters['category'], CATEGORY_MAP));
        }

        if (filters['year']) {
            params.set('year', filters['year']);
        }

        if (filters['lang']) {
            params.set('lang', mapSlug(filters['lang'], LANG_MAP));
        }

        const url = API_BASE + '/movies?' + params.toString();
        const data = await fetchJson(url);

        const items = (data.data || []).map((item, idx) => mapMovie(item, (page - 1) * 20 + idx + 1));
        return JSON.stringify(filterTrailers(items));
    } catch (e) {
        return JSON.stringify({ error: e.message });
    }
}
