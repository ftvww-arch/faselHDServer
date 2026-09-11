const express = require('express');
const axios = require('axios');
const vm = require('vm');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// الهيدرز الأساسية (يفضل دائماً استخدام الدومين الرسمي كمرجع)
const DEFAULT_HEADERS = {
    "Origin": "https://sir-tv.tv",
    "Referer": "https://sir-tv.tv/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9,ar;q=0.8"
};

// --- إعدادات CORS الشاملة للسماح للمشغل بالعمل بحرية ---
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// 1. مسار الاستخراج
app.get('/api/extract', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: 'يرجى تمرير رابط url صالح.' });

    try {
        const response = await axios.get(targetUrl, { 
            headers: { "User-Agent": DEFAULT_HEADERS["User-Agent"] },
            validateStatus: () => true // لا تنهار في حال الخطأ
        });
        const html = response.data;
        const targetOrigin = new URL(targetUrl).origin;

        // استخراج المشغل الجديد (YasirTV / Sir-TV)
        if (html.includes('window.tabsConfig') || html.includes('generateToken')) {
            const pathMatch = html.match(/data-path="([^"]+)"/);
            const path = pathMatch ? pathMatch[1] : '';

            let tabsConfig = [];
            const _0xMatch = html.match(/var _0x="([^"]+)"/);
            const kMatch = html.match(/var k="([^"]+)"/);
            if (_0xMatch && kMatch) {
                const _0x = _0xMatch[1];
                const k = kMatch[1];
                const d = Buffer.from(_0x, 'base64').toString('binary');
                let r = "";
                for (let i = 0; i < d.length; i++) {
                    r += String.fromCharCode(d.charCodeAt(i) ^ k.charCodeAt(i % k.length));
                }
                try { tabsConfig = JSON.parse(r); } catch (e) { console.error("Failed to parse tabsConfig", e); }
            }

            const _eMatch = html.match(/var _e="([^"]+)"/);
            let streamUrl = '';
            
            if (_eMatch && path) {
                const _s = Buffer.from(_eMatch[1], 'base64').toString('utf8');
                const sid = crypto.randomBytes(16).toString('hex');
                
                let p = path;
                if (!p.startsWith("kooora/")) p = "kooora/" + p;
                if (p.endsWith(".m3u8")) p = p.slice(0, -5);

                const token = crypto.createHash('md5').update(p + sid + _s).digest('hex');

                let host = targetOrigin;
                if (tabsConfig && tabsConfig.length > 0) {
                    const conf = tabsConfig[0];
                    if (conf.host) host = conf.host;
                    else if (conf.server) host = conf.server;
                    else if (conf.domain) host = conf.domain;
                }
                host = host.replace(/\/$/, '');
                if (!host.startsWith('http')) host = 'https://' + host;

                streamUrl = `${host}/${p}.m3u8?token=${token}&session_id=${sid}`;
            }

            if (streamUrl) {
                const proxyUrl = `${req.protocol}://${req.get('host')}/api/proxy?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(DEFAULT_HEADERS["Referer"])}&origin=${encodeURIComponent(DEFAULT_HEADERS["Origin"])}`;
                
                return res.json({
                    success: true,
                    stream_url_direct: streamUrl,
                    proxy_url: proxyUrl,
                    headers: DEFAULT_HEADERS
                });
            }
        }

        // المشغل القديم كبديل
        const scriptMatch = html.match(/(var video = document\.getElementById\('video'\);[\s\S]+?)<\/script>/);
        if (scriptMatch) {
            const scriptCode = scriptMatch[1];
            const sandbox = {
                document: { getElementById: () => ({ canPlayType: () => false, src: '' }) },
                window: {}, Hls: { isSupported: () => false },
                setInterval: () => {}, setTimeout: () => {}, console: { log: () => {}, warn: () => {}, error: () => {} }
            };
            sandbox.window = sandbox; sandbox.global = sandbox;
            vm.createContext(sandbox); vm.runInContext(scriptCode, sandbox);

            if (sandbox.videoSrc) {
                const proxyUrl = `${req.protocol}://${req.get('host')}/api/proxy?url=${encodeURIComponent(sandbox.videoSrc)}`;
                return res.json({ success: true, proxy_url: proxyUrl });
            }
        }

        return res.status(404).json({ error: 'لم يتم العثور على بيانات المشغل.' });

    } catch (error) {
        return res.status(500).json({ error: 'حدث خطأ أثناء الاستخراج', details: error.message });
    }
});

// 2. مسار البروكسي الذكي
app.get('/api/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('URL is required');

    const origin = req.query.origin || DEFAULT_HEADERS["Origin"];
    const referer = req.query.referer || DEFAULT_HEADERS["Referer"];
    
    const dynamicHeaders = {
        "Origin": origin,
        "Referer": referer,
        "User-Agent": DEFAULT_HEADERS["User-Agent"],
        "Accept": "*/*",
        "Connection": "keep-alive"
    };

    try {
        const isM3u8 = targetUrl.includes('.m3u8');

        if (isM3u8) {
            const response = await axios.get(targetUrl, { 
                headers: dynamicHeaders,
                validateStatus: () => true // قراءة الرد مهما كان (حتى لو 403)
            });

            // إذا قام السيرفر المستهدف برفض طلبنا (Railway IP Block)
            if (response.status !== 200) {
                console.error(`[M3U8 Blocked] Status: ${response.status} from ${targetUrl}`);
                return res.status(response.status).send(`Target server rejected the request. Status: ${response.status}`);
            }

            let content = response.data;
            const baseUrl = new URL(targetUrl);
            const lines = content.split('\n');

            const modifiedLines = lines.map(line => {
                line = line.trim();
                if (!line) return line;

                // معالجة مفاتيح التشفير
                if (line.startsWith('#EXT-X-KEY') && line.includes('URI="')) {
                    return line.replace(/URI="([^"]+)"/, (match, uri) => {
                        const absoluteUri = new URL(uri, baseUrl.href).href;
                        const proxyUri = `${req.protocol}://${req.get('host')}/api/proxy?url=${encodeURIComponent(absoluteUri)}&referer=${encodeURIComponent(referer)}&origin=${encodeURIComponent(origin)}`;
                        return `URI="${proxyUri}"`;
                    });
                }

                if (line.startsWith('#')) return line;

                // تمرير الرابط بالكامل (بما فيه query params مثل ts و token الداخلية) إلى البروكسي
                const absoluteUrlObj = new URL(line, baseUrl.href);
                return `${req.protocol}://${req.get('host')}/api/proxy?url=${encodeURIComponent(absoluteUrlObj.href)}&referer=${encodeURIComponent(referer)}&origin=${encodeURIComponent(origin)}`;
            });

            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            return res.send(modifiedLines.join('\n'));

        } else {
            // مقاطع الـ TS
            const headers = { ...dynamicHeaders };
            if (req.headers.range) headers['Range'] = req.headers.range;

            const response = await axios({
                method: 'get',
                url: targetUrl,
                responseType: 'stream',
                headers: headers,
                validateStatus: () => true
            });

            if (response.status !== 200 && response.status !== 206) {
                console.error(`[TS/Media Blocked] Status: ${response.status}`);
                return res.status(response.status).send('Media chunk blocked by target.');
            }

            ['content-type', 'content-length', 'accept-ranges', 'content-range'].forEach(h => {
                if (response.headers[h]) res.setHeader(h, response.headers[h]);
            });

            res.status(response.status);
            response.data.pipe(res);
        }

    } catch (error) {
        console.error("Proxy Error:", error.message);
        if (!res.headersSent) res.status(500).send('Error proxying media');
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
