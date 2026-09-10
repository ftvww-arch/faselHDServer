const express = require('express');
const axios = require('axios');
const vm = require('vm');

const app = express();
const PORT = process.env.PORT || 3000;

// 1. مسار المشغل المباشر الذي يعرض الفيديو ويعمل كبروكسي للبث
app.get('/watch', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('يرجى تمرير رابط url صالح.');

    try {
        // جلب صفحة التوكن من فاصل
        const response = await axios.get(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
                'Referer': 'https://www.fasel-hd.co/'
            }
        });

        const htmlContent = response.data;
        const scriptMatch = htmlContent.match(/(var video = document\.getElementById\('video'\);[\s\S]+?)<\/script>/);
        if (!scriptMatch) return res.status(404).send('لم يتم العثور على سكريبت المشغل.');

        const sandbox = {
            document: { getElementById: () => ({ canPlayType: () => false, src: '' }) },
            window: {},
            Hls: { isSupported: () => false },
            setInterval: () => {}, setTimeout: () => {},
            console: { log: () => {}, warn: () => {}, error: () => {} }
        };
        sandbox.window = sandbox;
        sandbox.global = sandbox;

        vm.createContext(sandbox);
        vm.runInContext(scriptMatch[1], sandbox);

        if (!sandbox.videoSrc) return res.status(500).send('فشل في استخراج الرابط.');

        const originalStreamUrl = sandbox.videoSrc;

        // توجيه رابط البث الأصلي ليحصره البروكسي الخاص بنا
        const proxyStreamUrl = `${req.protocol}://${req.get('host')}/api/proxy?url=${encodeURIComponent(originalStreamUrl)}`;

        // إرجاع صفحة HTML تحتوي على مشغل HLS موجه حصراً عبر البروكسي
        const htmlPage = `
        <!DOCTYPE html>
        <html lang="ar" dir="rtl">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>المشغل المباشر عبر البروكسي</title>
            <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
            <style>
                body, html { margin: 0; padding: 0; width: 100%; height: 100%; background: #000; overflow: hidden; }
                video { width: 100%; height: 100%; }
            </style>
        </head>
        <body>
            <video id="video" controls autoplay playsinline></video>
            <script>
                var videoSrc = "${proxyStreamUrl}";
                var video = document.getElementById('video');
                
                if (video.canPlayType('application/vnd.apple.mpegurl')) {
                    video.src = videoSrc;
                    video.addEventListener('loadedmetadata', function() { video.play(); });
                } else if (Hls.isSupported()) {
                    var hls = new Hls();
                    hls.loadSource(videoSrc);
                    hls.attachMedia(video);
                    hls.on(Hls.Events.MANIFEST_PARSED, function() { video.play(); });
                }
            </script>
        </body>
        </html>
        `;

        res.setHeader('Content-Type', 'text/html');
        return res.send(htmlPage);

    } catch (error) {
        return res.status(500).send('خطأ: ' + error.message);
    }
});

// 2. مسار البروكسي الفعلي: يسحب أجزاء البث ويهندها بالهيدرز لتعمل بدون مشاكل
app.get('/api/proxy', async (req, res) => {
    const streamUrl = req.query.url;
    if (!streamUrl) return res.status(400).send('Missing url');

    try {
        const response = await axios({
            method: 'get',
            url: streamUrl,
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
                'Referer': 'https://www.fasel-hd.co/',
                'Origin': 'https://www.fasel-hd.co'
            }
        });

        // تمرير ترويسات المحتوى الصحيحة (سواء كانت ملف ماني فست أو أجزاء فيديو ts)
        Object.keys(response.headers).forEach(key => {
            res.setHeader(key, response.headers[key]);
        });

        response.data.pipe(res);
    } catch (error) {
        res.status(500).send('Proxy error: ' + error.message);
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
