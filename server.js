const express = require('express');
const axios = require('axios');
const vm = require('vm');
const cors = require('cors'); // لتجنب مشاكل CORS إن كنت تستخدم ويب بلاير مستقبلاً

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// الهيدرز الأساسية الموحدة
const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// 1. مسار الاستخراج
app.get('/api/extract', async (req, res) => {
    const targetUrl = req.query.url; 
    if (!targetUrl) return res.status(400).json({ error: 'يرجى تمرير رابط url صالح.' });

    // استخراج الدومين الأصلي لاستخدامه كـ Origin و Referer
    let originHost;
    try {
        const urlObj = new URL(targetUrl);
        originHost = `${urlObj.protocol}//${urlObj.host}`;
    } catch (e) {
        return res.status(400).json({ error: 'الرابط غير صالح' });
    }

    const customHeaders = {
        "User-Agent": DEFAULT_USER_AGENT,
        "Referer": targetUrl, // نستخدم الرابط نفسه كمرجع
        "Origin": originHost
    };

    try {
        const response = await axios.get(targetUrl, { headers: customHeaders });
        const html = response.data;

        // البحث عن الكود المشفر الخاص بـ jwplayer
        const scriptMatch = html.match(/eval\(function\(p,a,c,k,e,d\).*?\)\)/);
        if (!scriptMatch) return res.status(404).json({ error: 'لم يتم العثور على سكريبت المشغل المشفر.' });

        const packedScript = scriptMatch[0];
        let extractedVideoUrl = null;

        // بناء كائن jQuery مزيف لتجنب الأخطاء أثناء فك التشفير
        const mockJQuery = new Proxy(function() {}, {
            get: (target, prop) => mockJQuery,
            apply: (target, thisArg, argumentsList) => mockJQuery
        });

        // البيئة الوهمية لاصطياد الرابط
        const sandbox = {
            $: mockJQuery,
            jQuery: mockJQuery,
            document: { getElementById: () => ({}) },
            window: { navigator: { userAgent: '' } },
            console: { log: () => {}, warn: () => {}, error: () => {} },
            jwplayer: function() {
                return {
                    setup: function(config) {
                        if (config.sources && config.sources.length > 0) {
                            extractedVideoUrl = config.sources[0].file;
                        } else if (config.playlist && config.playlist[0]) {
                            extractedVideoUrl = config.playlist[0].file || config.playlist[0].sources[0].file;
                        } else if (config.file) {
                            extractedVideoUrl = config.file;
                        }
                        return this;
                    },
                    on: function() { return this; }
                };
            }
        };
        
        sandbox.window = sandbox;
        sandbox.global = sandbox;

        vm.createContext(sandbox);
        vm.runInContext(packedScript, sandbox);

        if (extractedVideoUrl) {
            // نقوم بتمرير رابط الميديا + الرابط المرجعي (Referer) إلى البروكسي
            const proxyUrl = `${req.protocol}://${req.get('host')}/api/proxy?url=${encodeURIComponent(extractedVideoUrl)}&referer=${encodeURIComponent(targetUrl)}`;
            
            return res.json({
                success: true,
                stream_url_direct: extractedVideoUrl,
                proxy_url: proxyUrl,
                // نعيد الهيدرز التي تم اكتشافها لتتمكن من استخدامها مباشرة في التطبيق إن أردت
                required_headers: customHeaders 
            });
        } else {
            return res.status(500).json({ error: 'تم الفك ولكن لم يُعثر على الرابط.' });
        }
    } catch (error) {
        return res.status(500).json({ error: 'خطأ', details: error.message });
    }
});

// 2. مسار البروكسي الذكي
app.get('/api/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    const refererUrl = req.query.referer; // نستقبل المرجع

    if (!targetUrl) return res.status(400).send('URL is required');

    res.setHeader('Access-Control-Allow-Origin', '*');

    // تجهيز الهيدرز للبروكسي بناءً على المرجع القادم
    const proxyHeaders = {
        "User-Agent": DEFAULT_USER_AGENT
    };
    
    if (refererUrl) {
        try {
            const refObj = new URL(refererUrl);
            proxyHeaders["Referer"] = refererUrl;
            proxyHeaders["Origin"] = `${refObj.protocol}//${refObj.host}`;
        } catch (e) {
            // تجاهل إن كان الرابط غير صالح
        }
    }

    try {
        const isM3u8 = targetUrl.includes('.m3u8');

        if (isM3u8) {
            const response = await axios.get(targetUrl, { headers: proxyHeaders });
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
                        // نمرر المرجع (Referer) مرة أخرى مع طلب المفتاح
                        const proxyUri = `${req.protocol}://${req.get('host')}/api/proxy?url=${encodeURIComponent(absoluteUri)}&referer=${encodeURIComponent(refererUrl || '')}`;
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

                // نمرر المرجع (Referer) مرة أخرى لكل مقطع فيديو (TS) أو قائمة جودات
                return `${req.protocol}://${req.get('host')}/api/proxy?url=${encodeURIComponent(absoluteUrlObj.href)}&referer=${encodeURIComponent(refererUrl || '')}`;
            });

            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            return res.send(modifiedLines.join('\n'));

        } else {
            // معالجة مقاطع الـ TS
            const headers = { ...proxyHeaders };
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
        console.error("Proxy Error on:", targetUrl, error.message);
        if (!res.headersSent) res.status(500).send('Error proxying media');
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
