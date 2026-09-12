const express = require('express');
const axios = require('axios');
const vm = require('vm');
const { HttpsProxyAgent } = require('https-proxy-agent');

const app = express();
const PORT = process.env.PORT || 3000;

// ضع بيانات البروكسي هنا (IP و Port)
// الصيغة: 'http://ip:port' أو 'http://username:password@ip:port'
const PROXY_URL = 'http://123.45.67.89:8080'; // <-- استبدل هذا ببروكسي حقيقي يعمل
const httpsAgent = new HttpsProxyAgent(PROXY_URL);

// الهيدرز الأساسية التي تخدع السيرفر
const DEFAULT_HEADERS = {
    "Origin": "https://www.fasel-hd.co",
    "Referer": "https://www.fasel-hd.co/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
};

// 1. مسار الاستخراج
app.get('/api/extract', async (req, res) => {
    const targetUrl = req.query.url; 
    if (!targetUrl) return res.status(400).json({ error: 'يرجى تمرير رابط url صالح.' });

    try {
        // تم دمج البروكسي هنا لتجاوز الحظر الجغرافي
        const response = await axios.get(targetUrl, { 
            headers: DEFAULT_HEADERS,
            httpsAgent: httpsAgent 
        });
        const html = response.data;

        const scriptMatch = html.match(/eval\s*\(\s*function\s*\([^)]+\)[\s\S]*?split\(['"]\|['"]\)\)\)/);
        
        if (!scriptMatch) {
            return res.status(404).json({ 
                error: 'لم يتم العثور على سكريبت المشغل المشفر.',
                is_cloudflare_blocked: html.includes('Cloudflare') || html.includes('Just a moment'),
                html_preview: html.substring(0, 300) 
            });
        }

        const packedScript = scriptMatch[0];
        let extractedVideoUrl = null;

        const mockJQuery = new Proxy(function() {}, {
            get: (target, prop) => mockJQuery,
            apply: (target, thisArg, argumentsList) => mockJQuery
        });

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
            const proxyUrl = `${req.protocol}://${req.get('host')}/api/proxy?url=${encodeURIComponent(extractedVideoUrl)}`;
            return res.json({
                success: true,
                stream_url_direct: extractedVideoUrl,
                proxy_url: proxyUrl
            });
        } else {
            return res.status(500).json({ error: 'تم فك التشفير بنجاح ولكن لم يُعثر على رابط البث في الإعدادات.' });
        }
    } catch (error) {
        return res.status(500).json({ 
            error: 'حدث خطأ أثناء محاولة جلب الصفحة عبر البروكسي', 
            details: error.message
        });
    }
});

// 2. مسار البروكسي الذكي
app.get('/api/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('URL is required');

    res.setHeader('Access-Control-Allow-Origin', '*');

    try {
        const isM3u8 = targetUrl.includes('.m3u8');

        if (isM3u8) {
            // استخدام البروكسي لجلب ملفات القوائم
            const response = await axios.get(targetUrl, { 
                headers: DEFAULT_HEADERS,
                httpsAgent: httpsAgent
            });
            let content = response.data;

            const baseUrl = new URL(targetUrl);
            const lines = content.split('\n');

            const modifiedLines = lines.map(line => {
                line = line.trim();
                if (!line) return line;

                if (line.startsWith('#EXT-X-KEY') && line.includes('URI="')) {
                    return line.replace(/URI="([^"]+)"/, (match, uri) => {
                        const absoluteUri = new URL(uri, baseUrl.href).href;
                        const proxyUri = `${req.protocol}://${req.get('host')}/api/proxy?url=${encodeURIComponent(absoluteUri)}`;
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

                return `${req.protocol}://${req.get('host')}/api/proxy?url=${encodeURIComponent(absoluteUrlObj.href)}`;
            });

            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            return res.send(modifiedLines.join('\n'));

        } else {
            // استخدام البروكسي لجلب مقاطع TS المباشرة
            const headers = { ...DEFAULT_HEADERS };
            if (req.headers.range) headers['Range'] = req.headers.range;

            const response = await axios({
                method: 'get',
                url: targetUrl,
                responseType: 'stream',
                headers: headers,
                httpsAgent: httpsAgent,
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
