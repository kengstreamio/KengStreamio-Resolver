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

// Provider: rophim-13 | Site: https://onflix.lol
// Contract: railGroupAll(baseUrl) -> JSON { rails: [...] }
// API: https://k8s.onflixcdn.com/api/themes/{slug}?limit=12
// v6.1 rail-group contract — with CTA functions

// ===== SHARED CONSTANTS (file scope — safe, no WebView conflicts) =====
const _ROPHIM13_API = 'https://k8s.onflixcdn.com/api';
const _ROPHIM13_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function _rophim13FetchOpts(referer) {
  return {
    headers: {
      'User-Agent': _ROPHIM13_UA,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
      'Referer': referer || 'https://onflix.lol/',
      'Origin': 'https://onflix.lol',
    },
  };
}

function _rophim13TransformMovie(m, siteBase) {
  // Filter out "Trailer" and "Sắp chiếu" (coming soon) movies
  const ec = (m.episode_current || '').toLowerCase();
  if (ec === 'trailer' || ec === 'sắp chiếu') return null;

  let badgeSub = '';
  const vs = m.vietsub || 0;
  const tm = m.thuyet_minh || 0;
  if (vs > 0 && tm > 0) {
    badgeSub = `P.Đ ${vs} | T.M ${tm}`;
  } else if (vs > 0) {
    badgeSub = `P.Đ ${vs}`;
  } else if (tm > 0) {
    badgeSub = `T.M ${tm}`;
  }
  const mediaType = m.type === 'phim-bo' ? 'series' : 'movie';
  const genres = m.categories
    ? m.categories.split(', ').map(g => g.trim()).filter(Boolean)
    : [];
  return {
    rank: 0,
    title: m.title || '',
    title_original: m.original_title || '',
    poster_url: m.thumb_url || m.poster_url || '',
    url: m.slug ? `${siteBase}/phim/${m.slug}` : '',
    media_type: mediaType,
    badge_text: m.quality || '',
    badge_sub: badgeSub,
    year: m.year ? String(m.year) : '',
    rating: m.tmdb_vote_average ? String(m.tmdb_vote_average) : '',
    synopsis: '',
    age_rating: m.rated || '',
    episode_current: m.episode_current || '',
    genres: genres,
  };
}

/**
 * Main rail group resolver for onflix.lol
 * Fetches all 17 home screen rails via REST API
 * Returns { rails: [...] } per v6 contract
 */
async function railGroupAll(baseUrl) {
  console.log('[KENG][rophim-13] railGroupAll() v1 — API-based');

  /**
   * Fetch movies for a single theme slug (page 1, limit 12)
   */
  async function fetchThemeMovies(slug) {
    try {
      const url = `${_ROPHIM13_API}/themes/${slug}?limit=12`;
      const res = await fetch(url, _rophim13FetchOpts(baseUrl + '/'));
      if (!res.ok) {
        console.log(`[KENG][rophim-13] Theme ${slug} returned ${res.status}`);
        return [];
      }
      const data = await res.json();
      const movies = data.movies || [];
      const seen = new Set();
      const unique = [];
      for (const m of movies) {
        if (m.slug && !seen.has(m.slug)) {
          seen.add(m.slug);
          unique.push(m);
        }
      }
      const result = unique
        .map(m => _rophim13TransformMovie(m, baseUrl))
        .filter(m => m && m.title && m.url)
        .sort((a, b) => (parseInt(b.year) || 0) - (parseInt(a.year) || 0));
      console.log(`[KENG][rophim-13] Theme ${slug} sorted:`, result.map(m => `${m.title}(${m.year})`).join(', '));
      return result;
    } catch (e) {
      console.log(`[KENG][rophim-13] Error fetching theme ${slug}: ${e.message}`);
      return [];
    }
  }

  /**
   * Fetch cinema movies via /api/movies?type=chieu_rap (different endpoint from themes)
   */
  async function fetchCinemaMovies() {
    try {
      const url = `${_ROPHIM13_API}/movies?type=chieu_rap&sort=newest&page=1&limit=12`;
      const res = await fetch(url, _rophim13FetchOpts(baseUrl + '/'));
      if (!res.ok) {
        console.log(`[KENG][rophim-13] Cinema API returned ${res.status}`);
        return [];
      }
      const data = await res.json();
      const movies = data.data || [];
      const seen = new Set();
      const unique = [];
      for (const m of movies) {
        if (m.slug && !seen.has(m.slug)) {
          seen.add(m.slug);
          unique.push(m);
        }
      }
      return unique
        .map(m => _rophim13TransformMovie(m, baseUrl))
        .filter(m => m && m.title && m.url)
        .sort((a, b) => (parseInt(b.year) || 0) - (parseInt(a.year) || 0));
    } catch (e) {
      console.log(`[KENG][rophim-13] Error fetching cinema: ${e.message}`);
      return [];
    }
  }

  // ===== FETCH HOT MOVIES (/api/movies/hot — returns direct array of 10) =====
  async function fetchHotMovies() {
    try {
      const url = `${_ROPHIM13_API}/movies/hot`;
      const res = await fetch(url, _rophim13FetchOpts(baseUrl + '/'));
      if (!res.ok) {
        console.log(`[KENG][rophim-13] Hot API returned ${res.status}`);
        return [];
      }
      const movies = await res.json();
      const seen = new Set();
      const unique = [];
      for (const m of movies) {
        if (m.slug && !seen.has(m.slug)) {
          seen.add(m.slug);
          unique.push(m);
        }
      }
      return unique.map(m => _rophim13TransformMovie(m, baseUrl)).filter(m => m && m.title && m.url);
    } catch (e) {
      console.log(`[KENG][rophim-13] Error fetching hot movies: ${e.message}`);
      return [];
    }
  }

  // ===== THEME DEFINITIONS (ordered by stt) =====
  const THEMES = [
    { slug: 'phim-hot',                                  title: 'TOP 10 Phim Hot',                               is_hero_source: true, is_hot: true },
    { slug: 'de-xuat-cho-ban',                          title: 'Đề Xuất Cho Bạn',                                                     js_method: 'getAll_de_xuat_cho_ban' },
    { slug: 'dang-chieu-phat',                          title: 'Đang Chiếu Phát',                                                     js_method: 'getAll_dang_chieu_phat' },
    { slug: 'chieu_rap',                                title: 'Phim Chiếu Rạp',                                                      is_cinema: true, js_method: 'getAll_chieu_rap' },
    { slug: 'phim-chat-luong-cao-va-phu-de-song-ngu',   title: 'Phim Chất Lượng Cao và Phụ Đề Song Ngữ',                           js_method: 'getAll_phim_chat_luong_cao_va_phu_de_song_ngu' },
    { slug: 'hoat-hinh-chon-loc',                       title: 'Hoạt Hình Chọn Lọc',                                                js_method: 'getAll_hoat_hinh_chon_loc' },
    { slug: 'phieu-luu-mao-hiem',                       title: 'Phiêu Lưu Mạo Hiểm',                                                js_method: 'getAll_phieu_luu_mao_hiem' },
    { slug: 'phim-truyen-hinh-trung-quoc-dai-luc',      title: 'Phim Truyền Hình Trung Quốc Đại Lục',                              js_method: 'getAll_phim_truyen_hinh_trung_quoc_dai_luc' },
    { slug: 'tinh-yeu-la-nhung-gi-trai-tim-muon',       title: 'Tình Yêu Là Những Gì Trái Tim Muốn',                               js_method: 'getAll_tinh_yeu_la_nhung_gi_trai_tim_muon' },
    { slug: 'co-trang-huyen-ao',                        title: 'Cổ Trang Huyền Ảo',                                                 js_method: 'getAll_co_trang_huyen_ao' },
    { slug: 'phim-han-quoc',                            title: 'Phim Hàn Quốc',                                                     js_method: 'getAll_phim_han_quoc' },
    { slug: 'thanh-xuan',                               title: 'Thanh Xuân',                                                        js_method: 'getAll_thanh_xuan' },
    { slug: 'phim-chua-lanh-tam-hon',                   title: 'Phim Chữa Lành Tâm Hồn',                                           js_method: 'getAll_phim_chua_lanh_tam_hon' },
    { slug: 'phim-chuyen-the-tu-tac-pham-van-hoc',      title: 'Phim Chuyển Thể Từ Tác Phẩm Văn Học',                             js_method: 'getAll_phim_chuyen_the_tu_tac_pham_van_hoc' },
    { slug: 'phim-4k',                                  title: 'Phim 4K',                                                           js_method: 'getAll_phim_4k' },
    { slug: 'phim-cong-so',                             title: 'Phim Công Sở',                                                      js_method: 'getAll_phim_cong_so' },
    { slug: 'hinh-su-toi-pham-han-quoc',                title: 'Hình Sự Tội Phạm Hàn Quốc',                                        js_method: 'getAll_hinh_su_toi_pham_han_quoc' },
    { slug: 'phim-co-trang-huyen-huyen-khong-the-bo-lo', title: 'Phim Cổ Trang Huyền Huyễn Không Thể Bỏ Lỡ',                      js_method: 'getAll_phim_co_trang_huyen_huyen_khong_the_bo_lo' },
    { slug: 'dien-anh-au-my',                           title: 'Điện Ảnh Âu Mỹ',                                                    js_method: 'getAll_dien_anh_au_my' },
  ];

  // ===== FETCH ALL RAILS IN PARALLEL =====
  const railResults = await Promise.all(
    THEMES.map(theme => {
      if (theme.is_hot) return fetchHotMovies();
      if (theme.is_cinema) return fetchCinemaMovies();
      return fetchThemeMovies(theme.slug);
    })
  );

  const rails = [];
  for (let i = 0; i < THEMES.length; i++) {
    const theme = THEMES[i];
    const movies = railResults[i];
    if (movies.length === 0) {
      console.log(`[KENG][rophim-13] Skipping empty rail: ${theme.slug}`);
      continue;
    }
    rails.push({
      id: theme.slug,
      title: theme.title,
      subtitle: null,
      card_height_percent: 0.22,
      card_size_ratio: 0.667,
      is_hero_source: theme.is_hero_source === true,
      show_rank: false,
      movies: movies,
      show_cta: theme.js_method ? { js_method: theme.js_method } : null,
    });
  }

  console.log(`[KENG][rophim-13] railGroupAll() done — ${rails.length} rails`);
  return JSON.stringify(rails);
}

// ===== CTA FUNCTIONS (one per theme — called when user taps "Xem tất cả") =====
// Contract: accept page (1-based) → return JSON.stringify(movies) or []

async function getAll_de_xuat_cho_ban(page = 1) {
  const res = await fetch(`${_ROPHIM13_API}/themes/de-xuat-cho-ban?limit=12&page=${page}`, _rophim13FetchOpts());
  if (!res.ok) return JSON.stringify([]);
  const data = await res.json();
  const movies = (data.movies || []).map(m => _rophim13TransformMovie(m, 'https://onflix.lol'));
  return JSON.stringify(movies.filter(m => m && m.title && m.url).sort((a, b) => (parseInt(b.year) || 0) - (parseInt(a.year) || 0)));
}

async function getAll_dang_chieu_phat(page = 1) {
  const res = await fetch(`${_ROPHIM13_API}/themes/dang-chieu-phat?limit=12&page=${page}`, _rophim13FetchOpts());
  if (!res.ok) return JSON.stringify([]);
  const data = await res.json();
  const movies = (data.movies || []).map(m => _rophim13TransformMovie(m, 'https://onflix.lol'));
  return JSON.stringify(movies.filter(m => m && m.title && m.url).sort((a, b) => (parseInt(b.year) || 0) - (parseInt(a.year) || 0)));
}

async function getAll_phim_chat_luong_cao_va_phu_de_song_ngu(page = 1) {
  const res = await fetch(`${_ROPHIM13_API}/themes/phim-chat-luong-cao-va-phu-de-song-ngu?limit=12&page=${page}`, _rophim13FetchOpts());
  if (!res.ok) return JSON.stringify([]);
  const data = await res.json();
  const movies = (data.movies || []).map(m => _rophim13TransformMovie(m, 'https://onflix.lol'));
  return JSON.stringify(movies.filter(m => m && m.title && m.url).sort((a, b) => (parseInt(b.year) || 0) - (parseInt(a.year) || 0)));
}

async function getAll_hoat_hinh_chon_loc(page = 1) {
  const res = await fetch(`${_ROPHIM13_API}/themes/hoat-hinh-chon-loc?limit=12&page=${page}`, _rophim13FetchOpts());
  if (!res.ok) return JSON.stringify([]);
  const data = await res.json();
  const movies = (data.movies || []).map(m => _rophim13TransformMovie(m, 'https://onflix.lol'));
  return JSON.stringify(movies.filter(m => m && m.title && m.url).sort((a, b) => (parseInt(b.year) || 0) - (parseInt(a.year) || 0)));
}

async function getAll_phieu_luu_mao_hiem(page = 1) {
  const res = await fetch(`${_ROPHIM13_API}/themes/phieu-luu-mao-hiem?limit=12&page=${page}`, _rophim13FetchOpts());
  if (!res.ok) return JSON.stringify([]);
  const data = await res.json();
  const movies = (data.movies || []).map(m => _rophim13TransformMovie(m, 'https://onflix.lol'));
  return JSON.stringify(movies.filter(m => m && m.title && m.url).sort((a, b) => (parseInt(b.year) || 0) - (parseInt(a.year) || 0)));
}

async function getAll_phim_truyen_hinh_trung_quoc_dai_luc(page = 1) {
  const res = await fetch(`${_ROPHIM13_API}/themes/phim-truyen-hinh-trung-quoc-dai-luc?limit=12&page=${page}`, _rophim13FetchOpts());
  if (!res.ok) return JSON.stringify([]);
  const data = await res.json();
  const movies = (data.movies || []).map(m => _rophim13TransformMovie(m, 'https://onflix.lol'));
  return JSON.stringify(movies.filter(m => m && m.title && m.url).sort((a, b) => (parseInt(b.year) || 0) - (parseInt(a.year) || 0)));
}

async function getAll_tinh_yeu_la_nhung_gi_trai_tim_muon(page = 1) {
  const res = await fetch(`${_ROPHIM13_API}/themes/tinh-yeu-la-nhung-gi-trai-tim-muon?limit=12&page=${page}`, _rophim13FetchOpts());
  if (!res.ok) return JSON.stringify([]);
  const data = await res.json();
  const movies = (data.movies || []).map(m => _rophim13TransformMovie(m, 'https://onflix.lol'));
  return JSON.stringify(movies.filter(m => m && m.title && m.url).sort((a, b) => (parseInt(b.year) || 0) - (parseInt(a.year) || 0)));
}

async function getAll_co_trang_huyen_ao(page = 1) {
  const res = await fetch(`${_ROPHIM13_API}/themes/co-trang-huyen-ao?limit=12&page=${page}`, _rophim13FetchOpts());
  if (!res.ok) return JSON.stringify([]);
  const data = await res.json();
  const movies = (data.movies || []).map(m => _rophim13TransformMovie(m, 'https://onflix.lol'));
  return JSON.stringify(movies.filter(m => m && m.title && m.url).sort((a, b) => (parseInt(b.year) || 0) - (parseInt(a.year) || 0)));
}

async function getAll_phim_han_quoc(page = 1) {
  const res = await fetch(`${_ROPHIM13_API}/themes/phim-han-quoc?limit=12&page=${page}`, _rophim13FetchOpts());
  if (!res.ok) return JSON.stringify([]);
  const data = await res.json();
  const movies = (data.movies || []).map(m => _rophim13TransformMovie(m, 'https://onflix.lol'));
  return JSON.stringify(movies.filter(m => m && m.title && m.url).sort((a, b) => (parseInt(b.year) || 0) - (parseInt(a.year) || 0)));
}

async function getAll_thanh_xuan(page = 1) {
  const res = await fetch(`${_ROPHIM13_API}/themes/thanh-xuan?limit=12&page=${page}`, _rophim13FetchOpts());
  if (!res.ok) return JSON.stringify([]);
  const data = await res.json();
  const movies = (data.movies || []).map(m => _rophim13TransformMovie(m, 'https://onflix.lol'));
  return JSON.stringify(movies.filter(m => m && m.title && m.url).sort((a, b) => (parseInt(b.year) || 0) - (parseInt(a.year) || 0)));
}

async function getAll_phim_chua_lanh_tam_hon(page = 1) {
  const res = await fetch(`${_ROPHIM13_API}/themes/phim-chua-lanh-tam-hon?limit=12&page=${page}`, _rophim13FetchOpts());
  if (!res.ok) return JSON.stringify([]);
  const data = await res.json();
  const movies = (data.movies || []).map(m => _rophim13TransformMovie(m, 'https://onflix.lol'));
  return JSON.stringify(movies.filter(m => m && m.title && m.url).sort((a, b) => (parseInt(b.year) || 0) - (parseInt(a.year) || 0)));
}

async function getAll_phim_chuyen_the_tu_tac_pham_van_hoc(page = 1) {
  const res = await fetch(`${_ROPHIM13_API}/themes/phim-chuyen-the-tu-tac-pham-van-hoc?limit=12&page=${page}`, _rophim13FetchOpts());
  if (!res.ok) return JSON.stringify([]);
  const data = await res.json();
  const movies = (data.movies || []).map(m => _rophim13TransformMovie(m, 'https://onflix.lol'));
  return JSON.stringify(movies.filter(m => m && m.title && m.url).sort((a, b) => (parseInt(b.year) || 0) - (parseInt(a.year) || 0)));
}

async function getAll_phim_4k(page = 1) {
  const res = await fetch(`${_ROPHIM13_API}/themes/phim-4k?limit=12&page=${page}`, _rophim13FetchOpts());
  if (!res.ok) return JSON.stringify([]);
  const data = await res.json();
  const movies = (data.movies || []).map(m => _rophim13TransformMovie(m, 'https://onflix.lol'));
  return JSON.stringify(movies.filter(m => m && m.title && m.url).sort((a, b) => (parseInt(b.year) || 0) - (parseInt(a.year) || 0)));
}

async function getAll_phim_cong_so(page = 1) {
  const res = await fetch(`${_ROPHIM13_API}/themes/phim-cong-so?limit=12&page=${page}`, _rophim13FetchOpts());
  if (!res.ok) return JSON.stringify([]);
  const data = await res.json();
  const movies = (data.movies || []).map(m => _rophim13TransformMovie(m, 'https://onflix.lol'));
  return JSON.stringify(movies.filter(m => m && m.title && m.url).sort((a, b) => (parseInt(b.year) || 0) - (parseInt(a.year) || 0)));
}

async function getAll_hinh_su_toi_pham_han_quoc(page = 1) {
  const res = await fetch(`${_ROPHIM13_API}/themes/hinh-su-toi-pham-han-quoc?limit=12&page=${page}`, _rophim13FetchOpts());
  if (!res.ok) return JSON.stringify([]);
  const data = await res.json();
  const movies = (data.movies || []).map(m => _rophim13TransformMovie(m, 'https://onflix.lol'));
  return JSON.stringify(movies.filter(m => m && m.title && m.url).sort((a, b) => (parseInt(b.year) || 0) - (parseInt(a.year) || 0)));
}

async function getAll_phim_co_trang_huyen_huyen_khong_the_bo_lo(page = 1) {
  const res = await fetch(`${_ROPHIM13_API}/themes/phim-co-trang-huyen-huyen-khong-the-bo-lo?limit=12&page=${page}`, _rophim13FetchOpts());
  if (!res.ok) return JSON.stringify([]);
  const data = await res.json();
  const movies = (data.movies || []).map(m => _rophim13TransformMovie(m, 'https://onflix.lol'));
  return JSON.stringify(movies.filter(m => m && m.title && m.url).sort((a, b) => (parseInt(b.year) || 0) - (parseInt(a.year) || 0)));
}

async function getAll_dien_anh_au_my(page = 1) {
  const res = await fetch(`${_ROPHIM13_API}/themes/dien-anh-au-my?limit=12&page=${page}`, _rophim13FetchOpts());
  if (!res.ok) return JSON.stringify([]);
  const data = await res.json();
  const movies = (data.movies || []).map(m => _rophim13TransformMovie(m, 'https://onflix.lol'));
  return JSON.stringify(movies.filter(m => m && m.title && m.url).sort((a, b) => (parseInt(b.year) || 0) - (parseInt(a.year) || 0)));
}

async function getAll_chieu_rap(baseUrl = 'https://onflix.lol', page = 1) {
  try {
    const url = `${_ROPHIM13_API}/movies?type=chieu_rap&sort=newest&page=${page}&limit=12`;
    const res = await fetch(url, _rophim13FetchOpts(baseUrl + '/'));
    console.log(`[KENG][rophim-13] getAll_chieu_rap status=${res.status}`);
    if (!res.ok) {
      console.log(`[KENG][rophim-13] getAll_chieu_rap HTTP error ${res.status}`);
      return JSON.stringify([]);
    }
    const data = await res.json();
    const raw = data.data || [];
    console.log(`[KENG][rophim-13] getAll_chieu_rap raw=${raw.length}`);
    const movies = raw.map(m => _rophim13TransformMovie(m, baseUrl));
    const filtered = movies.filter(m => m && m.title && m.url).sort((a, b) => (parseInt(b.year) || 0) - (parseInt(a.year) || 0));
    console.log(`[KENG][rophim-13] getAll_chieu_rap filtered=${filtered.length}`);
    return JSON.stringify(filtered);
  } catch (e) {
    console.log(`[KENG][rophim-13] getAll_chieu_rap error=${e.message}`);
    return JSON.stringify([]);
  }
}
