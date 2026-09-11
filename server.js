const express = require('express');
const axios = require('axios');
const vm = require('vm');

const app = express();
const PORT = process.env.PORT || 3000;

// الهيدرز الأساسية المعتمدة
const DEFAULT_HEADERS = {
    "Origin": "https://www.fasel-hd.co",
    "Referer": "https://www.fasel-hd.co/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
};

// 1. واجهة المستخدم (HTML + JS)
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>مشغل خفيف وسريع</title>
        <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
        <style>
            body { font-family: system-ui, sans-serif; background: #0f172a; color: white; padding: 20px; text-align: center; }
            .container { max-width: 800px; margin: 0 auto; }
            input { width: 70%; padding: 12px; border-radius: 8px; border: 1px solid #334155; background: #1e293b; color: white; margin-bottom: 10px; }
            button { padding: 12px 24px; border-radius: 8px; border: none; background: #e11d48; color: white; font-weight: bold; cursor: pointer; }
            button:hover { background: #be123c; }
            video { width: 100%; border-radius: 8px; margin-top: 20px; background: #000; }
            .info { font-size: 0.85em; color: #94a3b8; margin-top: 10px; }
        </style>
    </head>
    <body>
        <div class="container">
            <h2>مستخرج ومشغل الفيديو (خفيف على السيرفر)</h2>
            <input type="text" id="urlInput" placeholder="ضع رابط صفحة الفيديو هنا...">
            <button onclick="playVideo()">تشغيل</button>
            <div class="info">السيرفر يستخرج فقط الإعدادات، الفيديو يحمل مباشرة من المصدر لتقليل الاستهلاك.</div>
            <video id="video" controls></video>
        </div>

        <script>
            async function playVideo() {
                const url = document.getElementById('urlInput').value;
                if (!url) return alert('يرجى أدخال رابط');

                try {
                    const res = await fetch('/api/extract?url=' + encodeURIComponent(url));
                    const data = await res.json();

                    if (data.success) {
                        const video = document.getElementById('video');
                        const streamUrl = data.proxy_m3u8;

                        if (Hls.isSupported()) {
                            const hls = new Hls();
                            hls.loadSource(streamUrl);
                            hls.attachMedia(video);
                            video.play();
                        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                            video.src = streamUrl;
                            video.play();
                        }
                    } else {
                        alert('خطأ: ' + (data.error || 'فشل الاستخراج'));
                    }
                } catch (err) {
                    alert('حدث خطأ بالاتصال بالسيرفر');
                }
            }
        </script>
    </body>
    </html>
    `);
});

// 2. مسار استخراج الرابط الأساسي
app.get('/api/extract', async (req, res) => {
    const targetUrl = req.query.url;

    if (!targetUrl) return res.status(400).json({ error: 'يرجى تمرير رابط url صالح.' });

    try {
        const response = await axios.get(targetUrl, { headers: DEFAULT_HEADERS });

        const scriptMatch = response.data.match(/(var video = document\.getElementById\('video'\);[\s\S]+?)<\/script>/);
        if (!scriptMatch) return res.status(404).json({ error: 'لم يتم العثور على سكريبت المشغل.' });

        const scriptCode = scriptMatch[1];
        const sandbox = {
            document: { getElementById: () => ({ canPlayType: () => false, src: '' }) },
            window: {}, Hls: { isSupported: () => false },
            setInterval: () => {}, setTimeout: () => {}, console: { log: () => {}, warn: () => {}, error: () => {} }
        };
        sandbox.window = sandbox; sandbox.global = sandbox;
        vm.createContext(sandbox); 
        vm.runInContext(scriptCode, sandbox);

        if (sandbox.videoSrc) {
            // توليد رابط ملف m3u8 المعدل المعالج بالسيرفر
            const proxyM3u8 = `${req.protocol}://${req.get('host')}/api/m3u8?url=${encodeURIComponent(sandbox.videoSrc)}`;
            return res.json({
                success: true,
                proxy_m3u8: proxyM3u8,
                direct_url: sandbox.videoSrc
            });
        } else {
            return res.status(500).json({ error: 'لم يتم العثور على رابط الفيديو داخل الصفحة.' });
        }
    } catch (error) {
        return res.status(500).json({ error: 'حدث خطأ أثناء المعالجة', details: error.message });
    }
});

// 3. مسار معالجة M3U8 فقط (استهلاك لا يتعدى بضعة كيلو بايتات)
app.get('/api/m3u8', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('URL is required');

    res.setHeader('Access-Control-Allow-Origin', '*');

    try {
        // جلب نص ملف m3u8 فقط من المصدر
        const response = await axios.get(targetUrl, { headers: DEFAULT_HEADERS });
        let content = response.data;

        const baseUrl = new URL(targetUrl);
        const lines = content.split('\n');

        // إعادة كتابة الروابط الداخلية لتشير للمصدر المباشر بدلاً من السيرفر الخاص بنا
        const modifiedLines = lines.map(line => {
            line = line.trim();
            if (!line) return line;

            // إذا كان السطر يحوي مفتاح تشفير
            if (line.startsWith('#EXT-X-KEY') && line.includes('URI="')) {
                return line.replace(/URI="([^"]+)"/, (match, uri) => {
                    const absoluteUri = new URL(uri, baseUrl.href).href;
                    return `URI="${absoluteUri}"`;
                });
            }

            // ترك الأوامر الوصفية كما هي
            if (line.startsWith('#')) return line;

            // تحويل مقاطع TS وروابط الجودات الفرعية إلى روابط مباشرة وتوريث التوكنات إن وجدت
            const absoluteUrlObj = new URL(line, baseUrl.href);
            baseUrl.searchParams.forEach((value, key) => {
                if (!absoluteUrlObj.searchParams.has(key)) {
                    absoluteUrlObj.searchParams.set(key, value);
                }
            });

            // السطر الآن يوجه المتصفح مباشرة للتحميل من سيرفر الفيديو الأصلي
            return absoluteUrlObj.href;
        });

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        return res.send(modifiedLines.join('\n'));

    } catch (error) {
        console.error("M3U8 Proxy Error:", error.message);
        if (!res.headersSent) res.status(500).send('Error processing manifest');
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
