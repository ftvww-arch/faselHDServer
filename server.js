const express = require('express');
const axios = require('axios');
const vm = require('vm');

const app = express();
const PORT = process.env.PORT || 3000;

// السماح بطلبات CORS لجميع المسارات
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
});

// دالة الهيدرز الأساسية (تستخدم للبروكسي)
const getHeaders = (url) => {
    try {
        const urlObj = new URL(url);
        return {
            "Origin": urlObj.origin,
            "Referer": urlObj.href,
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
            "Accept": "*/*",
            "Accept-Language": "en-US,en;q=0.9,ar;q=0.8"
        };
    } catch (e) {
        return {
            "Origin": "https://www.faselhd.club",
            "Referer": "https://www.faselhd.club/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        };
    }
};

// دالة استخراج رابط البث المتطورة (4 طبقات من الفحص)
const extractStreamUrl = async (targetUrl) => {
    // هيدرز قوية للتمويه أثناء طلب صفحة المشغل
    const extractHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Referer": "https://www.faselhd.club/",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1"
    };

    try {
        const response = await axios.get(targetUrl, { headers: extractHeaders });
        const html = response.data;

        // التحقق من حظر السيرفر بواسطة Cloudflare
        if (html.includes('Cloudflare') || html.includes('Just a moment') || html.includes('cf-browser-verification')) {
            throw new Error('السيرفر محظور بواسطة Cloudflare (يحتاج تخطي Captcha).');
        }

        let extractedUrl = null;

        // الطبقة 1: البحث المباشر السريع (إذا لم يكن الرابط مشفراً)
        const directMatch = html.match(/(?:file|src|url)\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i);
        if (directMatch) return directMatch[1];

        // الطبقة 2: بحث عن أي رابط m3u8 صريح داخل الصفحة كحل بديل
        const fallbackMatch = html.match(/(https?:\/\/[a-zA-Z0-9\-\.]+\.[a-zA-Z]{2,}(?:\/\S*)?\.m3u8[^\s"']*)/);
        if (fallbackMatch) return fallbackMatch[1];

        // الطبقة 3: فك التشفير لمشغلات hglamioz / niramirus (تدعم p,a,c,k,e,d أو p,a,c,k,e,r)
        const evalMatch = html.match(/(eval\s*\(\s*function\s*\(p,a,c,k,e,[a-zA-Z0-9_]+\).*?\.split\('\|'\).*?\)\))/);
        if (evalMatch) {
            const chainProxy = new Proxy({}, { get: () => () => chainProxy });
            const sandbox = {
                window: { innerHeight: 100, innerWidth: 100 },
                document: { 
                    getElementById: () => ({}), 
                    createElement: () => ({ setAttribute: ()=>{}, appendChild: ()=>{} }), 
                    body: { appendChild: ()=>{} }, 
                    scripts: [] 
                },
                navigator: { userAgent: "Mozilla/5.0" },
                setTimeout: () => {}, setInterval: () => {}, Math: Math, Date: Date, 
                encodeURIComponent: encodeURIComponent, unescape: unescape, btoa: btoa,
                console: { log: ()=>{}, warn: ()=>{}, error: ()=>{} },
                $: function() { return chainProxy; }
            };
            
            sandbox.$.ajaxSetup = () => {}; 
            sandbox.$.cookie = () => {};

            sandbox.jwplayer = function() {
                const jw = new Proxy({}, {
                    get: (target, prop) => {
                        if (prop === 'setup') {
                            return (config) => {
                                if (config && config.playlist && config.playlist.length > 0) {
                                    extractedUrl = config.playlist[0].file;
                                } else if (config && config.file) {
                                    extractedUrl = config.file;
                                }
                                return jw;
                            };
                        }
                        return () => jw;
                    }
                });
                return jw;
            };

            vm.createContext(sandbox);
            try {
                vm.runInContext(evalMatch[1], sandbox);
            } catch (e) {
                console.error("Eval execution error:", e.message);
            }

            if (extractedUrl) return extractedUrl;
        }

        // الطبقة 4: فك التشفير للسكريبت القديم (إذا كانوا لا يزالون يستخدمونه في بعض السيرفرات)
        const faselMatch = html.match(/(var video = document\.getElementById\('video'\);[\s\S]+?)<\/script>/);
        if (faselMatch) {
            const sandbox = { 
                document: { getElementById: () => ({ canPlayType: () => false, src: '' }) }, 
                window: {}, Hls: { isSupported: () => false }, 
                setInterval: () => {}, setTimeout: () => {}, 
                console: { log: () => {} } 
            };
            sandbox.window = sandbox; sandbox.global = sandbox;
            vm.createContext(sandbox); 
            vm.runInContext(faselMatch[1], sandbox);
            if (sandbox.videoSrc) return sandbox.videoSrc;
        }

        // تسجيل البيانات في حال الفشل للمساعدة في اكتشاف المشكلة
        console.error("لم يتم استخراج الرابط. جزء من محتوى الصفحة لمعرفة السبب:\n", html.substring(0, 500));
        throw new Error('لم يتم العثور على سكريبت المشغل المدعوم أو فشل الاستخراج.');

    } catch (error) {
        throw new Error(error.message);
    }
};

// 1. مسار الاستخراج (إرجاع روابط JSON)
app.get('/api/extract', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: 'يرجى تمرير رابط url صالح.' });

    try {
        const streamUrl = await extractStreamUrl(targetUrl);
        const proxyUrl = `${req.protocol}://${req.get('host')}/api/proxy?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(targetUrl)}`;
        
        return res.json({
            success: true,
            stream_url_direct: streamUrl, 
            proxy_url: proxyUrl 
        });
    } catch (error) {
        return res.status(500).json({ error: 'حدث خطأ', details: error.message });
    }
});

// 2. مسار التشغيل المباشر (استخراج + توجيه فوري للمشغل)
app.get('/api/play', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('URL is required');

    try {
        const streamUrl = await extractStreamUrl(targetUrl);
        const proxyUrl = `/api/proxy?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(targetUrl)}`;
        res.redirect(proxyUrl);
    } catch (error) {
        res.status(500).send(`Error playing media: ${error.message}`);
    }
});

// 3. مسار البروكسي الذكي (يعالج الـ M3U8 والـ TS)
app.get('/api/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    const referer = req.query.referer || targetUrl; 
    if (!targetUrl) return res.status(400).send('URL is required');

    const headers = getHeaders(referer);

    try {
        const isM3u8 = targetUrl.includes('.m3u8') || targetUrl.includes('.txt');

        if (isM3u8) {
            const response = await axios.get(targetUrl, { headers });
            let content = response.data;
            const baseUrl = new URL(targetUrl);
            const lines = content.split('\n');

            const modifiedLines = lines.map(line => {
                line = line.trim();
                if (!line) return line;

                if (line.startsWith('#EXT-X-KEY') && line.includes('URI="')) {
                    return line.replace(/URI="([^"]+)"/, (match, uri) => {
                        const absoluteUri = new URL(uri, baseUrl.href).href;
                        const proxyUri = `${req.protocol}://${req.get('host')}/api/proxy?url=${encodeURIComponent(absoluteUri)}&referer=${encodeURIComponent(referer)}`;
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

                return `${req.protocol}://${req.get('host')}/api/proxy?url=${encodeURIComponent(absoluteUrlObj.href)}&referer=${encodeURIComponent(referer)}`;
            });

            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            return res.send(modifiedLines.join('\n'));

        } else {
            const streamHeaders = { ...headers };
            if (req.headers.range) streamHeaders['Range'] = req.headers.range;

            const response = await axios({
                method: 'get',
                url: targetUrl,
                responseType: 'stream',
                headers: streamHeaders,
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
