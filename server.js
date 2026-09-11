const express = require('express');
const axios = require('axios');
const vm = require('vm');
const crypto = require('crypto'); // أضفنا مكتبة التشفير لمحاكاة المشغل الجديد

const app = express();
const PORT = process.env.PORT || 3000;

// الهيدرز الافتراضية كخيار بديل
const DEFAULT_HEADERS = {
    "Origin": "https://www.fasel-hd.co",
    "Referer": "https://www.fasel-hd.co/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
};

// 1. مسار الاستخراج
app.get('/api/extract', async (req, res) => {
    const targetUrl = req.query.url;

    if (!targetUrl) return res.status(400).json({ error: 'يرجى تمرير رابط url صالح.' });

    try {
        const response = await axios.get(targetUrl, { headers: { "User-Agent": DEFAULT_HEADERS["User-Agent"] } });
        const html = response.data;
        const targetOrigin = new URL(targetUrl).origin;

        // -- [القسم الأول]: محاولة استخراج بيانات المشغل الجديد (YasirTV / Sir-TV) --
        if (html.includes('window.tabsConfig') || html.includes('generateToken')) {
            // 1. استخراج المسار الأساسي للفيديو
            const pathMatch = html.match(/data-path="([^"]+)"/);
            const path = pathMatch ? pathMatch[1] : '';

            // 2. استخراج وفك تشفير إعدادات السيرفر (tabsConfig)
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
                try { tabsConfig = JSON.parse(r); } catch (e) {}
            }

            // 3. استخراج المفتاح السري وتوليد التوكن (Session ID & Token)
            const _eMatch = html.match(/var _e="([^"]+)"/);
            let streamUrl = '';
            
            if (_eMatch && path) {
                // فك تشفير المتغير _e للحصول على المفتاح السري
                const _s = Buffer.from(_eMatch[1], 'base64').toString('utf8');
                // توليد session_id عشوائي (32 حرف)
                const sid = crypto.randomBytes(16).toString('hex');
                
                // تهيئة المسار للتشابك مع دالة توليد التوكن
                let p = path;
                if (!p.startsWith("kooora/")) p = "kooora/" + p;
                if (p.endsWith(".m3u8")) p = p.slice(0, -5);

                // حساب التوكن النهائي
                const token = crypto.createHash('md5').update(p + sid + _s).digest('hex');

                // تحديد الهوست بناءً على الـ tabsConfig أو استخدام النطاق الحالي كبديل
                let host = targetOrigin;
                if (tabsConfig && tabsConfig.length > 0) {
                    const conf = tabsConfig[0];
                    if (conf.host) host = conf.host;
                    else if (conf.server) host = conf.server;
                    else if (conf.domain) host = conf.domain;
                }
                host = host.replace(/\/$/, '');
                if (!host.startsWith('http')) host = 'https://' + host;

                // بناء رابط الـ M3U8 النهائي
                streamUrl = `${host}/${p}.m3u8?token=${token}&session_id=${sid}`;
            }

            if (streamUrl) {
                // دمج الهيدرز المستخرجة في رابط البروكسي
                const proxyUrl = `${req.protocol}://${req.get('host')}/api/proxy?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(targetUrl)}&origin=${encodeURIComponent(targetOrigin)}`;
                
                return res.json({
                    success: true,
                    stream_url_direct: streamUrl,
                    proxy_url: proxyUrl,
                    headers: {
                        "Origin": targetOrigin,
                        "Referer": targetUrl,
                        "User-Agent": DEFAULT_HEADERS["User-Agent"]
                    }
                });
            }
        }

        // -- [القسم الثاني]: المشغل القديم (FaselHD) للروابط السابقة --
        const scriptMatch = html.match(/(var video = document\.getElementById\('video'\);[\s\S]+?)<\/script>/);
        if (!scriptMatch) return res.status(404).json({ error: 'لم يتم العثور على سكريبت المشغل في كلا النوعين.' });

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
            return res.json({
                success: true,
                stream_url_direct: sandbox.videoSrc, 
                proxy_url: proxyUrl,
                headers: DEFAULT_HEADERS
            });
        } else {
            return res.status(500).json({ error: 'لم يتم العثور على الرابط.' });
        }
    } catch (error) {
        return res.status(500).json({ error: 'حدث خطأ', details: error.message });
    }
});

// 2. مسار البروكسي الذكي (يستقبل الهيدرز الديناميكية)
app.get('/api/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('URL is required');

    // استخراج الهيدرز من الـ Query Parameters إن وجدت، أو استخدام الافتراضية
    const origin = req.query.origin || DEFAULT_HEADERS["Origin"];
    const referer = req.query.referer || DEFAULT_HEADERS["Referer"];
    
    const dynamicHeaders = {
        "Origin": origin,
        "Referer": referer,
        "User-Agent": DEFAULT_HEADERS["User-Agent"]
    };

    res.setHeader('Access-Control-Allow-Origin', '*');

    try {
        const isM3u8 = targetUrl.includes('.m3u8');

        if (isM3u8) {
            const response = await axios.get(targetUrl, { headers: dynamicHeaders });
            let content = response.data;
            const baseUrl = new URL(targetUrl);
            const lines = content.split('\n');

            const modifiedLines = lines.map(line => {
                line = line.trim();
                if (!line) return line;

                // إعادة توجيه المفاتيح (Keys) وتمرير الهيدرز معها
                if (line.startsWith('#EXT-X-KEY') && line.includes('URI="')) {
                    return line.replace(/URI="([^"]+)"/, (match, uri) => {
                        const absoluteUri = new URL(uri, baseUrl.href).href;
                        const proxyUri = `${req.protocol}://${req.get('host')}/api/proxy?url=${encodeURIComponent(absoluteUri)}&referer=${encodeURIComponent(referer)}&origin=${encodeURIComponent(origin)}`;
                        return `URI="${proxyUri}"`;
                    });
                }

                if (line.startsWith('#')) return line;

                const absoluteUrlObj = new URL(line, baseUrl.href);
                baseUrl.searchParams.forEach((value, key) => {
                    if (!absoluteUrlObj.searchParams.has(key)) {
                        absoluteUrlObj.searchParams.set(key, value);
                    }
                });

                // إعادة توجيه أجزاء الفيديو (.ts) أو الجودات الأخرى عبر البروكسي مع الهيدرز
                return `${req.protocol}://${req.get('host')}/api/proxy?url=${encodeURIComponent(absoluteUrlObj.href)}&referer=${encodeURIComponent(referer)}&origin=${encodeURIComponent(origin)}`;
            });

            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            return res.send(modifiedLines.join('\n'));

        } else {
            const headers = { ...dynamicHeaders };
            if (req.headers.range) headers['Range'] = req.headers.range;

            const response = await axios({
                method: 'get',
                url: targetUrl,
                responseType: 'stream',
                headers: headers,
                validateStatus: status => status >= 200 && status < 300 
            });

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
