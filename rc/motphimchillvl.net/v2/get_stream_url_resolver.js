async function getStreamUrl(episodeUrl) {
    const MOTCHILL_BASE = 'https://motphimchillvl.net';
    try {
        if (episodeUrl.includes('.m3u8')) {
            console.log('[JS-MC] Direct m3u8 URL detected, skipping fetch: ' + episodeUrl);
            return JSON.stringify({ type: 'm3u8', url: episodeUrl });
        }

        if (episodeUrl.includes('/phim/')) {
            console.log('[JS-MC] Fetching episode detail: ' + episodeUrl);
            const detailRes = await fetch(episodeUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            });
            if (!detailRes.ok) throw new Error('Episode detail fetch failed: ' + detailRes.status);
            const detailHtml = await detailRes.text();
            const watchMatch = detailHtml.match(/href="(\/xem-phim\/[^"]+)"/);
            if (watchMatch) {
                episodeUrl = MOTCHILL_BASE + watchMatch[1];
                console.log('[JS-MC] Watch URL: ' + episodeUrl);
            }
        }

        console.log('[JS-MC] Fetching watch page: ' + episodeUrl);
        const watchRes = await fetch(episodeUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        });
        if (!watchRes.ok) throw new Error('Watch page fetch failed: ' + watchRes.status);
        const html = await watchRes.text();

        let m3u8Url = null;
        let embedUrl = null;
        const re1 = /<[a-z][^>]*?data-link="([^"]+)"[\s\S]*?data-type="([^"]+)"[^>]*>/gi;
        const re2 = /<[a-z][^>]*?data-type="([^"]+)"[\s\S]*?data-link="([^"]+)"[^>]*>/gi;
        let m;

        while ((m = re1.exec(html)) !== null) {
            const link = m[1];
            const type = m[2].toLowerCase();
            if (type === 'm3u8' && !m3u8Url) m3u8Url = link;
            if (type === 'embed' && !embedUrl) embedUrl = link;
        }
        while ((m = re2.exec(html)) !== null) {
            const type = m[1].toLowerCase();
            const link = m[2];
            if (type === 'm3u8' && !m3u8Url) m3u8Url = link;
            if (type === 'embed' && !embedUrl) embedUrl = link;
        }

        if (!m3u8Url && !embedUrl) {
            const linkRe = /data-link="([^"]+)"/gi;
            while ((m = linkRe.exec(html)) !== null) {
                const link = m[1];
                if (!m3u8Url && link.includes('.m3u8')) m3u8Url = link;
                else if (!embedUrl && (link.startsWith('http') || link.startsWith('//'))) embedUrl = link;
            }
            if (m3u8Url || embedUrl) {
                console.log('[JS-MC] Strategy 2 fallback used — data-type attr missing');
            }
        }

        if (!m3u8Url && embedUrl) {
            console.log('[JS-MC] m3u8 missing, attempting to follow embed: ' + embedUrl);
            const resolvedM3u8 = await _followEmbed(embedUrl);
            if (resolvedM3u8) m3u8Url = resolvedM3u8;
        }

        const headers = {
            Referer: MOTCHILL_BASE + '/',
            'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        };

        if (m3u8Url) {
            console.log('[JS-MC] STREAM RESOLVED (m3u8): ' + m3u8Url);
            return JSON.stringify({ type: 'm3u8', url: m3u8Url, headers });
        }
        if (embedUrl) {
            console.log('[JS-MC] STREAM RESOLVED (embed): ' + embedUrl);
            return JSON.stringify({ type: 'embed', url: embedUrl, headers });
        }

        throw new Error('No stream link found in episode page');
    } catch (e) {
        console.log('[JS-MC] getStreamUrl error: ' + e.message);
        return JSON.stringify({ error: e.message });
    }
}

async function _followEmbed(url) {
    try {
        console.log('[JS-MC] Unpacking embed: ' + url);
        const res = await fetch(url, {
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            },
        });
        const html = await res.text();
        const m3u8Re = /file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i;
        const match = html.match(m3u8Re);
        if (match) {
            console.log('[JS-MC] Found m3u8 inside embed');
            return match[1];
        }
        return null;
    } catch (e) {
        console.log('[JS-MC] _followEmbed error: ' + e.message);
        return null;
    }
}
