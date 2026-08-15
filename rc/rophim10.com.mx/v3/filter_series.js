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

// ── Provider: rophim10.com.mx ──────────────────────────────────────

// Story 10-13 | RoPhim10 | Filter Phim Bộ — v3
// Contract: filterSeries(sortIdx, sortVal, countryId, countryIdx, countryVal, yearId, yearIdx, yearVal, genreId, genreIdx, genreVal, page = 1) -> JSON array
//
// LIMITATION: RoPhim10 filter API requires auth. Fallback to /movies/by-type/series (no filter support).
// Returns all series sorted by updatedAt. Filter params ignored.
// TODO: Request public filter API from RoPhim10 team.
//
// Filter values (verified 2026-04-27):
// Countries (ID order): Trung Quốc=1, Âu Mỹ=2, Hàn Quốc=3, Indonesia=4, Philippines=5, Nga=6,
//   Singapore=7, Nhật Bản=8, Thái Lan=9, Anh=10, Pháp=11, Bỉ=12, Hồng Kông=13, Canada=14,
//   Úc=15, Ý=16, Tây Ban Nha=17, Ấn Độ=18, Na Uy=19, Đức=20, Việt Nam=21
// Genres (ID order): Chính kịch=1, Hài Hước=2, Bí ẩn=3, Gia Đình=4, Viễn Tưởng=6, Hình Sự=7,
//   Kinh Dị=8, Phiêu Lưu=9, Khoa Học=10, Cổ Trang=11, Võ Thuật=12, Tình Cảm=14, Tâm Lý=16,
//   Âm Nhạc=18, Thể Thao=19, Chiến Tranh=20, Thần Thoại=21, Học Đường=22, Hoạt hình=24, Hành Động=49
// Sort: updatedAt (default), view_total, imdb_rating
// Page size: 32 items/page

async function filterSeries(baseUrl, 
    sortIdx,   sortVal,
    countryId, countryIdx, countryVal,
    yearId,    yearIdx,    yearVal,
    genreId,   genreIdx,   genreVal,
    page
) {
    page = page || 1;
    const SITE_BASE = baseUrl;
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

    // Sort: index → API param
    const SORT_VALUES = ['updatedAt', 'view_total', 'imdb_rating'];  // 0=Mới Cập Nhật, 1=Xem Nhiều, 2=Đánh Giá Cao

    // Countries: index → API ID (Story 11-9 fix — 45 countries per rophim10 backend)
    // Index 0=Trung Quốc, 1=Âu Mỹ, 2=Hàn Quốc, 3=Indonesia, 4=Philippines, 5=Nga, 6=Singapore,
    // 7=Nhật Bản, 8=Thái Lan, 9=Anh, 10=Pháp, 11=Bỉ, 12=Hồng Kông, 13=Canada, 14=Úc, 15=Ý,
    // 16=Tây Ban Nha, 17=Ấn Độ, 18=Na Uy, 19=Đức, 20=Việt Nam, 21=Thổ Nhĩ Kỳ, 22=Argentina,
    // 23=Hà Lan, 24=Quốc Gia Khác, 25=Hy Lạp, 26=Brazil, 27=Đài Loan, 28=Mexico, 29=Nam Phi,
    // 30=Colombia, 31=Chile, 32=Ba Lan, 33=Đan Mạch, 34=Thụy Điển, 35=Ukraina, 36=Bồ Đào Nha,
    // 37=Malaysia, 38=Châu Phi, 39=Thụy Sĩ, 40=Ả Rập Xê Út, 41=Ireland, 42=Phần Lan, 43=UAE, 44=Nigeria
    const COUNTRY_IDS = [
      '1','2','3','4','5','6','7','8','9','10','11','12','13','14','15',
      '16','17','18','19','20','21','22','23','24','25','26','27','28','29','30',
      '31','32','33','34','35','36','37','38','39','40','41','42','43','44','45'
    ];

    // Genres: index → live category API ID (verified 2026-04-27)
    // Index 0=Chính kịch(1), 1=Hài Hước(2), 2=Bí ẩn(3), 3=Gia Đình(4), 4=Viễn Tưởng(6),
    // 5=Hình Sự(7), 6=Kinh Dị(8), 7=Phiêu Lưu(9), 8=Khoa Học(10), 9=Cổ Trang(11),
    // 10=Võ Thuật(12), 11=Tình Cảm(14), 12=Tâm Lý(16), 13=Âm Nhạc(18), 14=Thể Thao(19),
    // 15=Chiến Tranh(20), 16=Thần Thoại(21), 17=Học Đường(22), 18=Hoạt hình(24), 19=Hành Động(49)
    const GENRE_IDS = [
      '1','2','3','4','6','7','8','9','10','11','12','14','16','18','19','20','21','22','24','49'
    ];

    async function fetchHtml(url) {
        const res = await fetch(url, buildFetchOptions(SITE_BASE + '/'));
        if (!res.ok) throw new Error('Fetch failed ' + res.status + ': ' + url);
        return res.text();
    }

    function extractBadgeFromEmbeddedJson(html, slug) {
        const slugNeedle = '\\"slug\\":\\"' + slug + '\\"';
        let idx = html.indexOf(slugNeedle);
        if (idx === -1) {
            const rawNeedle = '"slug":"' + slug + '"';
            idx = html.indexOf(rawNeedle);
            if (idx === -1) return '';
        }

        const window = html.slice(idx, idx + 6000);
        const badgeMatch = window.match(/\\"episode_current\\":\\"([^\\"]+)\\"/);
        if (badgeMatch) return badgeMatch[1].trim();

        const qualityMatch = window.match(/\\"quality\\":\\"([^\\"]+)\\"/);
        if (qualityMatch) return qualityMatch[1].trim();

        return '';
    }

    function buildUrl() {
        const params = [];

        if (countryIdx !== '-1') {
            const idx = parseInt(countryIdx);
            const id = (idx >= 0 && idx < COUNTRY_IDS.length) ? COUNTRY_IDS[idx] : '';
            params.push('countries=' + id);
        } else {
            params.push('countries=');
        }

        if (genreIdx !== '-1') {
            const idx = parseInt(genreIdx);
            const id = (idx >= 0 && idx < GENRE_IDS.length) ? GENRE_IDS[idx] : '';
            params.push('genres=' + id);
        } else {
            params.push('genres=');
        }

        if (yearIdx !== '-1' && yearVal) {
            params.push('years=' + yearVal);
        } else {
            params.push('years=');
        }

        params.push('type=series');
        params.push('rating=');

        let sortValue = 'updatedAt';
        if (sortIdx !== '-1') {
            const idx = parseInt(sortIdx);
            sortValue = (idx >= 0 && idx < SORT_VALUES.length) ? SORT_VALUES[idx] : 'updatedAt';
        }
        params.push('sort=' + sortValue);
        params.push('page=' + page);

        return SITE_BASE + '/tim-kiem?' + params.join('&');
    }

    try {
        console.log('[KENG][RoPhim10] filterSeries: page ' + page);
        const url = buildUrl();
        const html = await fetchHtml(url);

        // Collect data from multiple <a> tags with same href
        const movieData = {};  // href -> {poster, title, badge, slug}
        const itemRe = /<a[^>]+href="([^"]*\/phim\/([^"/?]+))"[^>]*>([\s\S]*?)<\/a>/gi;
        let m;

        while ((m = itemRe.exec(html)) !== null) {
            const link = m[1].startsWith('http') ? m[1] : SITE_BASE + m[1];
            const fullMatch = m[0];  // Full <a>...</a> including opening tag
            const content = m[3];    // Content inside <a>
            const slug = m[2];

            // Filter out trailers
            if (link.includes('.trailer') || 
                fullMatch.toLowerCase().includes('tag-trailer') || 
                content.toLowerCase().includes('trailer')) {
                continue;
            }

            if (!movieData[link]) {
                movieData[link] = { slug: slug, poster: '', title: '', badge: '' };
            }

            // Try extract image (from thumbnail <a>)
            const imgM = content.match(/src="([^"]+)"/) || content.match(/data-src="([^"]+)"/) || content.match(/data-original="([^"]+)"/);
            if (imgM) {
                let poster = imgM[1].startsWith('//') ? 'https:' + imgM[1] : imgM[1];
                if (poster.includes('loading') || poster.includes('base64') || poster.includes('.gif')) {
                    const fallbackImg = content.match(/data-src="([^"]+)"/) || content.match(/data-original="([^"]+)"/);
                    if (fallbackImg) poster = fallbackImg[1].startsWith('//') ? 'https:' + fallbackImg[1] : fallbackImg[1];
                }
                movieData[link].poster = poster;
            }

            // Try extract title with Vietnamese accents (from title <a>)
            // Use first title found (Vietnamese comes before English in HTML)
            const titleM = fullMatch.match(/<a[^>]+title="([^"]+)"/i);
            if (titleM && !movieData[link].title) {
                movieData[link].title = titleM[1].trim();
            }

            function resolveBadgePrefix(html) {
                const m = html.match(/\b(line-lt|line-tm|line-pd)\b/i);
                if (!m) return '';
                switch (m[1].toLowerCase()) {
                    case 'line-lt': return 'LT.';
                    case 'line-tm': return 'TM.';
                    case 'line-pd': return 'PĐ.';
                    default: return '';
                }
            }

            // Extract badge (from thumbnail <a>)
            const badgeM = content.match(/class="[^"]*(?:tag-classic|pin-new|badge|label|status|quality)[^"]*">([\s\S]*?)</i);
            if (badgeM && !movieData[link].badge) {
                const badgeBody = badgeM[1].replace(/<[^>]+>/g, '').trim();
                const badgePrefix = resolveBadgePrefix(badgeM[1]);
                movieData[link].badge = badgePrefix && badgeBody
                    ? `${badgePrefix} ${badgeBody}`
                    : badgeBody;
            }

            // Fallback: RoPhim10 embeds the real episode_current inside the Next.js payload.
            if (!movieData[link].badge) {
                const embeddedBadge = extractBadgeFromEmbeddedJson(html, slug);
                if (embeddedBadge) {
                    movieData[link].badge = embeddedBadge;
                }
            }
        }

        // Build final array from collected data
        const series = [];
        for (const [link, data] of Object.entries(movieData)) {
            if (data.poster) {  // Only include items with poster
                const title = data.title || data.slug.replace(/-/g, ' ');  // Fallback to slug if no title
                series.push({
                    rank:            0,
                    title:           title,
                    title_original:  '',
                    poster_url:      data.poster,
                    url:             link,
                    media_type:      'series',
                    badge_text:      data.badge,
                    badge_sub:       '',
                    year:            '',
                    rating:          '',
                    synopsis:        '',
                    age_rating:      '',
                    episode_current: data.badge,
                    genres:          []
                });

                if (series.length >= 60) break;  // Limit to 60 items
            }
        }

        const finalResults = series.map((i, idx) => ({
            rank:            (page - 1) * 60 + idx + 1,
            title:           i.title || 'No Title',
            title_original:  i.title_original || '',
            poster_url:      i.poster_url || '',
            url:             i.url || '',
            media_type:      'series',
            badge_text:      i.badge_text || '',
            badge_sub:       i.badge_sub || '',
            year:            i.year || '',
            rating:          i.rating || '',
            synopsis:        i.synopsis || '',
            age_rating:      i.age_rating || '',
            episode_current: i.episode_current || '',
            genres:          i.genres || []
        }));

        console.log('[KENG][RoPhim10] filterSeries SUCCESS: ' + finalResults.length + ' items (page ' + page + ')');
        return JSON.stringify(finalResults);

    } catch (e) {
        console.log('[KENG][RoPhim10] filterSeries error: ' + e.message);
        return JSON.stringify([]);
    }
}
