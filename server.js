const express = require('express');
const axios = require('axios');
const vm = require('vm');

const app = express();
const PORT = process.env.PORT || 3000;

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
        "Referer": targetUrl, 
        "Origin": originHost
    };

    try {
        const response = await axios.get(targetUrl, { headers: customHeaders });
        const html = response.data;

        // طباعة جزء من رد السيرفر في الكونسول للتأكد من عدم وجود حظر Cloudflare
        console.log("Server Response Check:", html.substring(0, 150));

        // كود بحث محسن يدعم الأسطر المتعددة لاصطياد السكريبت المشفر بالكامل
        const scriptMatch = html.match(/eval\(function\(p,a,c,k,e,d\)[\s\S]*?\.split\('\|'\)\)\)/);
        
        if (!scriptMatch) {
            return res.status(404).json({ 
                error: 'لم يتم العثور على سكريبت المشغل المشفر.',
                is_cloudflare_blocked: html.includes('Cloudflare') || html.includes('Just a moment') || html.includes('challenge-platform')
            });
        }

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
                proxy_url: proxyUrl
            });
        } else {
            return res.status(500).json({ error: 'تم الفك ولكن لم يُعثر على الرابط داخل الإعدادات.' });
        }
    } catch (error) {
        // التقاط أخطاء حظر الخوادم (مثل 403)
        const isCloudflare = error.response && (error.response.status === 403 || error.response.status === 503);
        return res.status(500).json({ 
            error: 'حدث خطأ أثناء محاولة جلب الصفحة', 
            details: error.message,
            is_cloudflare_blocked: isCloudflare
        });
    }
});

// 2. مسار البروكسي الذكي (لدمج الروابط في تطبيق الأندرويد)
app.get('/api/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    const refererUrl = req.query.referer; 

    if (!targetUrl) return res.status(400).send('URL is required');

    res.setHeader('Access-Control-Allow-Origin', '*');

    const proxyHeaders = {
        "User-Agent": DEFAULT_USER_AGENT
    };
    
    if (refererUrl) {
        try {
            const refObj = new URL(refererUrl);
            proxyHeaders["Referer"] = refererUrl;
            proxyHeaders["Origin"] = `${refObj.protocol}//${refObj.host}`;
        } catch (e) {
            // تجاوز في حال كان الرابط غير صالح
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

                // تمرير كل قطعة TS عبر البروكسي مجدداً
                return `${req.protocol}://${req.get('host')}/api/proxy?url=${encodeURIComponent(absoluteUrlObj.href)}&referer=${encodeURIComponent(refererUrl || '')}`;
            });

            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            return res.send(modifiedLines.join('\n'));

        } else {
            // بث مقاطع TS مباشرة للمشغل
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
